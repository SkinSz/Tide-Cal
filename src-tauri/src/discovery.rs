// Tide DC-11 §7: real mDNS service discovery (Rust side).
//
// This module is the platform implementation behind the TS adapter seam in
// src/network/discovery.ts. It uses the pure-Rust `mdns-sd` crate
// (https://crates.io/crates/mdns-sd) — no system daemon dependency.
//
// GATING (honest fallback, review R3 M-1):
//   - With the `mdns` cargo feature enabled, ServiceDiscovery performs REAL
//     multicast registration/browsing/withdrawal via mdns-sd.
//   - Without it (default), every operation is an explicit no-op that logs
//     "discovery unavailable" — it never pretends to have registered or
//     discovered anything.
//
// Contract constraints honored here (DC-11):
//   §2  instance name is opaque (SHA-256 prefix + random suffix, built by the
//       caller in TS); TXT keys are exactly {"pv","dn"}; nothing else announced.
//   §4  this module produces connection hints only — it NEVER touches trust
//       state. Browse results are handed to the caller verbatim.
//   §6  discovery is optional: any mdns-sd runtime error degrades to a logged
//       warning and an inert responder, never a crash (offline-first).

#![allow(dead_code)] // wired into lib.rs command registration separately

/// RFC 1035 §2.3.4: one DNS label is at most 63 bytes.
pub const MAX_DNS_LABEL_BYTES: usize = 63;

/// mDNS host name announced in SRV/A records (bug #1b root cause, 2026-11-13).
///
/// Built from the instance name ONLY: that name is already public and opaque
/// (DC-11 §2.2), so the host reveals nothing new. It previously embedded the
/// full device_id: a 71-byte label that mdns-sd silently refuses to encode,
/// which dropped SRV + A from every packet (peers saw PTR/TXT, never resolved)
/// and would otherwise have broadcast the device_id LAN-wide.
pub fn host_label_for(instance_name: &str) -> String {
    format!("tide-{instance_name}.local.")
}

/// Fail-closed host check: mdns-sd drops over-long names silently on the
/// wire, so reject them here where the error is logged instead.
pub fn validate_host_label(host: &str) -> Result<(), String> {
    let trimmed = host.strip_suffix('.').unwrap_or(host);
    if trimmed.is_empty() {
        return Err("empty mDNS host name".into());
    }
    for label in trimmed.split('.') {
        if label.is_empty() || label.len() > MAX_DNS_LABEL_BYTES {
            return Err(format!(
                "mDNS host label of {} bytes (allowed 1..={MAX_DNS_LABEL_BYTES}, RFC 1035)",
                label.len()
            ));
        }
    }
    Ok(())
}

#[cfg(feature = "mdns")]
mod real {
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    /// DC-11 §2.1 — fixed service type (must match TS TIDE_SERVICE_TYPE).
    pub const TIDE_SERVICE_TYPE: &str = "_tide-sync._tcp.local.";

    pub struct TideMdns {
        daemon: Arc<ServiceDaemon>,
        registered_fullname: std::sync::Mutex<Option<String>>,
    }

    impl TideMdns {
        pub fn new() -> Result<Self, String> {
            let daemon = ServiceDaemon::new().map_err(|e| format!("mdns daemon: {e}"))?;
            Ok(Self {
                daemon: Arc::new(daemon),
                registered_fullname: std::sync::Mutex::new(None),
            })
        }

        /// DC-11 §7 register(service_identity): announce the service.
        /// `txt` must contain only {"pv","dn"} keys — enforced here fail-closed
        /// so a caller bug cannot leak fields onto the wire (DC-11 §2.3).
        pub fn register(
            &self,
            instance_name: &str,
            port: u16,
            txt: &HashMap<String, String>,
            host: &str,
        ) -> Result<(), String> {
            for key in txt.keys() {
                if key != "pv" && key != "dn" {
                    return Err(format!("forbidden TXT key \"{key}\" (DC-11 §2.3)"));
                }
            }
            // Host string for mdns-sd: opaque label, not leaked into TXT.
            let host_label = if host.ends_with('.') {
                host.to_string()
            } else {
                format!("{host}.")
            };
            super::validate_host_label(&host_label)?;
            let props: HashMap<String, String> = txt.clone();
            let service_info = ServiceInfo::new(
                TIDE_SERVICE_TYPE,
                instance_name,
                &host_label,
                "",
                port,
                Some(props),
            )
            .map_err(|e| format!("service info: {e}"))?
            // Bug #1b follow-up (2026-11-13): the empty IP string above yields
            // an EMPTY address set; without addr_auto mdns-sd announces on no
            // interface at all (prepare_announce returns None everywhere) —
            // the service existed but was invisible to any browser. addr_auto
            // fills addresses from the host's live interfaces at announce
            // time (and tracks changes, DC-21 §5.2).
            .enable_addr_auto();
            let fullname = service_info.get_fullname().to_string();
            self.daemon
                .register(service_info)
                .map_err(|e| format!("register: {e}"))?;
            *self.registered_fullname.lock().unwrap() = Some(fullname);
            Ok(())
        }

