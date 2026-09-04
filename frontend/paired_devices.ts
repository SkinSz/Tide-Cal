// Tide TD-006 / DC-16 §4.0: minimal Paired Devices list (owner decision O4).
// Read-only display + THREE explicit actions only:
//   - "Reset peer state" (Tier 1) — one click, no confirmation (§4.2)
//   - "Unblock" (Tier 2) — TWO-STEP confirmation stating why/when blocked
//     and warning that unblocking re-exposes the receiver (§4.2)
//   - "Unpair" — DISABLED placeholder routing to the existing DC-10
//     revocation flow (no new unpair mechanism is created; D4/§5.4)
// Data + actions ride the existing `sync_op` passthrough (no Rust changes).
import { syncOp } from "./devices.ts";
import { truncatedDeviceId } from "./device-label.ts";
import type { PeerStateRow } from "./sync_errors.ts";

export type PairedDeviceRow = PeerStateRow;

/** Pure display shaping (unit-testable without DOM). */
export interface PairedDeviceView {
  device_id: string;
  display: string;
  truncated_id: string;
  paired_at: number | null;
  level: number;
  label: string;
  hard_blocked: boolean;
  hard_block_summary: string;
  dropped_while_throttled: number;
  window_invalid: number;
  window_total: number;
  recommend_unpair: boolean;
}

export function shapePairedDevices(rows: PairedDeviceRow[]): PairedDeviceView[] {
  return rows.map((r) => ({
    device_id: r.device_id,
    display: r.display_name ?? truncatedDeviceId(r.device_id),
    truncated_id: truncatedDeviceId(r.device_id),
    paired_at: r.paired_at,
    level: r.level,
    label: r.ladder_label,
    hard_blocked: r.hard_block !== null,
    hard_block_summary:
      r.hard_block === null
        ? ""
        : `blocked ${new Date(r.hard_block.first_triggered_at).toISOString()}` +
          ` — ${r.hard_block.trigger_count} trigger(s)`,
    dropped_while_throttled: r.dropped_while_throttled,
    window_invalid: r.window_invalid,
    window_total: r.window_total,
    recommend_unpair: r.recommend_unpair === true,
  }));
}

/**
 * §4.2 Unblock two-step confirmation, as a pure state machine so the
 * confirm-or-execute decision is unit-testable without a DOM:
 *   click 1 -> "confirm" state (shows why/when + re-exposure warning)
 *   click 2 -> "execute"
 *   any other interaction / re-render -> back to "idle" (must re-confirm)
 */
export type UnblockStep = "idle" | "confirm" | "execute";

export function unblockNextStep(current: UnblockStep): UnblockStep {
  return current === "idle" ? "confirm" : current === "confirm" ? "execute" : "idle";
}

/** The §4.2 confirmation text shown between step 1 and step 2. */
export function unblockWarningText(view: PairedDeviceView): string {
  return (
    `Hard block reason: this device sent a flood of invalid sync records ` +
    `(>5,000 in a 10-minute window). ${view.hard_block_summary}. ` +
    `Unblocking re-exposes this device to the flood that triggered the ` +
    `block. Are you sure?`
  );
}

export async function fetchPairedDevices(): Promise<PairedDeviceRow[]> {
  const res = await syncOp<{ devices: PairedDeviceRow[] }>(
    "list_paired_devices",
  );
  return res.devices;
}

function dlg(): HTMLDialogElement {
  return document.getElementById("paired-devices-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

/** Step-2 armed state per device id (cleared on every re-render). */
const armedUnblock = new Set<string>();

function render(): void {
  const list = el<HTMLDivElement>("paired-devices-list");
  list.innerHTML = "";
  armedUnblock.clear();
  void (async () => {
    let rows: PairedDeviceRow[] = [];
    try {
      rows = await fetchPairedDevices();
    } catch (err) {
      console.warn("[tide] list_paired_devices unavailable:", err);
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "(device list unavailable in this environment)";
      list.appendChild(p);
      return;
    }
    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No paired devices yet.";
      list.appendChild(p);
      return;
    }
    for (const v of shapePairedDevices(rows)) list.appendChild(renderDevice(v));
  })();
}

function renderDevice(v: PairedDeviceView): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "peer-row paired-device-row";

  const name = document.createElement("strong");
  name.textContent = v.display;
  const id = document.createElement("span");
  id.className = "muted";
  id.textContent = v.truncated_id;
  const state = document.createElement("code");
  state.className = "muted";
  state.textContent =
    `Tier-1: L${v.level} ${v.label}` +
    (v.dropped_while_throttled > 0
      ? `, ${v.dropped_while_throttled} dropped`
      : "") +
    (v.hard_blocked ? " — HARD BLOCKED" : "");
  row.append(name, id, state);
  if (v.hard_blocked) {
    const warn = document.createElement("div");
    warn.className = "muted";
    warn.textContent = v.hard_block_summary;
    row.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "paired-device-actions";

  // --- Reset peer state (Tier 1): one click, no confirmation (§4.2) ---
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset peer state";
  reset.addEventListener("click", () => {
    void syncOp("reset_peer_state", { device_id: v.device_id }).then(render);
  });
  actions.appendChild(reset);

  // --- Unblock (Tier 2): TWO-STEP confirmation (§4.2) ---
  const unblock = document.createElement("button");
  unblock.type = "button";
  unblock.textContent = v.hard_blocked ? "Unblock" : "Unblock (not blocked)";
  unblock.disabled = !v.hard_blocked;
  if (v.hard_blocked) {
    unblock.addEventListener("click", () => {
      const step = unblockNextStep(armedUnblock.has(v.device_id) ? "confirm" : "idle");
      if (step === "confirm") {
        armedUnblock.add(v.device_id);
        unblock.textContent = "Confirm unblock";
        unblock.title = unblockWarningText(v);
        const warn = document.createElement("div");
        warn.className = "muted unblock-warning";
        warn.textContent = unblockWarningText(v);
        row.appendChild(warn);
        return; // step 1 done: second click executes
      }
      armedUnblock.delete(v.device_id);
      void syncOp("unblock_peer", { device_id: v.device_id }).then(render);
    });
  }
  actions.appendChild(unblock);

  // --- Unpair: DISABLED placeholder routing to the DC-10 flow (§5.4) ---
  const unpair = document.createElement("button");
  unpair.type = "button";
  unpair.disabled = true;
  unpair.textContent = "Unpair";
  unpair.title =
    "Unpairing requires the revocation flow (DC-10) with its own explicit confirmation — use “Devices & Sync” pairing/revocation entry point. Nothing is revoked from here.";
  actions.appendChild(unpair);

  row.appendChild(actions);
  return row;
}

export function initPairedDevices(): void {
  document
    .getElementById("btn-paired-devices")
    ?.addEventListener("click", () => {
      render();
      dlg().showModal();
    });
  document
    .getElementById("paired-devices-close")
    ?.addEventListener("click", () => dlg().close());
}
