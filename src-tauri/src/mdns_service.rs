// Tide DC-21 §3.1/§3.2/§5: mDNS browse service in the Rust shell.
//
// Runs the DC-11 mdns-sd browser CONTINUOUSLY while the app is active and
// forwards each browse transition to the sidecar as an `mdns_event`
// notification over the existing stdio NDJSON channel. The sidecar owns the
// ONE endpoint cache (DC-21 §3.2/D2); this module never keeps peer state and
// never touches trust (D3: hints only).
//
// Failure behavior (DC-21 §6.1/D9): any mdns error degrades to a logged
// warning; the sidecar falls back to last-known endpoints only. The `mdns`
// cargo feature stays opt-in for dev builds (§8).

use std::sync::{Arc, Mutex};
#[cfg(feature = "mdns")]
use std::time::Duration;


/// One browse transition, forwarded verbatim as an mdns_event notification.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MdnsEvent {
    pub kind: String, // "added" | "removed"
    pub instance_name: String,
    pub host: String,
    pub port: u16,
    pub interface: String,
    pub observed_at: u64,
    pub ttl_ms: u64,
}

/// Sidecar channel + snapshot callback contract for the browse service.
/// (Feature-less dev builds don't construct any sink — dead-code allowed.)
#[cfg_attr(not(feature = "mdns"), allow(dead_code))]
pub trait EventSink: Send + Sync {
    /// Fire-and-forget push of one browse event to the sidecar.
    fn push_event(&self, event: MdnsEvent);
    /// True while the sidecar is alive (a dead pipe means stop pushing).
    fn sidecar_alive(&self) -> bool;
    /// DC-21 §3.2(b): record an observation into the pending snapshot buffer
    /// (drained to the sidecar when it reports readiness). Default no-op for
    /// sinks that don't track snapshots.
    fn record_observation(&self, _event: MdnsEvent) {}
}

/// The concrete platform adapter (TideMdns from the tide_discovery module in
/// the binary crate). Type alias keeps this lib free of a direct dependency
/// on the binary-only module.
#[cfg(feature = "mdns")]
pub type MdnsAdapterImpl = crate::tide_discovery::TideMdns;

/// DC-21 §3.2(b): the SidecarEventSink records browse observations into the
/// BrowseService's snapshot buffer (via record_observation) so the snapshot
/// can be pushed to a freshly (re)started sidecar. push_event routes to the
/// sidecar's mdns_event notification path.
pub struct PingSink {
    pub sc: Arc<crate::sidecar::Sidecar>,
}

impl EventSink for PingSink {
    fn push_event(&self, event: MdnsEvent) {
        if let Err(e) = self.sc.notify_mdns_event(
            &event.kind,
            &event.instance_name,
            &event.host,
            event.port,
            event.observed_at,
            event.ttl_ms,
        ) {
            log::debug!("mdns_snapshot push skipped: {e}");
        }
    }
    fn sidecar_alive(&self) -> bool {
        self.sc.is_alive()
    }
}

/// DC-21 §3.4: mDNS registration holder. The ServiceDaemon inside TideMdns
/// MUST outlive the register() call — probing, announcing, and query
/// answering all run on its background thread (bug #1b: a function-local
/// daemon was dropped on return and the service never became visible).
/// Owned by Tauri managed state so it lives as long as the app.
#[cfg(feature = "mdns")]
pub struct RegistrationService {
    inner: Mutex<Option<crate::mdns_service::MdnsAdapterImpl>>,
}

#[cfg(feature = "mdns")]
impl RegistrationService {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Register (or re-register) the tide-sync service. Creates the adapter
    /// lazily on first use and REUSES it afterwards — one daemon for the
    /// whole app lifetime. Idempotent-friendly: mdns-sd re-registering the
    /// same fullname updates the existing service (§5.3 re-register path).
    pub fn register(
        &self,
        instance_name: &str,
        port: u16,
        txt: &std::collections::HashMap<String, String>,
        host_label: &str,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|_| "mdns registration lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(crate::mdns_service::MdnsAdapterImpl::new()?);
        }
        guard
            .as_ref()
            .expect("just initialized")
            .register(instance_name, port, txt, host_label)
    }
}

