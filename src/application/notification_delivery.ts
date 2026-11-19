// Tide DC-22 §4.1/D7: Linux OS desktop notification delivery.
//
// Fires via the freedesktop.org org.freedesktop.Notifications D-Bus interface
// — the standard KDE/GNOME path. TD-022 (2026-09-04): multi-strategy delivery
// replacing the notify-send-only path, per the delegate's cross-distro
// findings — notify-send (libnotify) is NOT universally present (minimal /
// WM-only installs), so delivery falls back to `gdbus`, which ships with
// GLib on effectively every desktop Linux system. Strategies in order:
//   1. notify-send   — richest (app-name, category, urgency, expire-time)
//   2. gdbus         — direct D-Bus call, same interface, GLib-bundled
//   3. dbus-send     — last resort (older systems)
// Strategy availability is probed ONCE per session (async spawn probe);
// failed strategies are skipped thereafter.
//
// Failure posture (§7.1/D11): spawn failures log per attempt with strategy
// name (TD-022 telemetry) and notifications are best-effort; the sidecar
// never crashes on delivery failure (INVARIANT 1 / D9: delivery is an
// ephemeral local side effect). pkg10 review F1: the caller must NOT mark a
// reminder delivered until dispatch is CONFIRMED — the callback form below
// reports true only when a strategy spawned AND exited 0; a failed dispatch
// leaves the schedule key unmarked → §7.1 retry on next rebuild.

import { spawn } from "node:child_process";
import { renderNotification, type ScheduledFire } from "./reminder_engine.ts";

/** Delivery strategies that failed this session; skipped thereafter. */
const deadStrategies = new Set<string>();

/** Shell-free arg vector for each strategy (no injection surface). */
function argsFor(
  strategy: string,
  fire: ScheduledFire,
  summary: string,
  body: string,
): string[] | null {
  switch (strategy) {
    case "notify-send":
      return [
        "--app-name=Tide",
        "--category=calendar",
        "--expire-time=10000",
        ...(fire.missed ? ["--urgency=normal"] : []),
        summary,
        body,
      ];
    case "gdbus":
      return [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.Notify",
        "Tide",
        "0",
        "",
        summary,
        body,
        "[]",
        "{}",
        "10000",
      ];
    case "dbus-send":
      // dbus-send prints a reply; --print-reply=literal keeps stdout small.
      return [
        "--session",
        "--print-reply=literal",
        "--dest=org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications.Notify",
        "string:Tide",
        "uint32:0",
        "string:",
        `string:${summary}`,
        `string:${body}`,
        "array:string:",
        "dict:string:variant:",
        "int32:10000",
      ];
    default:
      if (strategy === "powershell-toast") {
        return case_powershell_toast_args(summary, body);
      }
      if (strategy === "powershell-messagebox") {
        return case_powershell_messagebox_args(summary, body);
      }
      return null;
  }
}

// DC-24 §4.5 (2026-10-11): Windows strategy joins the SAME TD-022 chain.
// powershell-toast uses Windows' built-in Windows.UI.Notifications via a
// one-shot PowerShell child process (ships with every Windows 10/11 — no
// new dependency, same spawn shape as notify-send). Chain selection is
// per-platform: Windows gets [powershell-toast], Linux keeps the D-Bus
// chain in TD-022 order. Same session-dead-strategy + one-log-line-per-
// attempt rules; no notification daemon, no scheduled task (DC-24 §4.5).

/** XML-escape for the toast's text nodes (injection surface: body/summary
 * go into a template XML string; a crafted reminder title must not be able
 * to inject XML). Escapes &, <, >, ", ' — the five XML entities. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** arg vector for the "powershell-toast" strategy (DC-24 §4.5). */
function case_powershell_toast_args(
  summary: string,
  body: string,
): string[] {
  // The toast XML is passed as a single argv element (PowerShell -Command
  // via the spawn arg vector — no shell interpreter, no injection beyond
  // the XML-escaped text nodes). ToastTemplateType toastText02: one bold
  // summary line + one wrapped body line.
  const toastXml =
    `<toast><visual><binding template="ToastText02">` +
    `<text id="1">${xmlEscape(summary)}</text>` +
    `<text id="2">${xmlEscape(body)}</text>` +
    `</binding></visual></toast>`;
  // PowerShell single-quote escaping is redundant AFTER xmlEscape (all '
  // became &apos;) — kept as defense-in-depth in case the escape list ever
  // changes (review note #15).
  return [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-Command",
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;` +
      `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;` +
      `$x = New-Object Windows.Data.Xml.Dom.XmlDocument;` +
      `$x.LoadXml('${toastXml.replace(/'/g, "''")}');` +
      `$t = New-Object Windows.UI.Notifications.ToastNotification $x;` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Tide').Show($t)`,
  ];
}

