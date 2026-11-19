; Tide NSIS installer hook — DC-24 §6.5 (binding, owner-approved 2026-10-11)
; Removes the two firewall rules the app created (Tide mDNS / Tide sync)
; during uninstall. Wired via tauri.conf.json bundle.windows.nsis
; installerHooks. The uninstaller runs elevated under NSIS by default, so
; netsh delete does not need its own elevation prompt (DC-24 §6.5).
; Failure is non-fatal: a leftover rule is inert once the program path is
; gone (§6.5: "uninstall continues").
; No telemetry, no network calls (DC-24 §2 standing rule).

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Removing Tide firewall rules (DC-24 §6.5)..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Tide mDNS"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Tide sync"'
!macroend
