// Tide TD-006 / DC-16 §4.0: minimal Paired Devices list (owner decision O4).
// Read-only display + THREE explicit actions only:
//   - "Reset peer state" (Tier 1) — one click, no confirmation (§4.2)
//   - "Unblock" (Tier 2) — TWO-STEP confirmation stating why/when blocked
//     and warning that unblocking re-exposes the receiver (§4.2)
//   - "Unpair..." (DC-27) — the DC-05 §7.1 revocation, propagated by DC-10
//     (no new unpair mechanism, DC-16 D3/§5.4). Two-step inline confirmation
//     (§4.1/§4.2); the sidecar also refuses without confirm:true.
// Plus a read-only "Removed devices" section (DC-27 §4.11, P8).
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
  /** DC-27 P6: our last session attempt with this peer was refused. */
  refused_us: boolean;
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
    refused_us: r.refused_us === true,
  }));
}

// ---------------------------------------------------------------------------
// DC-27 §4.1/§4.2 Unpair: wording + confirmation state machine (pure)
// ---------------------------------------------------------------------------

/** Step-1 panel text, exactly as DC-27 §4.1 (P1) + the P6 hint line. */
export function unpairPanelText(
  label: string,
  refusedUs: boolean,
): { heading: string; lines: string[]; cancel: string; confirm: string } {
  const lines = [
    `${label} will stop syncing with this device and with your other paired devices.`,
    `Appointments already received from ${label} stay here.`,
    `Changes made on ${label} that have not synced yet will not arrive. If ${label} is reachable, press Sync now first.`,
    `This cannot be undone. To use ${label} with Tide again, it must start fresh and be paired again.`,
  ];
  if (refusedUs) {
    lines.push(
      `${label} may already have unpaired this device. Unpairing it here also removes it from devices this one can still reach.`,
    );
  }
  return { heading: `Unpair ${label}?`, lines, cancel: "Cancel", confirm: `Unpair ${label}` };
}

/**
 * DC-27 §4.11: the reason part of the failure line. The sidecar prefixes a
 * machine code ("ERR_BUSY: ..."); the user sees the plain sentence only.
 */
export function unpairFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error:\s*/, "")
    .replace(/^ERR_[A-Z_]+:\s*/, "")
    .replace(/\.$/, "");
}

/** DC-27 §4.11: inline failure text. */
export function unpairFailedText(reason: string): string {
  return `Unpair failed: ${reason}. Nothing was changed.`;
}

/**
 * DC-27 §4.2 UI state machine:
 *   idle    --open-->    confirm (panel shown)
 *   confirm --confirm--> execute
 *   anything else (cancel, re-render, other row action) --> idle
 */
export type UnpairStep = "idle" | "confirm" | "execute";
export type UnpairEvent = "open" | "confirm" | "cancel" | "rerender" | "other_action";

export function unpairNextStep(current: UnpairStep, event: UnpairEvent): UnpairStep {
  if (current === "idle" && event === "open") return "confirm";
  if (current === "confirm" && event === "confirm") return "execute";
  return "idle";
}

/** DC-27 §6 (d) row of list_removed_devices. */
export interface RemovedDeviceRow {
  device_id: string;
  label: string;
  removed_at: number;
  told: Array<{ device_id: string; label?: string; done: boolean }>;
}

function isoLocalDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** DC-27 §4.11 display lines for one removed device (pure). */
export function shapeRemovedDevice(r: RemovedDeviceRow): { title: string; told: string } {
  const label = r.label && r.label.length > 0 ? r.label : truncatedDeviceId(r.device_id);
  const told =
    r.told.length === 0
      ? "No other devices to tell."
      : "Other devices told: " +
        r.told
          .map(
            (t) =>
              `${t.label && t.label.length > 0 ? t.label : truncatedDeviceId(t.device_id)} - ${
                t.done ? "done" : "waiting"
              }`,
          )
          .join("; ");
  return { title: `${label}  removed ${isoLocalDate(r.removed_at)}`, told };
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
/** DC-27 §4.2: the one row whose Unpair panel is open (cleared on re-render). */
let unpairDisarm: (() => void) | null = null;

function disarmUnpair(): void {
  const d = unpairDisarm;
  unpairDisarm = null;
  d?.();
}

async function renderRemoved(): Promise<void> {
  const section = dlg().querySelector("#removed-devices-section") as HTMLElement | null;
  const list = el<HTMLDivElement>("removed-devices-list");
  if (section === null || list === null) return;
  list.textContent = "";
  let rows: RemovedDeviceRow[] = [];
  try {
    rows = (await syncOp<{ removed: RemovedDeviceRow[] }>("list_removed_devices")).removed;
  } catch (err) {
    console.warn("[tide] list_removed_devices unavailable:", err);
    section.hidden = true;
    return;
  }
  section.hidden = rows.length === 0;
  for (const r of rows) {
    const v = shapeRemovedDevice(r);
    const row = document.createElement("div");
    row.className = "removed-device-row";
    const title = document.createElement("div");
    title.textContent = v.title;
    const told = document.createElement("div");
    told.className = "muted";
    told.textContent = v.told;
    row.append(title, told);
    list.appendChild(row);
  }
}

function render(): void {
  const list = el<HTMLDivElement>("paired-devices-list");
  list.innerHTML = "";
  armedUnblock.clear();
  disarmUnpair(); // DC-27 §4.2: any re-render returns Unpair to idle
  void renderRemoved();
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
    disarmUnpair(); // DC-27 §4.2: other row action -> idle
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
      disarmUnpair(); // DC-27 §4.2: other row action -> idle
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

  // --- Unpair... (DC-27 §4.1/§4.2): two-step inline confirmation ---
  const unpair = document.createElement("button");
  unpair.type = "button";
  unpair.textContent = "Unpair...";
  unpair.addEventListener("click", () => {
    if (unpairDisarm !== null) disarmUnpair(); // another row's panel closes
    openUnpairPanel(row, v);
  });
  actions.appendChild(unpair);

  row.appendChild(actions);
  return row;
}

/** DC-27 §4.1 Step-1 panel (text set with textContent only). */
function openUnpairPanel(row: HTMLDivElement, v: PairedDeviceView): void {
  let step: UnpairStep = unpairNextStep("idle", "open");
  const text = unpairPanelText(v.display, v.refused_us);
  const panel = document.createElement("div");
  panel.className = "unpair-panel";
  const heading = document.createElement("strong");
  heading.textContent = text.heading;
  const ul = document.createElement("ul");
  for (const line of text.lines) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.appendChild(li);
  }
  const buttons = document.createElement("div");
  buttons.className = "unpair-panel-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = text.cancel;
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = text.confirm;
  buttons.append(cancel, confirm);
  panel.append(heading, ul, buttons);
  row.querySelector(".unpair-error")?.remove();
  row.appendChild(panel);
  const close = (): void => {
    step = "idle";
    panel.remove();
  };
  unpairDisarm = close;
  cancel.addEventListener("click", () => {
    step = unpairNextStep(step, "cancel");
    disarmUnpair();
  });
  confirm.addEventListener("click", () => {
    step = unpairNextStep(step, "confirm");
    if (step !== "execute") return;
    confirm.disabled = true;
    cancel.disabled = true;
    void syncOp("unpair_device", { device_id: v.device_id, confirm: true }).then(
      () => render(), // the row leaves the list; Removed devices shows it
      (err: unknown) => {
        disarmUnpair();
        const msg = document.createElement("div");
        msg.className = "muted unpair-error";
        msg.textContent = unpairFailedText(unpairFailureReason(err));
        row.appendChild(msg);
      },
    );
  });
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