#[cfg(all(feature = "mdns", test))]
impl Default for RegistrationService {
    fn default() -> Self {
        Self::new()
    }
}

// pkg10-fixup: in the default (feature-less) dev build the browse-loop
// machinery is compiled out; silence the resulting dead-code warnings instead
// of leaving noise in every `npx tauri dev` run. The fields ARE used by the
// feature build.
#[cfg_attr(not(feature = "mdns"), allow(dead_code))]
pub struct BrowseService {
    inner: Mutex<Option<BrowseLoop>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// DC-21 §3.2(b): current observed endpoints (instance_name -> event),
    /// maintained by the browse loop; drained as one mdns_snapshot
    /// notification when the sidecar reports readiness.
    snapshot: Arc<Mutex<Vec<MdnsEvent>>>,
    /// DC-11 Appendix A (owner 2026-11-14): "ask again when it matters".
    /// Set by `kick()`; the browse loop consumes it (rate-limited).
    kick: Arc<std::sync::atomic::AtomicBool>,
}

#[cfg_attr(feature = "mdns", allow(dead_code))]
#[allow(dead_code)]
struct BrowseLoop {
    /// Kept for join-on-stop; only read by stop() (which is only invoked from
    /// quit paths not yet wired — see stop() below).
    handle: std::thread::JoinHandle<()>,
}

impl BrowseService {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            snapshot: Arc::new(Mutex::new(Vec::new())),
            kick: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// DC-11 A.2: request a fresh query round now (Sync now pressed, or a
    /// paired peer could not be reached). Non-blocking; the loop honours at
    /// most one kick per `KICK_MIN_INTERVAL` and ignores the rest.
    pub fn kick(&self) {
        self.kick.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// DC-21 §5.1: start continuous browsing. Order-independent — safe to
    /// call before the sidecar registers its mdns_event handler (early
    /// events are simply dropped by a not-yet-ready sidecar, and the sidecar
    /// pulls mdns_snapshot at startup to converge without ordering rules).
    /// `mdns` is the platform adapter (TideMdns from main.rs's
    /// tide_discovery module — dependency-injected since that module lives in
    /// the binary crate, not this lib).
    #[cfg(feature = "mdns")]
    pub fn start(
        &self,
        sink: Arc<dyn EventSink>,
        mdns: crate::mdns_service::MdnsAdapterImpl,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|_| "browse lock poisoned")?;
        if guard.is_some() {
            return Ok(()); // already running (idempotent, D8)
        }
        self.stop
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let stop = Arc::clone(&self.stop);
        let kick = Arc::clone(&self.kick);
        let handle = std::thread::Builder::new()
            .name("tide-mdns-browse".into())
            .spawn(move || {
                run_browse_loop(sink, stop, kick, mdns, REFRESH_EVERY, RESTART_BACKOFF, KICK_MIN_INTERVAL, KICK_CONFIRM_WINDOW);
            })
            .map_err(|e| format!("spawn mdns browse thread: {e}"))?;
        *guard = Some(BrowseLoop { handle });
        Ok(())
    }

    #[cfg(not(feature = "mdns"))]
    #[allow(dead_code)] // never called in feature-less dev builds; kept for API parity
    pub fn start(&self, _sink: Arc<dyn EventSink>) -> Result<(), String> {
        // DC-21 §6.1: explicit no-op with honest log (feature off).
        log::info!("mdns browse service not started: feature disabled (DC-21 §6.1/D9)");
        Ok(())
    }

    /// DC-21 §3.2(b)/§5.1: push the accumulated browse snapshot to the
    /// sidecar as an mdns_snapshot notification. Called once when the
    /// sidecar's ping confirms readiness (order-independent convergence per
    /// D8: a sidecar restart re-requests by re-pinging, and Rust re-pushes;
    /// the sidecar-side seed is idempotent). NOTE (documented deviation from
    /// §3.2(b)'s literal "sidecar -> Rust" direction): the existing stdio
    /// channel carries Rust->sidecar requests only — the sidecar's stdout is
    /// reserved for correlated responses, so the pull is implemented as a
    /// push of the same data at the correlated moment. The sidecar's handler
    /// accepts the pushed entries array as the snapshot.
    pub fn push_snapshot(&self, sink: Arc<dyn EventSink>) {
        let events: Vec<MdnsEvent> = self
            .snapshot
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        for event in events {
            sink.push_event(event);
        }
    }

