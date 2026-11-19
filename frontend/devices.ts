// Tide Devices & Sync surface: device identity, paired peers, pairing
// ceremony entry points, and manual "Sync now".
//
// Data access goes through Tauri `sync_op` passthrough (typed commands may
// replace it later). In a plain browser (vite dev without the shell) this
// module degrades honestly: buttons are disabled with a note.
type Json = Record<string, unknown>;

import { invoke } from "@tauri-apps/api/core";
import { shortId, type PairedDeviceEntry } from "./device-label.ts";
import { createNameEditor } from "./name_editor.ts";

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
  /** DC-28 §4.9 views (label computed by the sidecar, §4.7). */
  paired_peers: Array<PairedDeviceEntry & { short_id: string; paired_at: number }>;
  listening_port: number;
}

/** DC-28 own name as the shell stores it (config.toml "device_name", P9). */
export interface OwnDeviceName {
  device_name: string | null;
  /** P2: OS-family suggestion ("Linux PC", "Windows PC"); never the hostname. */
  suggestion: string;
}

/** DC-28 §4.3 (P3): the help text IS the consent statement. */
export const OWN_NAME_HELP = "Shown on devices you pair with from now on.";

/** Text of the "This device:" line's name part (P11: only place it shows). */
export function ownNameLineText(name: string | null): string {
  return name ?? "No name yet";
}

async function getOwnName(): Promise<OwnDeviceName> {
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    throw new Error("not running inside the Tide desktop shell");
  }
  return (await invoke("get_device_name")) as OwnDeviceName;
}

async function renderOwnName(): Promise<void> {
  const nameEl = el<HTMLElement>("self-device-name");
  try {
    const own = await getOwnName();
    nameEl.textContent = ownNameLineText(own.device_name);
    nameEl.classList.toggle("muted", own.device_name === null);
  } catch (err) {
    console.warn("[tide] get_device_name unavailable:", err);
    nameEl.textContent = ownNameLineText(null);
  }
}

/**
 * DC-28 §4.4: edit the own name in place. Pre-filled with the saved name,
 * or with the P2 OS-family SUGGESTION, which is saved only on Save.
 */
