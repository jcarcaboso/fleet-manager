//! Disk usage of the volumes the Agent writes to.
//!
//! A measurement is a single `statvfs` (Linux) or `statfs` (macOS) call per
//! volume. It never walks directories or starts a process, and a failure only
//! means the volume is left out of the report.
//!
//! Those calls can block for ever in the kernel on a hung network or FUSE
//! home, so they never run on the Agent's own loop but on a
//! [`Worker`](crate::worker::Worker) thread.

use std::{
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use crate::{
    protocol::{Api, DiskUsageReport, DiskVolume},
    worker::{DEFAULT_STUCK, DEFAULT_WAIT, Style, Worker},
};

/// Time between scheduled reports, counted from the last attempt.
pub const REPORT_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

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
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(home), std::fs::metadata(state)) {
        (Ok(home), Ok(state)) => home.dev() != state.dev(),
        (Err(_), Ok(_)) => true,
        _ => false,
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

/// The disk usage worker's thread. It only calls `statvfs` and `eprintln`, so
/// it gets a small stack.
pub const STYLE: Style = Style {
    thread: "fleet-disk",
    what: "disk usage measurement",
    stack_bytes: WORKER_STACK_BYTES,
};

/// The disk usage worker of the Agent loop and the `disk` command.
pub fn worker(home: PathBuf, state: PathBuf) -> Worker<DiskUsageReport> {
    Worker::new(
        Box::new(move || measure(&home, &state)),
        STYLE,
        DEFAULT_WAIT,
        DEFAULT_STUCK,
    )
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

/// One cycle's disk work. The measurement runs on the [`Worker`] thread
/// and the report is a side task, so neither can delay the next poll beyond
/// the worker's short bounded wait. At most one report is in flight; a report
/// that finds another still running is dropped, and the schedule tries again
/// at the next slot or request.
pub async fn step<F, Fut>(
    schedule: &mut Schedule,
    worker: &mut Worker<DiskUsageReport>,
    in_flight: &mut Option<tokio::task::JoinHandle<()>>,
    send: F,
) where
    F: FnOnce(DiskUsageReport) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let now = Instant::now();
    // A measurement requested in an earlier cycle may have finished since.
    let mut report = worker.collect(now);
    if report.is_none() && worker.is_idle() && schedule.is_due(now) {
        schedule.attempted(now);
        report = worker.measure(now).await;
    }
    let Some(report) = report else {
        return;
    };
    if in_flight.as_ref().is_some_and(|task| !task.is_finished()) {
        eprintln!("skipped a disk usage report: the previous one is still being sent");
        return;
    }
    *in_flight = Some(tokio::spawn(send(report)));
}

/// Sends one report. Like attempt detail it is best effort: a failure is
/// logged, and the schedule has already recorded the attempt, so it waits for
/// the next slot or the next Server request instead of being retried.
pub async fn deliver(client: &Api, report: &DiskUsageReport) {
    if let Err(error) = client.disk_usage(report).await {
        eprintln!("could not send disk usage; will retry later: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{state, test_support::MockServer};
    use std::fs;
    use uuid::Uuid;

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

    #[test]
    fn same_device_state_directory_is_not_reported_twice() {
        let dir = std::env::temp_dir();
        let report = measure(&dir, &dir.join("does-not-exist")).unwrap();
        assert_eq!(report.volumes.len(), 1);
        assert_eq!(report.volumes[0].label, "home");
    }

    #[test]
    fn unmeasurable_volumes_are_skipped() {
        let missing = Path::new("/definitely/not/a/real/path");
        assert!(measure(missing, missing).is_none());
        let state_only = measure(missing, &std::env::temp_dir()).unwrap();
        assert_eq!(state_only.volumes.len(), 1);
        assert_eq!(state_only.volumes[0].label, "state");
    }

    // One cycle's disk work, as the Agent loop runs it.
    fn test_directory() -> PathBuf {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-main-{}", Uuid::new_v4()));
        state::private_directory(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn disk_usage_is_sent_best_effort_and_never_retried_in_a_loop() {
        let directory = test_directory();
        let server = MockServer::start(vec![(404, ""), (204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let report = measure(&directory, &directory).expect("measurable");

        // An older Server answers 404: logged, nothing returned, one request.
        deliver(&client, &report).await;
        assert_eq!(server.requests().len(), 1);
        deliver(&client, &report).await;

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(
            requests
                .iter()
                .all(|r| r.method == "PUT" && r.path == "/agent/v1/disk-usage")
        );
        let body: serde_json::Value = serde_json::from_str(&requests[1].body).unwrap();
        let volumes = body["volumes"].as_array().unwrap();
        assert_eq!(volumes.len(), 1, "state directory shares the home device");
        assert_eq!(volumes[0]["label"], "home");
        assert!(volumes[0]["totalBytes"].as_u64().unwrap() > 0);
        fs::remove_dir_all(directory).unwrap();
    }

    fn sample_disk_report() -> DiskUsageReport {
        DiskUsageReport {
            volumes: vec![DiskVolume {
                label: "home",
                total_bytes: 10,
                used_bytes: 4,
                available_bytes: 6,
            }],
        }
    }

    fn fake_worker(
        measure: impl Fn() -> Option<DiskUsageReport> + Send + 'static,
    ) -> Worker<DiskUsageReport> {
        Worker::new(
            Box::new(measure),
            STYLE,
            Duration::from_secs(5),
            Duration::from_secs(60),
        )
    }

    #[tokio::test]
    async fn the_report_is_a_side_task_and_one_is_in_flight_at_most() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let sent = std::sync::Arc::new(AtomicUsize::new(0));
        let mut schedule = Schedule::default();
        let mut worker = fake_worker(|| Some(sample_disk_report()));
        let mut in_flight = None;
        let slow_send = |sent: std::sync::Arc<AtomicUsize>| {
            move |_report: DiskUsageReport| async move {
                sent.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        };

        // Not due before the first successful poll: nothing happens.
        step(
            &mut schedule,
            &mut worker,
            &mut in_flight,
            slow_send(sent.clone()),
        )
        .await;
        assert!(in_flight.is_none());

        // Due: the cycle returns while the 30 s send is still running.
        schedule.poll_succeeded(false);
        let began = Instant::now();
        step(
            &mut schedule,
            &mut worker,
            &mut in_flight,
            slow_send(sent.clone()),
        )
        .await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(in_flight.as_ref().is_some_and(|task| !task.is_finished()));
        tokio::task::yield_now().await;
        assert_eq!(sent.load(Ordering::SeqCst), 1);

        // Asked again while that report is still being sent: dropped.
        schedule.poll_succeeded(true);
        step(
            &mut schedule,
            &mut worker,
            &mut in_flight,
            slow_send(sent.clone()),
        )
        .await;
        tokio::task::yield_now().await;
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        in_flight.take().unwrap().abort();
    }

    #[tokio::test]
    async fn nothing_is_sent_when_no_volume_can_be_measured() {
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        let mut worker = fake_worker(|| None);
        let mut in_flight = None;
        step(&mut schedule, &mut worker, &mut in_flight, |_| async {
            panic!("no report to send");
        })
        .await;
        assert!(in_flight.is_none());
        // The attempt counts: no new try before the next slot.
        assert!(!schedule.is_due(Instant::now()));
    }

    #[tokio::test]
    async fn a_stuck_measurement_never_stalls_the_cycle() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let blocked = std::sync::Mutex::new(blocked);
        let mut schedule = Schedule::default();
        schedule.poll_succeeded(false);
        let mut worker = Worker::new(
            Box::new(move || {
                let _ = blocked.lock().unwrap().recv();
                None
            }),
            STYLE,
            Duration::from_millis(30),
            Duration::from_millis(60),
        );
        let mut in_flight = None;
        let began = Instant::now();
        step(&mut schedule, &mut worker, &mut in_flight, |_| async {
            panic!("no report to send");
        })
        .await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(!worker.is_idle());
        assert!(in_flight.is_none());
        drop(release);
    }
}