    /// Record one observation into the pending snapshot (browse loop calls).
    /// Deduped by instance_name (pkg10 review F4). Currently the observation
    /// flow reaches the snapshot via EventSink::record_observation's
    /// BrowseService side — this direct method is reserved for the loop-side
    /// path once stop/restart wiring lands.
    #[cfg_attr(feature = "mdns", allow(dead_code))]
    #[allow(dead_code)]
    fn record(&self, event: MdnsEvent) {
        if let Ok(mut s) = self.snapshot.lock() {
            if let Some(existing) = s
                .iter_mut()
                .find(|e| e.instance_name == event.instance_name)
            {
                *existing = event;
            } else {
                s.push(event);
            }
        }
    }

    /// Stop the browse loop and join its thread. Reserved for quit-path
    /// wiring (lib.rs currently leaves the loop running for the process
    /// lifetime; process teardown reclaims it).
    #[cfg_attr(feature = "mdns", allow(dead_code))]
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.stop
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(loop_handle) = guard.take() {
            let _ = loop_handle.handle.join();
        }
    }
}

impl Default for BrowseService {
    fn default() -> Self {
        Self::new()
    }
}

/// How often the live view is re-pushed to the sidecar. The sidecar cache
/// entries live `OBSERVATION_TTL_MS`; re-pushing every cycle keeps a
/// still-present peer fresh (DC-11 §3.4 "refreshed by observation": the
/// view IS the daemon's live, TTL-checked cache, see run_browse_loop).
#[cfg(feature = "mdns")]
const REFRESH_EVERY: Duration = Duration::from_secs(25);
/// Wait before restarting a browse that ended or failed (DC-21 §6.1).
#[cfg(feature = "mdns")]
const RESTART_BACKOFF: Duration = Duration::from_secs(5);
#[cfg(feature = "mdns")]
const OBSERVATION_TTL_MS: u64 = 120_000;
/// DC-11 A.2: at most one on-demand query round per minute, whatever the
/// number of kicks (Sync now presses, unreachable peers).
#[cfg(feature = "mdns")]
const KICK_MIN_INTERVAL: Duration = Duration::from_secs(60);
/// After a kick, live entries the daemon's cache replay does not confirm
/// within this window are treated as removed (DC-11 A.2 reconciliation).
#[cfg(feature = "mdns")]
const KICK_CONFIRM_WINDOW: Duration = Duration::from_secs(3);
/// Longest single wait in the loop, so a kick is acted on within ~1 s.
#[cfg(feature = "mdns")]
const KICK_POLL: Duration = Duration::from_secs(1);

/// The browse primitive the loop drives (real: TideMdns; tests: a fake).
#[cfg(feature = "mdns")]
pub(crate) trait BrowseSource {
    type Receiver;
    fn start_browse(&self) -> Result<Self::Receiver, String>;
    fn poll(&self, rx: &Self::Receiver, timeout: Duration) -> crate::tide_discovery::BrowsePoll;
    fn stop_browse(&self);
}

#[cfg(feature = "mdns")]
impl BrowseSource for crate::mdns_service::MdnsAdapterImpl {
    type Receiver = crate::tide_discovery::BrowseReceiver;
    fn start_browse(&self) -> Result<Self::Receiver, String> {
        crate::tide_discovery::TideMdns::start_browse(self)
    }
    fn poll(&self, rx: &Self::Receiver, timeout: Duration) -> crate::tide_discovery::BrowsePoll {
        rx.poll(timeout)
    }
    fn stop_browse(&self) {
        crate::tide_discovery::TideMdns::stop_browse(self)
    }
}

