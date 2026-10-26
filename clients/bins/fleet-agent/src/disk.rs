//! Disk usage of the volumes the Agent writes to.
//!
//! A measurement is a single `statvfs` (Linux) or `statfs` (macOS) call per
//! volume. It never walks directories or starts a process, and a failure only
//! means the volume is left out of the report.
//!
//! Those calls can block for ever in the kernel on a hung network or FUSE
//! home, so they never run on the Agent's own loop. A [`Worker`] runs them on
//! one lazily started, detached thread, one request at a time.

use std::{
    io,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError},
    time::{Duration, Instant},
};

use crate::protocol::{DiskUsageReport, DiskVolume};

/// Time between scheduled reports, counted from the last attempt.
pub const REPORT_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

/// Longest a request waits for its own measurement. A normal call takes
/// microseconds; a slower one is picked up by a later cycle instead.
const MEASURE_WAIT: Duration = Duration::from_secs(2);

/// An unfinished measurement older than this means the worker is stuck.
const STUCK_AFTER: Duration = Duration::from_secs(60);

/// Pause between checks while waiting for a result.
const WAIT_STEP: Duration = Duration::from_millis(10);

/// Stack of the measurement thread: it only calls `statvfs` and `eprintln`.
const WORKER_STACK_BYTES: usize = 256 * 1024;

/// Block counts of one filesystem, as the operating system reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counts {
    /// Size in bytes of one block that the other counts are measured in.
    block_size: u64,
    blocks: u64,
    free_blocks: u64,
    available_blocks: u64,
}

/// Measures the volume holding `home` and, if the Agent state directory is on
/// another device, that volume too. Returns `None` when nothing was measured.
pub fn measure(home: &Path, state: &Path) -> Option<DiskUsageReport> {
    let mut volumes = Vec::with_capacity(2);
    volumes.extend(measure_volume("home", home));
    if different_device(home, state) {
        volumes.extend(measure_volume("state", state));
    }
    (!volumes.is_empty()).then_some(DiskUsageReport { volumes })
}

fn measure_volume(label: &'static str, path: &Path) -> Option<DiskVolume> {
    let counts = match counts(path) {
        Ok(counts) => counts,
        Err(error) => {
            eprintln!("could not measure disk usage of the {label} volume: {error}");
            return None;
        }
    };
    volume(label, counts)
}

/// True unless both paths are known to be on the same device.
fn different_device(home: &Path, state: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(home), std::fs::metadata(state)) {
            (Ok(home), Ok(state)) => home.dev() != state.dev(),
            (Err(_), Ok(_)) => true,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (home, state);
        false
    }
}

/// Converts block counts to bytes. Arithmetic is exact in 128 bits and then
/// clamped, so no value wraps and `used + available <= total` always holds.
/// Filesystems without blocks (some virtual ones) are skipped.
fn volume(label: &'static str, counts: Counts) -> Option<DiskVolume> {
    if counts.blocks == 0 || counts.block_size == 0 {
        return None;
    }
    let free = counts.free_blocks.min(counts.blocks);
    let available = counts.available_blocks.min(free);
    let bytes = |blocks: u64| {
        u64::try_from(u128::from(blocks) * u128::from(counts.block_size)).unwrap_or(u64::MAX)
    };
    let total = bytes(counts.blocks);
    let used = bytes(counts.blocks - free).min(total);
    let available = bytes(available).min(total - used);
    Some(DiskVolume {
        label,
        total_bytes: total,
        used_bytes: used,
        available_bytes: available,
    })
}

#[cfg(target_os = "linux")]
fn counts(path: &Path) -> io::Result<Counts> {
    let path = c_path(path)?;
    // SAFETY: `path` is a NUL-terminated string that outlives the call, and
    // `stat` is a zeroed `statvfs` (valid for all-zero bytes) that the call
    // fills in through a pointer that is valid for the whole call.
    let (code, stat) = unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        (libc::statvfs(path.as_ptr(), &mut stat), stat)
    };
    if code != 0 {
        return Err(io::Error::last_os_error());
    }
    // The field types differ between targets (u32 or u64), hence the casts.
    #[allow(clippy::unnecessary_cast)]
    Ok(Counts {
        block_size: stat.f_frsize as u64,
        blocks: stat.f_blocks as u64,
        free_blocks: stat.f_bfree as u64,
        available_blocks: stat.f_bavail as u64,
    })
}

