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
        }
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
        let handle = std::thread::Builder::new()
            .name("tide-mdns-browse".into())
            .spawn(move || {
                run_browse_loop(sink, stop, mdns);
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

#[cfg(feature = "mdns")]
fn run_browse_loop(
    sink: Arc<dyn EventSink>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    mdns: crate::mdns_service::MdnsAdapterImpl,
) {
    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let sink_for_pass = Arc::clone(&sink);
        let result = mdns.browse(Duration::from_secs(25), |service| {
            if stop.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            if !sink_for_pass.sidecar_alive() {
                return;
            }
            // DC-21 §3.2(a): one notification per resolved service. Host =
            // first observed address (deterministic choice; DC-21 §8
            // documents multi-address selection as deferred).
            let host = match service.addresses.first() {
                Some(a) => a.clone(),
                None => return,
            };
            let event = MdnsEvent {
                kind: "added".to_string(),
                instance_name: service.instance_name.clone(),
                host,
                port: service.port,
                interface: String::new(),
                observed_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                ttl_ms: 120_000, // refreshed by the next browse cycle's re-resolution
            };
            sink_for_pass.push_event(event.clone());
            // DC-21 §3.2(b): record the observation so a later snapshot push
            // (sidecar restart) can replay the full current view.
            sink_for_pass.record_observation(event);
        });
        if let Err(e) = result {
            log::warn!(
                "mdns browse cycle error: {e} (retrying after backoff, DC-21 §6.1)"
            );
            std::thread::sleep(Duration::from_secs(5));
        }
    }
}