/// DC-21 §3.2(a): one "added" notification for a resolved service. Host =
/// first observed address (deterministic; DC-21 §8 defers multi-address
/// selection). None when the service has no address yet.
#[cfg(feature = "mdns")]
fn added_event(service: &crate::tide_discovery::DiscoveredService) -> Option<MdnsEvent> {
    let host = service.addresses.first()?.clone();
    Some(MdnsEvent {
        kind: "added".to_string(),
        instance_name: service.instance_name.clone(),
        host,
        port: service.port,
        interface: String::new(),
        observed_at: now_ms(),
        ttl_ms: OBSERVATION_TTL_MS,
    })
}

#[cfg(feature = "mdns")]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(feature = "mdns")]
fn forward(sink: &Arc<dyn EventSink>, event: MdnsEvent) {
    if !sink.sidecar_alive() {
        return;
    }
    sink.push_event(event.clone());
    // DC-21 §3.2(b): record the observation so a later snapshot push
    // (sidecar restart) can replay the full current view.
    sink.record_observation(event);
}

/// DC-11 §3.2 continuous browsing with ONE long-lived browse (previously a
/// brand-new browse every 25 s, which reset the RFC 6762 query backoff and
/// re-sent a query burst each cycle). The browse is restarted only when it
/// ends or fails to start.
///
/// TTL refresh: mdns-sd emits `Resolved` only on CHANGE, not on every record
/// refresh, so the loop keeps the live view itself (`Resolved` inserts or
/// updates, `Removed` deletes; mdns-sd sends `Removed` on goodbye, on SRV
/// expiry and when a service loses its addresses) and re-pushes that view
/// every `REFRESH_EVERY`. That matches what each fresh browse used to
/// replay from the daemon cache. Removals ARE forwarded (DC-21 §3.2(a),
/// review 2026-11-14), so a peer that left stops being dialled at once
/// instead of lingering until the sidecar TTL.
///
/// On-demand re-query (DC-11 Appendix A): a kick re-issues the browse on the
/// SAME daemon WITHOUT stop_browse. mdns-sd 0.21.0 then replaces the
/// listener, replays its cache and restarts the RFC 6762 query schedule
/// (1 s doubling), while the cache and this loop's live view are kept. The
/// old receiver is dropped; its retransmission chain ends on its next send.
#[cfg(feature = "mdns")]
fn run_browse_loop<S: BrowseSource>(
    sink: Arc<dyn EventSink>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    kick: Arc<std::sync::atomic::AtomicBool>,
    src: S,
    refresh_every: Duration,
    restart_backoff: Duration,
    kick_min_interval: Duration,
    confirm_window: Duration,
) {
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::time::Instant;
    use crate::tide_discovery::BrowsePoll;

    use std::collections::HashSet;
    let mut last_kick: Option<Instant> = None;
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let mut rx = match src.start_browse() {
            Ok(rx) => rx,
            Err(e) => {
                log::warn!("mdns browse failed to start: {e} (retrying after backoff, DC-21 §6.1)");
                std::thread::sleep(restart_backoff);
                continue;
            }
        };
        // A fresh browse replays the daemon cache, so the view restarts empty.
        let mut live: HashMap<String, MdnsEvent> = HashMap::new();
        let mut next_refresh = Instant::now() + refresh_every;
        // DC-11 A.2 reconciliation (review MAJOR-1): after a kick, every live
        // entry must be re-confirmed by the daemon's cache replay (sent
        // synchronously when it processes the new browse). A removal that
        // was still queued on the dropped receiver would otherwise be lost
        // and the dead entry re-pushed forever.
        let mut unconfirmed: HashSet<String> = HashSet::new();
        let mut confirm_by: Option<Instant> = None;
        let ended = loop {
            if stop.load(Ordering::Relaxed) {
                src.stop_browse();
                return;
            }
            if kick.swap(false, Ordering::Relaxed) {
                let due = last_kick.map_or(true, |t| t.elapsed() >= kick_min_interval);
                if due {
                    last_kick = Some(Instant::now());
                    match src.start_browse() {
                        Ok(fresh) => {
                            rx = fresh;
                            unconfirmed = live.keys().cloned().collect();
                            confirm_by = Some(Instant::now() + confirm_window);
                            log::info!("mdns: on-demand query round started (DC-11 A.2)");
                        }
                        Err(e) => log::warn!("mdns: on-demand query failed: {e}"),
                    }
                } else {
                    log::debug!("mdns: kick ignored (rate limit, DC-11 A.2)");
                }
            }
            let wait = next_refresh
                .saturating_duration_since(Instant::now())
                .min(KICK_POLL);
            match src.poll(&rx, wait) {
                BrowsePoll::Resolved(service) => {
                    unconfirmed.remove(&service.instance_name);
                    if let Some(event) = added_event(&service) {
                        live.insert(event.instance_name.clone(), event.clone());
                        forward(&sink, event);
                    }
                }
                BrowsePoll::Removed(name) => {
                    if let Some(mut gone) = live.remove(&name) {
                        gone.kind = "removed".to_string();
                        gone.observed_at = now_ms();
                        forward(&sink, gone);
                    }
                }
                BrowsePoll::Idle => {}
                BrowsePoll::Ended(reason) => break reason,
            }
            if confirm_by.is_some_and(|t| Instant::now() >= t) {
                for name in unconfirmed.drain() {
                    if let Some(mut gone) = live.remove(&name) {
                        log::info!("mdns: {name} not confirmed after re-query; treated as removed");
                        gone.kind = "removed".to_string();
                        gone.observed_at = now_ms();
                        forward(&sink, gone);
                    }
                }
                confirm_by = None;
            }
            if Instant::now() >= next_refresh {
                let observed_at = now_ms();
                for event in live.values() {
                    let mut refreshed = event.clone();
                    refreshed.observed_at = observed_at;
                    forward(&sink, refreshed);
                }
                next_refresh = Instant::now() + refresh_every;
            }
        };
        log::warn!("mdns browse ended: {ended} (restarting after backoff, DC-21 §6.1)");
        src.stop_browse();
        std::thread::sleep(restart_backoff);
    }
}