/// macOS uses `statfs`: its block counts are 64-bit, while `statvfs` there
/// truncates them to 32 bits and would misreport large volumes.
#[cfg(target_os = "macos")]
fn counts(path: &Path) -> io::Result<Counts> {
    let path = c_path(path)?;
    // SAFETY: as for `statvfs` above, with a zeroed `statfs`.
    let (code, stat) = unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        (libc::statfs(path.as_ptr(), &mut stat), stat)
    };
    if code != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Counts {
        block_size: u64::from(stat.f_bsize),
        blocks: stat.f_blocks,
        free_blocks: stat.f_bfree,
        available_blocks: stat.f_bavail,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn counts(_path: &Path) -> io::Result<Counts> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

pub type Measurer = Box<dyn Fn() -> Option<DiskUsageReport> + Send + 'static>;

/// The thread and its two single-purpose channels. Dropping this lets a
/// worker that ever returns exit; one that never returns is left behind.
struct Link {
    requests: SyncSender<()>,
    results: Receiver<Option<DiskUsageReport>>,
}

/// Runs measurements off the Agent loop. At most one is outstanding, on at most
/// one thread, for the life of the process. If a measurement stays unfinished
/// for [`STUCK_AFTER`], measuring is disabled instead of starting another
/// thread behind it. The thread is detached, so it can never block exit.
pub struct Worker {
    /// Taken by the thread when it starts.
    measurer: Option<Measurer>,
    link: Option<Link>,
    outstanding: Option<Instant>,
    disabled: bool,
    wait: Duration,
    stuck_after: Duration,
}

impl Worker {
    pub fn new(home: PathBuf, state: PathBuf) -> Self {
        Self::with_measurer(
            Box::new(move || measure(&home, &state)),
            MEASURE_WAIT,
            STUCK_AFTER,
        )
    }

    pub fn with_measurer(measurer: Measurer, wait: Duration, stuck_after: Duration) -> Self {
        Self {
            measurer: Some(measurer),
            link: None,
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
    pub fn collect(&mut self, now: Instant) -> Option<DiskUsageReport> {
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
    pub async fn measure(&mut self, now: Instant) -> Option<DiskUsageReport> {
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
                .name("fleet-disk".to_owned())
                .stack_size(WORKER_STACK_BYTES)
                .spawn(move || {
                    while request_rx.recv().is_ok() {
                        if result_tx.send(measurer()).is_err() {
                            break;
                        }
                    }
                });
            if let Err(error) = started {
                eprintln!("could not start the disk usage thread: {error}");
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
        eprintln!("disk usage measurement is off until the Agent restarts: {reason}");
        self.disabled = true;
        self.outstanding = None;
        self.link = None;
    }
}

/// When to report, kept in memory only. Every method takes the current
/// monotonic time so the schedule can be tested without waiting.
#[derive(Debug, Default)]
pub struct Schedule {
    polled: bool,
    /// The last successful poll asked for a report.
    asked: bool,
    /// A new request was seen and no attempt has been made since.
    requested: bool,
    last_attempt: Option<Instant>,
}

impl Schedule {
    /// A poll succeeded. `requested` is the Server's `diskUsageRequested`.
    /// The Server keeps asking until a report is stored, so only the start of
    /// a run of `true` counts: after a failed attempt the next try is the
    /// 4-hour slot, or a request that follows a `false`.
    pub fn poll_succeeded(&mut self, requested: bool) {
        self.polled = true;
        self.requested |= requested && !self.asked;
        self.asked = requested;
    }

    /// Due after the first successful poll, after [`REPORT_INTERVAL`] since the
    /// last attempt, and when the Server asked.
    pub fn is_due(&self, now: Instant) -> bool {
        self.polled
            && (self.requested
                || self
                    .last_attempt
                    .is_none_or(|last| now.saturating_duration_since(last) >= REPORT_INTERVAL))
    }

    /// Records an attempt, successful or not: a failure waits for the next
    /// slot or the next request.
    pub fn attempted(&mut self, now: Instant) {
        self.last_attempt = Some(now);
        self.requested = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    fn counts(block_size: u64, blocks: u64, free_blocks: u64, available_blocks: u64) -> Counts {
        Counts {
            block_size,
            blocks,
            free_blocks,
            available_blocks,
        }
    }

    #[test]
    fn used_is_blocks_minus_free_times_fragment_size() {
        let v = volume("home", counts(4096, 1000, 400, 300)).unwrap();
        assert_eq!(v.label, "home");
        assert_eq!(v.total_bytes, 1000 * 4096);
        assert_eq!(v.used_bytes, 600 * 4096);
        assert_eq!(v.available_bytes, 300 * 4096);
    }

    #[test]
    fn reserved_blocks_count_as_used_not_available() {
        // Free 400 but only 100 available to the user: 500 + 100 < 1000.
        let v = volume("home", counts(512, 1000, 400, 100)).unwrap();
        assert_eq!(v.used_bytes, 600 * 512);
        assert_eq!(v.available_bytes, 100 * 512);
        assert!(v.used_bytes + v.available_bytes <= v.total_bytes);
    }

    #[test]
    fn large_volumes_do_not_truncate() {
        // 8 EiB-ish: block counts beyond 32 bits and a product beyond 2^53.
        let v = volume("home", counts(4096, 1 << 40, 1 << 39, 1 << 38)).unwrap();
        assert_eq!(v.total_bytes, 4096u64 << 40);
        assert_eq!(v.used_bytes, 4096u64 << 39);
        assert_eq!(v.available_bytes, 4096u64 << 38);
        assert_eq!(v.total_bytes / GIB, 4096 * (1 << 10));
    }

    #[test]
    fn overflow_saturates_and_keeps_the_invariant() {
        let v = volume("home", counts(u64::MAX, u64::MAX, 1, 1)).unwrap();
        assert_eq!(v.total_bytes, u64::MAX);
        assert_eq!(v.used_bytes, u64::MAX);
        assert_eq!(v.available_bytes, 0);

        let v = volume("home", counts(1 << 32, 1 << 33, 1 << 32, 1 << 32)).unwrap();
        assert_eq!(v.total_bytes, u64::MAX);
        assert!(v.used_bytes.checked_add(v.available_bytes).is_some());
        assert!(v.used_bytes + v.available_bytes <= v.total_bytes);
    }

    #[test]
    fn inconsistent_counts_never_break_used_plus_available_le_total() {
        let samples = [
            counts(4096, 100, 200, 300), // free > blocks
            counts(4096, 100, 50, 80),   // available > free
            counts(1, u64::MAX, 0, u64::MAX),
            counts(u64::MAX, 1, 1, 1),
            counts(7, u64::MAX, u64::MAX, u64::MAX),
        ];
        for sample in samples {
            let v = volume("home", sample).unwrap();
            assert!(v.used_bytes <= v.total_bytes, "{sample:?}");
            assert!(
                v.used_bytes
                    .checked_add(v.available_bytes)
                    .is_some_and(|sum| sum <= v.total_bytes),
                "{sample:?}"
            );
        }
    }

    #[test]
    fn zero_size_filesystems_are_skipped() {
        assert!(volume("home", counts(4096, 0, 0, 0)).is_none());
        assert!(volume("home", counts(0, 100, 50, 50)).is_none());
    }

    #[test]
    fn schedule_waits_for_the_first_successful_poll() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        assert!(!schedule.is_due(start));
        assert!(!schedule.is_due(start + REPORT_INTERVAL * 2));
        schedule.poll_succeeded(false);
        assert!(schedule.is_due(start));
    }

    #[test]
    fn schedule_reports_every_four_hours_after_the_last_attempt() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        schedule.attempted(start);
        schedule.poll_succeeded(false);
        assert!(!schedule.is_due(start));
        assert!(!schedule.is_due(start + REPORT_INTERVAL - Duration::from_secs(1)));
        assert!(schedule.is_due(start + REPORT_INTERVAL));

        let second = start + REPORT_INTERVAL;
        schedule.attempted(second);
        assert!(!schedule.is_due(second + REPORT_INTERVAL - Duration::from_secs(1)));
        assert!(schedule.is_due(second + REPORT_INTERVAL));
    }

    #[test]
    fn schedule_reports_when_the_server_asks_and_clears_the_request() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        schedule.attempted(start);
        let soon = start + Duration::from_secs(30);
        assert!(!schedule.is_due(soon));
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(soon));
        schedule.attempted(soon);
        schedule.poll_succeeded(false);
        assert!(!schedule.is_due(soon + Duration::from_secs(30)));
    }

    #[test]
    fn a_failed_attempt_waits_for_the_next_slot_or_request() {
        // `attempted` is recorded before the outcome is known, so a failure
        // looks the same as a success to the schedule.
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        assert!(schedule.is_due(start));
        schedule.attempted(start);
        for seconds in [5, 30, 600, 3600] {
            schedule.poll_succeeded(false);
            assert!(!schedule.is_due(start + Duration::from_secs(seconds)));
        }
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(start + Duration::from_secs(60)));
        schedule.attempted(start + Duration::from_secs(60));
        assert!(schedule.is_due(start + Duration::from_secs(60) + REPORT_INTERVAL));
    }

    #[test]
    fn a_continuous_run_of_requests_is_consumed_once() {
        // The Server keeps `diskUsageRequested` set until a report is stored,
        // so after a failed attempt every poll still says `true`.
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        schedule.attempted(start);
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(start + Duration::from_secs(30)));
        schedule.attempted(start + Duration::from_secs(30));
        for seconds in [60, 90, 120, 3600] {
            schedule.poll_succeeded(true);
            assert!(!schedule.is_due(start + Duration::from_secs(seconds)));
        }
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(start + Duration::from_secs(30) + REPORT_INTERVAL));
    }

    #[test]
    fn a_request_after_a_false_poll_triggers_again() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(true);
        schedule.attempted(start);
        schedule.poll_succeeded(true);
        assert!(!schedule.is_due(start + Duration::from_secs(30)));
        schedule.poll_succeeded(false);
        assert!(!schedule.is_due(start + Duration::from_secs(60)));
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(start + Duration::from_secs(90)));
    }

    #[test]
    fn a_request_seen_while_busy_stays_pending_until_attempted() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        schedule.attempted(start);
        schedule.poll_succeeded(true);
        schedule.poll_succeeded(true);
        assert!(schedule.is_due(start + Duration::from_secs(60)));
    }

    // Worker tests. Bounds are tens of milliseconds so they stay fast.
    use std::{
        collections::HashSet,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

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
        let measurer: Measurer = {
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
        let mut worker =
            Worker::with_measurer(measurer, Duration::from_secs(5), Duration::from_secs(60));
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
        let measurer: Measurer = {
            let calls = calls.clone();
            let blocked = Mutex::new(blocked);
            Box::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let _ = blocked.lock().unwrap().recv();
                Some(report())
            })
        };
        let mut worker =
            Worker::with_measurer(measurer, Duration::from_millis(30), Duration::from_secs(60));
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
        let measurer: Measurer = {
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
        let mut worker = Worker::with_measurer(measurer, Duration::from_millis(30), stuck_after);
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
        let measurer: Measurer = Box::new(|| panic!("measurement failed"));
        let mut worker =
            Worker::with_measurer(measurer, Duration::from_secs(5), Duration::from_secs(60));
        assert_eq!(worker.measure(Instant::now()).await, None);
        assert!(!worker.is_idle());
    }

    #[cfg(unix)]
    #[test]
    fn measures_the_real_home_directory() {
        let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let state = std::env::temp_dir();
        let report = measure(&home, &state).expect("home volume is measurable");
        let home_volume = &report.volumes[0];
        assert_eq!(home_volume.label, "home");
        assert!(home_volume.total_bytes > 0);
        assert!(home_volume.used_bytes <= home_volume.total_bytes);
        assert!(home_volume.used_bytes + home_volume.available_bytes <= home_volume.total_bytes);
        assert!(report.volumes.len() <= 2);
        assert!(report.volumes.iter().all(|v| v.label != "state") || report.volumes.len() == 2);
    }

    #[cfg(unix)]
    #[test]
    fn same_device_state_directory_is_not_reported_twice() {
        let dir = std::env::temp_dir();
        let report = measure(&dir, &dir.join("does-not-exist")).unwrap();
        assert_eq!(report.volumes.len(), 1);
        assert_eq!(report.volumes[0].label, "home");
    }

    #[cfg(unix)]
    #[test]
    fn unmeasurable_volumes_are_skipped() {
        let missing = Path::new("/definitely/not/a/real/path");
        assert!(measure(missing, missing).is_none());
        let state_only = measure(missing, &std::env::temp_dir()).unwrap();
        assert_eq!(state_only.volumes.len(), 1);
        assert_eq!(state_only.volumes[0].label, "state");
    }
}
