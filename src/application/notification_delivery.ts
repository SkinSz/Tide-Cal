// Tide DC-22 §4.1/D7: Linux OS desktop notification delivery.
//
// Fires via the freedesktop.org org.freedesktop.Notifications D-Bus interface
// — the standard KDE/GNOME path — using `notify-send` (present on every
// desktop Linux distribution that ships a notification daemon; the contract
// requires delivery through the OS notification service, not a specific bus
// library; implementation choice documented here per §4.1).
//
// Failure posture (§7.1/D11): spawn failures log ONCE per session and
// notifications are best-effort; the sidecar never crashes on delivery
// failure (INVARIANT 1 / D9: delivery is an ephemeral local side effect).
// pkg10 review F1: the caller must NOT mark a reminder delivered until
// dispatch is CONFIRMED — notify-send absence is an async ENOENT, so a bare
// spawn() return would silently swallow the reminder (D1 violation). The
// callback form below reports true only when the child spawned AND exited 0;
// a failed dispatch leaves the schedule key unmarked → §7.1 retry on next
// rebuild.

import { spawn } from "node:child_process";
import { renderNotification, type ScheduledFire } from "./reminder_engine.ts";

let unavailableLogged = false;

function logUnavailableOnce(reason: string): void {
  if (!unavailableLogged) {
    console.error(
      `[tide] desktop notifications unavailable (${reason}); reminders will retry on next rebuild (DC-22 §7.1)`,
    );
    unavailableLogged = true;
  }
}

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
  try {
    const child = spawn(
      "notify-send",
      [
        "--app-name=Tide",
        "--category=calendar",
        "--expire-time=10000",
        ...(fire.missed ? ["--urgency=normal"] : []),
        summary,
        body,
      ],
      { stdio: "ignore" },
    );
    child.on("error", (err) => {
      // ENOENT etc.: service unavailable (§7.1) — NOT delivered.
      logUnavailableOnce(err.message);
      settle(false);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        settle(true);
      } else {
        logUnavailableOnce(`notify-send exited ${code ?? "signal"}`);
        settle(false);
      }
    });
    // Safety valve: notify-send delivers and exits quickly; if neither event
    // fires within 10s (hung daemon), treat as failed (retry next rebuild).
    setTimeout(() => settle(false), 10_000).unref();
  } catch (err) {
    logUnavailableOnce(err instanceof Error ? err.message : String(err));
    settle(false);
  }
}