#[cfg(all(feature = "mdns", test))]
mod browse_loop_tests {
    use super::*;
    use crate::tide_discovery::{BrowsePoll, DiscoveredService};
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// Scripted browse: `starts` answers each start_browse; `polls` answers
    /// each poll. An exhausted poll script raises the stop flag, so every
    /// test terminates deterministically without timers.
    struct FakeSource {
        starts: Mutex<VecDeque<Result<(), String>>>,
        polls: Mutex<VecDeque<BrowsePoll>>,
        start_calls: AtomicUsize,
        stop_calls: AtomicUsize,
        stop: Arc<AtomicBool>,
    }

    impl BrowseSource for &FakeSource {
        type Receiver = ();
        fn start_browse(&self) -> Result<(), String> {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            self.starts.lock().unwrap().pop_front().unwrap_or(Ok(()))
        }
        fn poll(&self, _rx: &(), _timeout: Duration) -> BrowsePoll {
            match self.polls.lock().unwrap().pop_front() {
                Some(p) => p,
                None => {
                    self.stop.store(true, Ordering::SeqCst);
                    BrowsePoll::Idle
                }
            }
        }
        fn stop_browse(&self) {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        pushed: Mutex<Vec<MdnsEvent>>,
    }

    impl EventSink for RecordingSink {
        fn push_event(&self, event: MdnsEvent) {
            self.pushed.lock().unwrap().push(event);
        }
        fn sidecar_alive(&self) -> bool {
            true
        }
    }

    fn svc(name: &str) -> BrowsePoll {
        BrowsePoll::Resolved(DiscoveredService {
            instance_name: name.to_string(),
            addresses: vec!["192.0.2.7".to_string()],
            port: 47471,
            txt: HashMap::new(),
        })
    }