/** arg vector for the "powershell-messagebox" fallback strategy
 * (DC-24 §4.5 tray-fallback equivalent: a blocking popup shown when the
 * toast subsystem is unavailable/blocked). Text is single-quote-doubled
 * for the PowerShell string literals; no shell interpreter is involved
 * (spawned as one argv element via -Command). */
function case_powershell_messagebox_args(
  summary: string,
  body: string,
): string[] {
  const q = (s: string): string => s.replace(/'/g, "''");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms | Out-Null; ` +
      `[System.Windows.Forms.MessageBox]::Show('${q(body)}', '${q(summary)}')`,
  ];
}

const STRATEGIES_LINUX = ["notify-send", "gdbus", "dbus-send"] as const;
// DC-24 §4.5 binding chain: powershell-toast → tray-fallback. The fallback
// writes a tray-balloon equivalent via PowerShell's MessageBox shell
// (BurntToast-free; a popup the user sees even if the toast subsystem is
// blocked by policy). Powershell.exe ships with every Windows 10/11.
const STRATEGIES_WINDOWS = ["powershell-toast", "powershell-messagebox"] as const;
const STRATEGIES = (
  process.platform === "win32" ? STRATEGIES_WINDOWS : STRATEGIES_LINUX
) as readonly string[];

/**
 * Deliver one notification through the OS desktop notification service.
 * Callback form (pkg10 F1): `onResult(true)` ONLY after the child spawned
 * AND exited 0. Any spawn error or nonzero exit → `onResult(false)` + the
 * once-per-session §7.1 log; the schedule key stays unmarked and the
 * reminder retries on the next rebuild. The promise resolves when the
 * outcome is known (spawn error, exit, or detached-success timeout).
 */
export function deliverNotification(
  fire: ScheduledFire,
  onResult: (ok: boolean) => void,
): void {
  const { summary, body } = renderNotification(fire);
  let settled = false;
  const settle = (ok: boolean): void => {
    if (!settled) {
      settled = true;
      onResult(ok);
    }
  };

  // TD-022 live-probe fix (2026-09-04): strategy failure must CHAIN to the
  // next candidate, not settle(false) — the first probe proved notify-send
  // ENOENT left the fire undelivered even though gdbus was available.
  // NOTE: `index` positions into STRATEGIES (the full ordered list), NOT the
  // filtered candidates — the first version filtered per call and indexed
  // into the shrunk array, which silently skipped the next strategy
  // (notify-send dead → candidates[1] was dbus-send, gdbus never tried).
  const attempt = (index: number): void => {
    if (index >= STRATEGIES.length) {
      console.error(
        "[tide] desktop notifications: ALL strategies failed this dispatch; reminder will retry on next rebuild (DC-22 §7.1)",
      );
      settle(false);
      return;
    }
    const strategy = STRATEGIES[index]!;
    if (deadStrategies.has(strategy)) {
      attempt(index + 1);
      return;
    }
    const args = argsFor(strategy, fire, summary, body);
    if (!args) {
      deadStrategies.add(strategy);
      attempt(index + 1);
      return;
    }
    // Telemetry (TD-022/deleg_25c67eca): one line per dispatch naming the
    // strategy being attempted — the pipeline stays auditable from the log.
    console.log(`[tide] notify via ${strategy}`);
    try {
      // DC-24 §4.5: the Windows strategy runs powershell.exe (the spawn
      // executable), not a bare command name; other strategies spawn
      // directly. Executable + args resolved together per strategy.
      const [exe, spawnArgs] =
        strategy === "powershell-toast" || strategy === "powershell-messagebox"
          ? (["powershell.exe", args] as const)
          : ([strategy, args] as const);
      const child = spawn(exe, spawnArgs, { stdio: "ignore" });
      child.on("error", (err) => {
        // ENOENT etc.: strategy unavailable on this distro — mark dead,
        // try the next strategy (§7.1, TD-022).
        deadStrategies.add(strategy);
        console.error(
          `[tide] notify strategy "${strategy}" unavailable (${err.message}); falling back`,
        );
        attempt(index + 1);
      });
      child.on("exit", (code) => {
        if (code === 0) {
          settle(true);
        } else {
          deadStrategies.add(strategy);
          console.error(
            `[tide] notify strategy "${strategy}" exited ${code ?? "signal"}; falling back`,
          );
          attempt(index + 1);
        }
      });
      // Safety valve: a strategy delivers and exits quickly; if neither
      // event fires within 10s (hung daemon), treat as failed.
      setTimeout(() => settle(false), 10_000).unref();
    } catch (err) {
      deadStrategies.add(strategy);
      console.error(
        `[tide] notify strategy "${strategy}" spawn threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      attempt(index + 1);
    }
  };

  attempt(0);
}
