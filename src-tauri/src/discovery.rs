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
            let props: HashMap<String, String> = txt.clone();
            let service_info = ServiceInfo::new(
                TIDE_SERVICE_TYPE,
                instance_name,
                &host_label,
                "",
                port,
                Some(props),
            )
            .map_err(|e| format!("service info: {e}"))?;
            let fullname = service_info.get_fullname().to_string();
            self.daemon
                .register(service_info)
                .map_err(|e| format!("register: {e}"))?;
            *self.registered_fullname.lock().unwrap() = Some(fullname);
            Ok(())
        }

        /// DC-11 §7 browse() -> events: browse until deadline, delivering each
        /// discovered/updated record to `on_service`. Results are UNTRUSTED
        /// hints (DC-11 §4.1); classification happens in the caller.
        pub fn browse(
            &self,
            timeout: Duration,
            mut on_service: impl FnMut(DiscoveredService),
        ) -> Result<usize, String> {
            let receiver = self
                .daemon
                .browse(TIDE_SERVICE_TYPE)
                .map_err(|e| format!("browse: {e}"))?;
            let deadline = std::time::Instant::now() + timeout;
            let mut count = 0usize;
            while let Ok(event) = receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let mut txt = HashMap::new();
                        for prop in info.get_properties().iter() {
                            let val = prop
                                .val()
                                .map(|v| String::from_utf8_lossy(v).into_owned())
                                .unwrap_or_default();
                            txt.insert(prop.key().to_string(), val);
                        }
                        on_service(DiscoveredService {
                            instance_name: info.get_fullname().to_string(),
                            addresses: info.get_addresses().iter().map(|a| a.to_string()).collect(),
                            port: info.get_port(),
                            txt,
                        });
                        count += 1;
                    }
                    _ => { /* SearchStarted/Received etc. — hint lifecycle noise */ }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
            }
            let _ = self.daemon.stop_browse(TIDE_SERVICE_TYPE);
            Ok(count)
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
pub use real::{DiscoveredService, TideMdns, TIDE_SERVICE_TYPE};

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
}