    fn run(starts: Vec<Result<(), String>>, polls: Vec<BrowsePoll>) -> (FakeSource, Vec<String>) {
        let stop = Arc::new(AtomicBool::new(false));
        let src = FakeSource {
            starts: Mutex::new(starts.into()),
            polls: Mutex::new(polls.into()),
            start_calls: AtomicUsize::new(0),
            stop_calls: AtomicUsize::new(0),
            stop: Arc::clone(&stop),
        };
        let sink = Arc::new(RecordingSink::default());
        // refresh_every = 0: every poll is followed by one refresh tick.
        run_browse_loop(
            sink.clone() as Arc<dyn EventSink>,
            stop,
            Arc::new(AtomicBool::new(false)),
            &src,
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
        );
        let names = sink
            .pushed
            .lock()
            .unwrap()
            .iter()
            .map(|e| {
                if e.kind == "removed" {
                    format!("-{}", e.instance_name)
                } else {
                    e.instance_name.clone()
                }
            })
            .collect();
        (src, names)
    }

    #[test]
    fn one_browse_survives_many_refresh_cycles() {
        let mut polls = vec![svc("a")];
        polls.extend((0..20).map(|_| BrowsePoll::Idle));
        let (src, pushed) = run(vec![], polls);
        assert_eq!(src.start_calls.load(Ordering::SeqCst), 1, "browse restarted on a timer");
        // 1 resolve + a refresh after each of the 21 scripted polls + the
        // final stop-raising poll.
        assert_eq!(pushed.len(), 1 + 22);
        assert!(pushed.iter().all(|n| n == "a"));
        assert_eq!(src.stop_calls.load(Ordering::SeqCst), 1, "stop must end the browse");
    }

    #[test]
    fn removed_service_is_no_longer_refreshed() {
        let polls = vec![svc("a"), svc("b"), BrowsePoll::Removed("a".into()), BrowsePoll::Idle];
        let (src, pushed) = run(vec![], polls);
        assert_eq!(src.start_calls.load(Ordering::SeqCst), 1);
        // a, [refresh a], b, [refresh a b], (removed a) [refresh b], idle
        // [refresh b], final poll [refresh b].
        // The removal itself is forwarded once ("-a"), then only b is refreshed.
        let at = pushed.iter().position(|n| n == "-a").expect("removal forwarded");
        assert_eq!(pushed.iter().filter(|n| n.as_str() == "-a").count(), 1, "{pushed:?}");
        let after_removal: Vec<&String> = pushed.iter().skip(at + 1).collect();
        assert!(!after_removal.is_empty());
        assert!(after_removal.iter().all(|n| n.as_str() == "b"), "{pushed:?}");
    }

    #[test]
    fn removal_of_unknown_instance_is_not_forwarded() {
        let polls = vec![BrowsePoll::Removed("never-seen".into()), BrowsePoll::Idle];
        let (_src, pushed) = run(vec![], polls);
        assert!(pushed.iter().all(|n| !n.starts_with('-')), "{pushed:?}");
    }

    /// DC-11 A.2 reconciliation (review MAJOR-1): after a kick, an entry the
    /// cache replay does not re-confirm is forwarded as removed; a confirmed
    /// one stays.
    #[test]
    fn kick_drops_entries_the_replay_does_not_confirm() {
        let stop = Arc::new(AtomicBool::new(false));
        let kick = Arc::new(AtomicBool::new(false));
        struct KickAt {
            inner: FakeSource,
            kick: Arc<AtomicBool>,
            n: AtomicUsize,
            at: usize,
        }
        impl BrowseSource for &KickAt {
            type Receiver = ();
            fn start_browse(&self) -> Result<(), String> {
                (&self.inner).start_browse()
            }
            fn poll(&self, rx: &(), t: Duration) -> BrowsePoll {
                // Raise the kick right after poll `at`, so the loop honours it
                // before the next poll (the replay).
                let i = self.n.fetch_add(1, Ordering::SeqCst);
                let out = (&self.inner).poll(rx, t);
                if i + 1 == self.at {
                    self.kick.store(true, Ordering::SeqCst);
                }
                out
            }
            fn stop_browse(&self) {
                (&self.inner).stop_browse()
            }
        }
        let src = KickAt {
            inner: FakeSource {
                starts: Mutex::new(VecDeque::new()),
                // a, b resolved; kick; replay confirms only b; idle.
                polls: Mutex::new(vec![svc("a"), svc("b"), svc("b"), BrowsePoll::Idle].into()),
                start_calls: AtomicUsize::new(0),
                stop_calls: AtomicUsize::new(0),
                stop: Arc::clone(&stop),
            },
            kick: Arc::clone(&kick),
            n: AtomicUsize::new(0),
            at: 2,
        };
        let sink = Arc::new(RecordingSink::default());
        run_browse_loop(
            sink.clone() as Arc<dyn EventSink>,
            stop,
            kick,
            &src,
            Duration::from_secs(3600),
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
        );
        assert_eq!(src.inner.start_calls.load(Ordering::SeqCst), 2, "kick re-issued the browse");
        let pushed = sink.pushed.lock().unwrap();
        let removed: Vec<&str> = pushed
            .iter()
            .filter(|e| e.kind == "removed")
            .map(|e| e.instance_name.as_str())
            .collect();
        assert_eq!(removed, vec!["a"], "{pushed:?}");
    }

