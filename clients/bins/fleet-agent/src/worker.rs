//! A bounded background worker for local reads that can block in the kernel.
//!
//! `statvfs` on a hung network or FUSE home, `getpwuid_r` reaching a stuck
//! directory service, or a `stat` of such a home can block for ever, so they
//! never run on the Agent's own loop. A [`Worker`] runs them on one lazily
//! started, detached, named thread, one request at a time, and waits only a
//! short bound for each result. Disk usage, machine information and the
//! `check` command's home lookup each use one.

use std::{
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError},
    time::{Duration, Instant},
};

/// Longest a request waits for its own measurement. A normal call takes
/// microseconds; a slower one is picked up by a later cycle instead.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(2);

/// An unfinished measurement older than this means the worker is stuck.
pub const DEFAULT_STUCK: Duration = Duration::from_secs(60);

/// Pause between checks while waiting for a result.
const WAIT_STEP: Duration = Duration::from_millis(10);

pub type Measurer<T> = Box<dyn Fn() -> Option<T> + Send + 'static>;

/// The thread and its two single-purpose channels. Dropping this lets a
/// worker that ever returns exit; one that never returns is left behind.
struct Link<T> {
    requests: SyncSender<()>,
    results: Receiver<Option<T>>,
}

/// How a worker presents itself: the thread name, what it measures in log
/// messages, and the thread's stack.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    pub thread: &'static str,
    pub what: &'static str,
    pub stack_bytes: usize,
}

/// Runs measurements off the Agent loop. At most one is outstanding, on at most
/// one thread, for the life of the process. If a measurement stays unfinished
/// for `stuck_after` ([`DEFAULT_STUCK`] outside tests), measuring is disabled
/// instead of starting another thread behind it. The thread is detached, so it
/// can never block exit.
pub struct Worker<T> {
    /// Taken by the thread when it starts.
    measurer: Option<Measurer<T>>,
    link: Option<Link<T>>,
    style: Style,
    outstanding: Option<Instant>,
    disabled: bool,
    wait: Duration,
    stuck_after: Duration,
}

impl<T: Send + 'static> Worker<T> {
    /// A worker that starts its thread on the first request. Outside tests,
    /// `wait` is [`DEFAULT_WAIT`] (or a command's own bound) and `stuck_after`
    /// is [`DEFAULT_STUCK`].
    pub fn new(measurer: Measurer<T>, style: Style, wait: Duration, stuck_after: Duration) -> Self {
        Self {
            measurer: Some(measurer),
            link: None,
            style,
            outstanding: None,
            disabled: false,
            wait,
            stuck_after,
        }
    }

    /// True when a new measurement may be requested.
    pub fn is_idle(&self) -> bool {
        !self.disabled && self.outstanding.is_none()
    }

    /// Takes the result of an earlier request without blocking. A request
    /// unfinished after the stuck threshold disables the worker.
    pub fn collect(&mut self, now: Instant) -> Option<T> {
        let since = self.outstanding?;
        match self.link.as_ref()?.results.try_recv() {
            Ok(result) => {
                self.outstanding = None;
                result
            }
            Err(TryRecvError::Empty) => {
                if now.saturating_duration_since(since) >= self.stuck_after {
                    self.disable("a measurement did not finish");
                }
                None
            }
            Err(TryRecvError::Disconnected) => {
                self.disable("the measurement thread stopped");
                None
            }
        }
    }

    /// Requests a measurement, starting the thread on first use, and waits at
    /// most the configured bound for it. `None` means no result yet: it is
    /// picked up by [`Worker::collect`] in a later cycle. Call only when idle.
    pub async fn measure(&mut self, now: Instant) -> Option<T> {
        if !self.is_idle() || !self.request(now) {
            return None;
        }
        let deadline = Instant::now() + self.wait;
        loop {
            let result = self.collect(now);
            if self.outstanding.is_none() {
                return result;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            tokio::time::sleep(left.min(WAIT_STEP)).await;
        }
    }

    fn request(&mut self, now: Instant) -> bool {
        if self.link.is_none() {
            let Some(measurer) = self.measurer.take() else {
                self.disable("the measurement thread could not be started");
                return false;
            };
            let (requests, request_rx) = mpsc::sync_channel::<()>(1);
            let (result_tx, results) = mpsc::channel();
            let started = std::thread::Builder::new()
                .name(self.style.thread.to_owned())
                .stack_size(self.style.stack_bytes)
                .spawn(move || {
                    while request_rx.recv().is_ok() {
                        if result_tx.send(measurer()).is_err() {
                            break;
                        }
                    }
                });
            if let Err(error) = started {
                eprintln!("could not start the {} thread: {error}", self.style.thread);
                self.disable("the measurement thread could not be started");
                return false;
            }
            self.link = Some(Link { requests, results });
        }
        let sent = self
            .link
            .as_ref()
            .is_some_and(|link| link.requests.try_send(()).is_ok());
        if !sent {
            self.disable("the measurement thread stopped");
            return false;
        }
        self.outstanding = Some(now);
        true
    }

    fn disable(&mut self, reason: &str) {
        eprintln!(
            "{} is off until the Agent restarts: {reason}",
            self.style.what
        );
        self.disabled = true;
        self.outstanding = None;
        self.link = None;
    }
}