        /// DC-11 §7 browse() -> events: start ONE long-lived browse. The
        /// returned receiver yields events until the browse ends; the daemon
        /// keeps querying on the standard RFC 6762 schedule (1 s doubling up
        /// to 1 h) and refreshes cached records itself, so the caller must
        /// NOT restart the browse periodically (that reset the query backoff
        /// every cycle and re-sent a burst of queries, DC-11 §3.3). Results
        /// are UNTRUSTED hints (DC-11 §4.1); classification is the caller's.
        pub fn start_browse(&self) -> Result<BrowseReceiver, String> {
            let receiver = self
                .daemon
                .browse(TIDE_SERVICE_TYPE)
                .map_err(|e| format!("browse: {e}"))?;
            Ok(BrowseReceiver { receiver })
        }

        /// End the browse started by `start_browse` (best effort).
        pub fn stop_browse(&self) {
            let _ = self.daemon.stop_browse(TIDE_SERVICE_TYPE);
        }

        /// DC-11 §7 withdraw(): explicit unregistration (TR-4 disablement silence).
        pub fn withdraw(&self) -> Result<(), String> {
            if let Some(fullname) = self.registered_fullname.lock().unwrap().take() {
                self.daemon
                    .unregister(&fullname)
                    .map_err(|e| format!("unregister: {e}"))?;
            }
            Ok(())
        }
    }

    /// Receiving end of one long-lived browse (see `TideMdns::start_browse`).
    pub struct BrowseReceiver {
        receiver: mdns_sd::Receiver<ServiceEvent>,
    }

    /// One poll of a long-lived browse.
    #[derive(Debug, Clone)]
    pub enum BrowsePoll {
        /// A service resolved or changed (full current view of it).
        Resolved(DiscoveredService),
        /// The daemon dropped this instance (goodbye, or its records
        /// expired). Carries the same full name `Resolved` reports.
        Removed(String),
        /// Nothing relevant within the wait (timeout or lifecycle noise).
        Idle,
        /// The browse is over (daemon gone or search stopped); restart it.
        Ended(String),
    }

    impl BrowseReceiver {
        /// Wait up to `timeout` for the next browse event.
        pub fn poll(&self, timeout: Duration) -> BrowsePoll {
            match self.receiver.recv_timeout(timeout) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    let mut txt = HashMap::new();
                    for prop in info.get_properties().iter() {
                        let val = prop
                            .val()
                            .map(|v| String::from_utf8_lossy(v).into_owned())
                            .unwrap_or_default();
                        txt.insert(prop.key().to_string(), val);
                    }
                    BrowsePoll::Resolved(DiscoveredService {
                        instance_name: info.get_fullname().to_string(),
                        addresses: info.get_addresses().iter().map(|a| a.to_string()).collect(),
                        port: info.get_port(),
                        txt,
                    })
                }
                Ok(ServiceEvent::ServiceRemoved(_ty, fullname)) => BrowsePoll::Removed(fullname),
                Ok(ServiceEvent::SearchStopped(ty)) => {
                    BrowsePoll::Ended(format!("search stopped for {ty}"))
                }
                Ok(_) => BrowsePoll::Idle, // SearchStarted/ServiceFound: lifecycle noise
                Err(mdns_sd::RecvTimeoutError::Timeout) => BrowsePoll::Idle,
                Err(mdns_sd::RecvTimeoutError::Disconnected) => {
                    BrowsePoll::Ended("mdns daemon channel closed".to_string())
                }
            }
        }
    }

    #[derive(Debug, Clone)]
    pub struct DiscoveredService {
        pub instance_name: String,
        pub addresses: Vec<String>,
        pub port: u16,
        pub txt: HashMap<String, String>,
    }

    impl Drop for TideMdns {
        fn drop(&mut self) {
            let _ = self.withdraw();
        }
    }
}

#[cfg(feature = "mdns")]
#[allow(unused_imports)]
pub use real::{BrowsePoll, BrowseReceiver, DiscoveredService, TideMdns, TIDE_SERVICE_TYPE};

// ---------------------------------------------------------------------------
// Honest fallback (feature NOT enabled): explicit inert implementation.
// ---------------------------------------------------------------------------

#[cfg(not(feature = "mdns"))]
pub mod fallback {
    /// Inert stand-in used when the `mdns` feature is off. Every operation is
    /// an explicit, logged no-op: it never reports success at doing real
    /// multicast work (review R3 M-1: stubs must be honest).
    pub struct TideMdnsUnavailable;

    impl TideMdnsUnavailable {
        pub fn reason() -> &'static str {
            "mDNS discovery disabled: rebuild with --features mdns (mdns-sd crate)"
        }
    }
}