    /// DC-11 A.2: a kick re-issues the browse WITHOUT stop_browse (cache and
    /// live view kept); a second kick inside the interval is ignored.
    #[test]
    fn kick_requeries_once_per_interval_and_keeps_the_view() {
        let stop = Arc::new(AtomicBool::new(false));
        let kick = Arc::new(AtomicBool::new(false));
        struct KickingSource {
            inner: FakeSource,
            kick: Arc<AtomicBool>,
            polls_seen: AtomicUsize,
        }
        impl BrowseSource for &KickingSource {
            type Receiver = ();
            fn start_browse(&self) -> Result<(), String> {
                (&self.inner).start_browse()
            }
            fn poll(&self, rx: &(), t: Duration) -> BrowsePoll {
                // Raise a kick before every poll: only the first is honoured.
                self.kick.store(true, Ordering::SeqCst);
                self.polls_seen.fetch_add(1, Ordering::SeqCst);
                (&self.inner).poll(rx, t)
            }
            fn stop_browse(&self) {
                (&self.inner).stop_browse()
            }
        }
        let src = KickingSource {
            inner: FakeSource {
                starts: Mutex::new(VecDeque::new()),
                polls: Mutex::new(vec![svc("a"), BrowsePoll::Idle, BrowsePoll::Idle].into()),
                start_calls: AtomicUsize::new(0),
                stop_calls: AtomicUsize::new(0),
                stop: Arc::clone(&stop),
            },
            kick: Arc::clone(&kick),
            polls_seen: AtomicUsize::new(0),
        };
        let sink = Arc::new(RecordingSink::default());
        run_browse_loop(
            sink.clone() as Arc<dyn EventSink>,
            stop,
            kick,
            &src,
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(3600),
            Duration::from_secs(3600),
        );
        // 1 initial browse + exactly 1 honoured kick, never a stop_browse
        // before the final shutdown.
        assert_eq!(src.inner.start_calls.load(Ordering::SeqCst), 2);
        assert_eq!(src.inner.stop_calls.load(Ordering::SeqCst), 1);
        // "a" stays in the live view across the kick (refreshed after it).
        let pushed = sink.pushed.lock().unwrap();
        assert!(pushed.iter().filter(|e| e.instance_name == "a").count() >= 3, "{pushed:?}");
    }

    #[test]
    fn browse_restarts_only_when_it_ends_and_view_resets() {
        let polls = vec![svc("a"), BrowsePoll::Ended("daemon gone".into()), BrowsePoll::Idle];
        let (src, pushed) = run(vec![], polls);
        assert_eq!(src.start_calls.load(Ordering::SeqCst), 2);
        // After the restart nothing was re-resolved, so "a" is not refreshed
        // from the dead browse's view: only resolve + its one refresh.
        assert_eq!(pushed, vec!["a".to_string(), "a".to_string()]);
    }

    #[test]
    fn failed_start_is_retried() {
        let (src, pushed) = run(vec![Err("no interfaces".into())], vec![svc("a")]);
        assert_eq!(src.start_calls.load(Ordering::SeqCst), 2);
        assert_eq!(pushed.first().map(String::as_str), Some("a"));
    }
}