#[cfg(test)]
mod tests {
    // Bounds are tens of milliseconds so they stay fast.
    use super::*;
    use crate::protocol::{DiskUsageReport, DiskVolume};
    use std::{
        collections::HashSet,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    /// A worker styled like the disk usage one, whose thread name the tests check.
    fn disk_worker(
        measurer: Measurer<DiskUsageReport>,
        wait: Duration,
        stuck_after: Duration,
    ) -> Worker<DiskUsageReport> {
        Worker::new(measurer, crate::disk::STYLE, wait, stuck_after)
    }

    fn report() -> DiskUsageReport {
        DiskUsageReport {
            volumes: vec![DiskVolume {
                label: "home",
                total_bytes: 10,
                used_bytes: 4,
                available_bytes: 6,
            }],
        }
    }

    #[tokio::test]
    async fn the_worker_runs_one_measurement_at_a_time_on_one_thread() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let threads = Arc::new(Mutex::new(HashSet::new()));
        let measurer: Measurer<DiskUsageReport> = {
            let (running, peak, calls, threads) = (
                running.clone(),
                peak.clone(),
                calls.clone(),
                threads.clone(),
            );
            Box::new(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                calls.fetch_add(1, Ordering::SeqCst);
                let thread = std::thread::current();
                assert_eq!(thread.name(), Some("fleet-disk"));
                threads.lock().unwrap().insert(thread.id());
                std::thread::sleep(Duration::from_millis(5));
                running.fetch_sub(1, Ordering::SeqCst);
                Some(report())
            })
        };
        let mut worker = disk_worker(measurer, Duration::from_secs(5), Duration::from_secs(60));
        for _ in 0..10 {
            assert!(worker.is_idle());
            assert_eq!(worker.measure(Instant::now()).await, Some(report()));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(threads.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_outstanding_request_is_never_doubled() {
        let (release, blocked) = mpsc::channel::<()>();
        let calls = Arc::new(AtomicUsize::new(0));
        let measurer: Measurer<DiskUsageReport> = {
            let calls = calls.clone();
            let blocked = Mutex::new(blocked);
            Box::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let _ = blocked.lock().unwrap().recv();
                Some(report())
            })
        };
        let mut worker = disk_worker(measurer, Duration::from_millis(30), Duration::from_secs(60));
        let start = Instant::now();
        assert_eq!(worker.measure(start).await, None);
        assert!(!worker.is_idle());
        assert_eq!(worker.measure(start).await, None);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // The late result is handed over by a later cycle.
        release.send(()).unwrap();
        let mut late = None;
        for _ in 0..200 {
            late = worker.collect(start);
            if late.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(late, Some(report()));
        assert!(worker.is_idle());
    }

    #[tokio::test]
    async fn a_stuck_measurement_is_bounded_and_disables_the_worker() {
        let (release, blocked) = mpsc::channel::<()>();
        let calls = Arc::new(AtomicUsize::new(0));
        let threads = Arc::new(Mutex::new(HashSet::new()));
        let measurer: Measurer<DiskUsageReport> = {
            let (calls, threads) = (calls.clone(), threads.clone());
            let blocked = Mutex::new(blocked);
            Box::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                threads.lock().unwrap().insert(std::thread::current().id());
                let _ = blocked.lock().unwrap().recv();
                Some(report())
            })
        };
        let stuck_after = Duration::from_millis(100);
        let mut worker = disk_worker(measurer, Duration::from_millis(30), stuck_after);
        let start = Instant::now();
        let began = Instant::now();
        assert_eq!(worker.measure(start).await, None);
        assert!(began.elapsed() < Duration::from_secs(2), "bounded wait");

        // Not stuck yet: still outstanding, nothing else is started.
        assert_eq!(worker.collect(start + stuck_after / 2), None);
        assert!(!worker.is_idle());

        // Stuck: disabled for good, and no further request starts a thread.
        assert_eq!(worker.collect(start + stuck_after), None);
        assert!(!worker.is_idle());
        for _ in 0..3 {
            assert_eq!(worker.measure(start + stuck_after).await, None);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(threads.lock().unwrap().len(), 1);
        drop(release);
    }

    #[tokio::test]
    async fn a_panicking_measurement_disables_the_worker() {
        let measurer: Measurer<DiskUsageReport> = Box::new(|| panic!("measurement failed"));
        let mut worker = disk_worker(measurer, Duration::from_secs(5), Duration::from_secs(60));
        assert_eq!(worker.measure(Instant::now()).await, None);
        assert!(!worker.is_idle());
    }
}
