// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  app_lib::run();
}

// DC-11 mDNS discovery implementation (owned module; NOT registered in
// lib.rs — see docs/reviews/review-findings-log.md R3 M-1).
// TODO(lib.rs owner): once command registration lands there, move this
// declaration into lib.rs and expose TideMdns as Tauri commands.
#[cfg_attr(not(feature = "mdns"), allow(dead_code))]
#[path = "discovery.rs"]
mod tide_discovery;
