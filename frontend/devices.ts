// Tide Devices & Sync surface: device identity, paired peers, pairing
// ceremony entry points, and manual "Sync now".
//
// Data access goes through Tauri `sync_op` passthrough (typed commands may
// replace it later). In a plain browser (vite dev without the shell) this
// module degrades honestly: buttons are disabled with a note.
type Json = Record<string, unknown>;

import { invoke } from "@tauri-apps/api/core";

/** Tauri `sync_op` passthrough; shared by the Devices and Sync Errors views. */
export async function syncOp<T = Json>(op: string, args: Json = {}): Promise<T> {
  // Same IPC mechanism as store.ts. In a plain browser (vite dev without the
  // shell) __TAURI_INTERNALS__ is absent -> degrade honestly.
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    throw new Error("not running inside the Tide desktop shell");
  }
  return (await invoke("sync_op", { op, args })) as T;
}

interface DeviceInfo {
  device_id: string;
  paired_peers: Array<{
    device_id: string;
    display_name: string;
    paired_at: number;
  }>;
  listening_port: number;
}

function dlg(): HTMLDialogElement {
  return document.getElementById("devices-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

function setBusy(b: boolean): void {
  el<HTMLButtonElement>("devices-busy").hidden = !b;
}

// TD-009: a pending offer (pairing-step-show showing a code) is cancellable.
function setOfferPending(pending: boolean): void {
  const btn = document.getElementById("btn-pairing-cancel");
  if (btn) btn.hidden = !pending;
}

async function cancelPairingOffer(): Promise<void> {
  setBusy(true);
  try {
    await syncOp("cancel_pairing_offer", {});
    setOfferPending(false);
    log(`Pairing offer cancelled`);
  } catch (err) {
    log(`pairing offer cancel failed: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function renderDeviceInfo(): Promise<void> {
  try {
    const info = await syncOp<DeviceInfo>("device_info");
    (
      el<HTMLElement>("self-device-id") as HTMLElement
    ).textContent = `${info.device_id.slice(0, 18)}…`;
    // Owner (smoke test 2026-08-27): the listening port is dev noise —
    // hidden from the UI (still available in logs/debug).
    const portEl = el<HTMLElement>("self-listen-port");
    if (portEl.parentElement) portEl.parentElement.hidden = true;
    const list = el<HTMLDivElement>("peers-list");
    list.innerHTML = "";
    if (info.paired_peers.length === 0) {
      list.innerHTML =
        '<p class="muted">No paired devices yet. Use “Show pairing code” on one device and paste it here on the other.</p>';
      return;
    }
    for (const p of info.paired_peers) {
      const row = document.createElement("div");
      row.className = "peer-row";
      const name = document.createElement("strong");
      name.textContent = p.display_name;
      const id = document.createElement("span");
      id.className = "muted";
      id.textContent = p.device_id.slice(0, 16) + "…";
      row.append(name, id);
      list.appendChild(row);
    }
  } catch (err) {
    console.warn("[tide] device_info unavailable:", err);
    el<HTMLElement>("self-device-id").textContent = "(shell unavailable)";
  }
}

async function showPairingCode(): Promise<void> {
  setBusy(true);
  try {
    const res = await syncOp<{ qr_text: string }>("pairing_offer", {});
    const out = el<HTMLTextAreaElement>("pairing-code-out");
    out.value = res.qr_text;
    setOfferPending(true); // supersede of an older offer keeps it visible
    log(`pairing offer created — paste the code on the other device.`);
  } catch (err) {
    setOfferPending(false);
    log(`pairing offer failed: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function acceptPairing(): Promise<void> {
  const input = el<HTMLTextAreaElement>("pairing-code-in");
  const text = input.value.trim();
  if (!text) return;
  setBusy(true);
  try {
    const res = await syncOp<{ peer_device_id: string; safety_number: string }>(
      "pairing_accept",
      { qr_text: text },
    );
    // Same human sees both screens on one machine in practice; still verify
    // numbers match when both sides run locally.
    log(
      `paired with ${res.peer_device_id.slice(0, 16)}… (safety ${res.safety_number})`,
    );
    input.value = "";
    setOfferPending(false); // successful pair closes the offer side too
    await renderDeviceInfo();
  } catch (err) {
    log(`pairing failed: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

function log(msg: string): void {
  const box = el<HTMLDivElement>("devices-log");
  const line = document.createElement("div");
  line.textContent = msg;
  box.prepend(line);
}

export function initDevices(): void {
  document
    .getElementById("btn-devices")
    ?.addEventListener("click", () => {
      dlg().showModal();
      void renderDeviceInfo();
    });
  document
    .getElementById("devices-close")
    ?.addEventListener("click", () => dlg().close());
  document
    .getElementById("btn-pairing-show")
    ?.addEventListener("click", () => void showPairingCode());
  document
    .getElementById("btn-pairing-accept")
    ?.addEventListener("click", () => void acceptPairing());
  document
    .getElementById("btn-pairing-cancel")
    ?.addEventListener("click", () => void cancelPairingOffer());
  // Closing the dialog hides a pending offer's Cancel affordance; the offer
  // itself is still torn down server-side (stdin-EOF shutdown).
  dlg()?.addEventListener("close", () => setOfferPending(false));
}