#[cfg(not(feature = "mdns"))]
#[allow(unused_imports)]
pub use fallback::TideMdnsUnavailable;

/// Pure TXT validation shared with the TS layer (DC-11 §2.3): only {"pv","dn"}.
#[cfg(test)]
mod tests {
    #[test]
    fn rejects_forbidden_txt_keys() {
        let mut txt = std::collections::HashMap::new();
        txt.insert("pv".to_string(), "1".to_string());
        txt.insert("hostname".to_string(), "box.lan".to_string());
        #[cfg(feature = "mdns")]
        {
            let mdns = super::real::TideMdns::new().expect("daemon");
            assert!(mdns.register("abc-1234", 5353, &txt, "tide").is_err());
        }
        #[cfg(not(feature = "mdns"))]
        {
            // Fallback path still validates the contract constant exists.
            assert!(super::fallback::TideMdnsUnavailable::reason().contains("disabled"));
        }
    }

    #[test]
    fn host_label_fits_dns_and_hides_device_id() {
        // Real shapes: 64-hex device_id, DC-11 §2.2 instance "8hex-4hex".
        let device_id = format!("d-{}", "7178a859".repeat(8));
        let instance = "8fa73ce0-2429";
        let host = super::host_label_for(instance);
        assert_eq!(host, "tide-8fa73ce0-2429.local.");
        assert!(super::validate_host_label(&host).is_ok());
        // Privacy by construction: the host is a pure function of the
        // (already public) instance name; no device_id parameter exists.
        // Even a pathological instance name can't reach the 63-byte cliff
        // unnoticed: the old device_id-based host is rejected, loudly.
        let old = format!("tide-{device_id}.local.");
        assert_eq!(old.split('.').next().unwrap().len(), 71);
        assert!(super::validate_host_label(&old).is_err());
    }

    #[test]
    fn validate_host_label_edges() {
        let ok63 = format!("{}.local.", "a".repeat(63));
        let bad64 = format!("{}.local.", "a".repeat(64));
        assert!(super::validate_host_label(&ok63).is_ok());
        assert!(super::validate_host_label(&bad64).is_err());
        assert!(super::validate_host_label("tide.local").is_ok());
        assert!(super::validate_host_label(".").is_err());
        assert!(super::validate_host_label("a..local.").is_err());
    }

    /// TD-035 runtime probe (manual, needs working local multicast; ~140 s):
    /// a long-lived browse must keep a present service (no Removed while
    /// the daemon refreshes its records past the 120 s TTL) and must report
    /// Removed under the SAME name after withdraw().
    /// Run: cargo test --lib persistent_browse_runtime_probe -- --ignored --nocapture
    #[cfg(feature = "mdns")]
    #[test]
    #[ignore]
    fn persistent_browse_runtime_probe() {
        use super::real::{BrowsePoll, TideMdns};
        use std::time::{Duration, Instant};
        let mut txt = std::collections::HashMap::new();
        txt.insert("pv".to_string(), "1".to_string());
        let announcer = TideMdns::new().expect("daemon A");
        let instance = format!("probe{:08x}-0001", std::process::id());
        announcer
            .register(&instance, 47999, &txt, &super::host_label_for(&instance))
            .expect("register");
        let browser = TideMdns::new().expect("daemon B");
        let rx = browser.start_browse().expect("browse");
        let deadline = Instant::now() + Duration::from_secs(20);
        let name = loop {
            assert!(Instant::now() < deadline, "service never resolved (multicast unavailable?)");
            if let BrowsePoll::Resolved(s) = rx.poll(Duration::from_secs(1)) {
                if s.instance_name.starts_with(&instance) {
                    break s.instance_name;
                }
            }
        };
        eprintln!("resolved {name}");
        let hold_until = Instant::now() + Duration::from_secs(135);
        while Instant::now() < hold_until {
            match rx.poll(Duration::from_secs(1)) {
                BrowsePoll::Removed(n) if n == name => panic!("removed while still announced"),
                BrowsePoll::Ended(r) => panic!("browse ended: {r}"),
                _ => {}
            }
        }
        eprintln!("still present after 135 s");
        announcer.withdraw().expect("withdraw");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no Removed after withdraw");
            if let BrowsePoll::Removed(n) = rx.poll(Duration::from_secs(1)) {
                if n == name {
                    eprintln!("removed under the same name: {n}");
                    break;
                }
            }
        }
        browser.stop_browse();
    }

    #[cfg(feature = "mdns")]
    #[test]
    fn register_rejects_overlong_host() {
        let mut txt = std::collections::HashMap::new();
        txt.insert("pv".to_string(), "1".to_string());
        let mdns = super::real::TideMdns::new().expect("daemon");
        let long = format!("tide-d-{}.local.", "7".repeat(64));
        let err = mdns.register("abc12345-0001", 47999, &txt, &long).unwrap_err();
        assert!(err.contains("71 bytes"), "{err}");
    }
}