async function openOwnNameEditor(): Promise<void> {
  const host = el<HTMLDivElement>("self-name-editor");
  if (host.childElementCount > 0) return; // already open
  let own: OwnDeviceName = { device_name: null, suggestion: "" };
  try {
    own = await getOwnName();
  } catch (err) {
    log(`rename unavailable: ${String(err)}`);
    return;
  }
  const editor = createNameEditor({
    initial: own.device_name ?? own.suggestion,
    help: OWN_NAME_HELP,
    save: async (value) => {
      await invoke("set_device_name", { name: value });
    },
    close: () => {
      host.textContent = "";
      void renderOwnName();
    },
  });
  host.appendChild(editor);
  editor.querySelector("input")?.focus();
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

/**
 * The single text for every refused or ended pairing code (older format,
 * expired, used up, ended after wrong attempts, malformed). Mirrors
 * PAIRING_CODE_INVALID_MESSAGE in the backend.
 */
export const CODE_INVALID_TEXT = "This pairing code is no longer valid. Create a new one.";

/** The other device could not be reached (mirrors PAIRING_UNREACHABLE_MESSAGE). */
export const UNREACHABLE_TEXT =
  "The other device could not be reached. Check that both devices are on the same network, then try again.";

/** How often the shown code's state is checked while the dialog is open. */
export const OFFER_POLL_MS = 2000;
let offerPoll: ReturnType<typeof setTimeout> | null = null;

function stopOfferPoll(): void {
  if (offerPoll !== null) clearTimeout(offerPoll);
  offerPoll = null;
}

function scheduleOfferPoll(): void {
  stopOfferPoll();
  offerPoll = setTimeout(() => void pollOffer(), OFFER_POLL_MS);
}

/** The shown code is dead: remove it (it carries a one-time secret). */
function clearShownCode(): void {
  const out = el<HTMLTextAreaElement>("pairing-code-out");
  if (out) out.value = "";
  setOfferPending(false);
}

/**
 * Check the shown code once. An ended offer (too many wrong attempts, or
 * its lifetime ran out, or a failed pairing) replaces the code with the
 * single text; a completed pairing refreshes the list. Runs only while the
 * dialog is open.
 */
export async function pollOffer(): Promise<void> {
  offerPoll = null;
  if (!dlg()?.open) return;
  let status: unknown;
  try {
    status = (await syncOp<{ status?: unknown }>("pairing_offer_status")).status;
  } catch {
    status = undefined; // try again on the next tick
  }
  if (status === "ended") {
    clearShownCode();
    log(CODE_INVALID_TEXT);
    return;
  }
  if (status === "paired") {
    clearShownCode();
    await renderDeviceInfo();
    return;
  }
  if (status === "cancelled" || status === "none") {
    clearShownCode();
    return;
  }
  scheduleOfferPoll(); // open, pairing, or not readable right now
}

async function cancelPairingOffer(): Promise<void> {
  setBusy(true);
  try {
    await syncOp("cancel_pairing_offer", {});
    stopOfferPoll();
    clearShownCode();
    log(`Pairing offer cancelled`);
  } catch (err) {
    log(`pairing offer cancel failed: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function renderDeviceInfo(): Promise<void> {
  try {
    void renderOwnName();
    const info = await syncOp<DeviceInfo>("device_info");
    // DC-28 §4.7: the short id, a complete token (no "...", TD-032).
    el<HTMLElement>("self-device-id").textContent = shortId(info.device_id);
    // Owner (smoke test 2026-08-27): the listening port is dev noise —
    // hidden from the UI (still available in logs/debug).
    const portEl = el<HTMLElement>("self-listen-port");
    if (portEl.parentElement) portEl.parentElement.hidden = true;
    const list = el<HTMLDivElement>("peers-list");
    list.textContent = "";
    if (info.paired_peers.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent =
        "No paired devices yet. Use “Show pairing code” on one device and paste it here on the other.";
      list.appendChild(p);
      return;
    }
    for (const p of info.paired_peers) {
      const row = document.createElement("div");
      row.className = "peer-row";
      const name = document.createElement("strong");
      name.textContent = p.label; // DC-28 §4.8: untrusted text, textContent only
      const id = document.createElement("span");
      id.className = "muted";
      id.textContent = `id ${shortId(p.device_id)}`;
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
    scheduleOfferPoll();
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
    // numbers match when both sides run locally. DC-28 §4.10: the label of
    // the new peer, never a truncated id.
    log(`paired with ${await peerLabel(res.peer_device_id)} (safety ${res.safety_number})`);
    input.value = "";
    setOfferPending(false); // successful pair closes the offer side too
    await renderDeviceInfo();
  } catch (err) {
    // DC-27 P10: a refused re-pair of an unpaired device shows the exact
    // sentence; every refused code shows the single code text. Both are
    // own local texts, never peer-supplied.
    const text = String(err);
    log(
      text.includes(REVOKED_REPAIR_TEXT)
        ? REVOKED_REPAIR_TEXT
        : text.includes(CODE_INVALID_TEXT)
          ? CODE_INVALID_TEXT
          : text.includes(UNREACHABLE_TEXT)
            ? UNREACHABLE_TEXT
            : `pairing failed: ${text}`,
    );
  } finally {
    setBusy(false);
  }
}

/** DC-28 §4.7 label of one paired peer; "Device <short id>" if unknown. */
async function peerLabel(deviceId: string): Promise<string> {
  try {
    const info = await syncOp<DeviceInfo>("device_info");
    const hit = info.paired_peers.find((p) => p.device_id === deviceId);
    if (hit && hit.label) return hit.label;
  } catch {
    /* fall through to the short id */
  }
  return `Device ${shortId(deviceId)}`;
}

/** DC-27 §4.13 P10 wording (mirrors REVOKED_REPAIR_MESSAGE in the sidecar). */
export const REVOKED_REPAIR_TEXT =
  "This device was unpaired earlier. To pair it again, start it fresh first.";

function log(msg: string): void {
  const box = el<HTMLDivElement>("devices-log");
  const line = document.createElement("div");
  line.textContent = msg;
  box.prepend(line);
}

// ---------------------------------------------------------------------------
// DC-24 §6.4 (2026-10-12): Windows firewall degraded-mode notice + Try again.
// The Rust shell emits tide://firewall-degraded when the firewall ruleset
// could not be established; this surfaces a persistent, dismissible notice
// in the Devices & Sync dialog with an explicit Try again button that
// invokes the retry_firewall command. Never auto-retries (§6.4: re-attempts
// only at the user's explicit action).
// ---------------------------------------------------------------------------

async function retryFirewall(): Promise<void> {
  const notice = document.getElementById("firewall-notice");
  const text = document.getElementById("firewall-notice-text");
  const btn = document.getElementById("firewall-retry") as HTMLButtonElement | null;
  setBusy(true);
  if (btn) btn.disabled = true;
  try {
    if (!("__TAURI_INTERNALS__" in globalThis)) throw new Error("not in shell");
    const { invoke } = await import("@tauri-apps/api/core");
    const ok = (await invoke("retry_firewall")) as boolean;
    if (ok) {
      notice!.hidden = true;
      log("Firewall: rules established — sync enabled.");
    } else {
      text!.textContent = FIREWALL_STILL_DEGRADED;
    }
  } catch (err) {
    text!.textContent = `${FIREWALL_STILL_DEGRADED} (${String(err)})`;
  } finally {
    setBusy(false);
    if (btn) btn.disabled = false;
  }
}

const FIREWALL_STILL_DEGRADED =
  "Windows Firewall rules could still not be created. Sync stays off until the rules exist.";

function wireFirewallNotice(): void {
  document
    .getElementById("firewall-retry")
    ?.addEventListener("click", () => void retryFirewall());
  // Listen for the shell's degraded event; show the notice with the
  // message text from the shell. Browser dev (no shell) never fires it.
  if ("__TAURI_INTERNALS__" in globalThis) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("tide://firewall-degraded", (ev) => {
          const notice = document.getElementById("firewall-notice");
          const text = document.getElementById("firewall-notice-text");
          if (notice && text) {
            text.textContent = ev.payload;
            notice.hidden = false;
          }
        }),
      )
      .catch((err) => console.warn("[tide] event listen unavailable:", err));
  }
}

export function initDevices(): void {
  document
    .getElementById("btn-devices")
    ?.addEventListener("click", () => {
      dlg().showModal();
      void renderDeviceInfo();
      // A code still shown from before: check whether it is still valid.
      if (el<HTMLTextAreaElement>("pairing-code-out")?.value) void pollOffer();
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
  document
    .getElementById("btn-rename-self")
    ?.addEventListener("click", () => void openOwnNameEditor());
  // Closing the dialog hides a pending offer's Cancel affordance; the offer
  // itself is still torn down server-side (stdin-EOF shutdown).
  dlg()?.addEventListener("close", () => {
    stopOfferPoll();
    setOfferPending(false);
    const host = document.getElementById("self-name-editor");
    if (host) host.textContent = ""; // an unsaved rename is discarded
  });
  wireFirewallNotice();
}
