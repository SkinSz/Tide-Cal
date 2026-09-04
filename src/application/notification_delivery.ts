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
      return null;
  }
}

const STRATEGIES = ["notify-send", "gdbus", "dbus-send"] as const;

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
      const child = spawn(strategy, args, { stdio: "ignore" });
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
