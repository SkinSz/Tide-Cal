// Tide TD-001 §2 Option A "Sync Errors" surface: badge + read-only dialog
// listing durable quarantine rows. Diagnostics ONLY — no per-item retry or
// delete exists anywhere in this module (by design; DC-04 §4.3b/TR-10).
//
// Reason codes are shown VERBATIM; raw metadata is expandable via <details>.
// Data comes through the Tauri `sync_op` passthrough (no new Rust commands).
import { syncOp } from "./devices.ts";

export interface QuarantineRow {
  quarantine_id: number;
  quarantine_reason: string;
  received_at_hlc: number;
  sender_device_id: string;
  raw_record: string;
}

/** One display row of the Sync Errors dialog. */
export interface SyncErrorView {
  quarantine_id: number;
  /** producer id truncated for display ("" when unparsable) */
  producer: string;
  /** producer local_seq parsed out of raw_record (-1 when unparsable) */
  seq: number;
  /** reason code VERBATIM (never interpreted/reworded) */
  reason: string;
  received_at_hlc: number;
  raw: string;
}

/**
 * Pure shaping of quarantine rows for display (unit-testable without DOM).
 * Nothing here interprets the record — producer/seq are read from the raw
 * record when it is shape-compatible, else shown as unavailable.
 */
export function shapeQuarantineRows(rows: QuarantineRow[]): SyncErrorView[] {
  return rows.map((r) => {
    let producer = "";
    let seq = -1;
    try {
      const raw = JSON.parse(r.raw_record) as {
        device_id?: unknown;
        local_seq?: unknown;
      };
      if (typeof raw.device_id === "string") producer = raw.device_id;
      if (typeof raw.local_seq === "number" && Number.isInteger(raw.local_seq)) {
        seq = raw.local_seq;
      }
    } catch {
      /* unparsable raw record: show placeholders, raw JSON stays expandable */
    }
    return {
      quarantine_id: r.quarantine_id,
      producer: producer ? producer.slice(0, 16) + "…" : "(unknown)",
      seq,
      reason: r.quarantine_reason,
      received_at_hlc: r.received_at_hlc,
      raw: r.raw_record,
    };
  });
}

function dlg(): HTMLDialogElement {
  return document.getElementById("sync-errors-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

async function fetchQuarantine(): Promise<{
  rows: QuarantineRow[];
  total: number;
}> {
  return syncOp<{ rows: QuarantineRow[]; total: number }>("list_quarantine");
}

/** Update the toolbar badge count (called on init + dialog close + syncs). */
export async function refreshSyncErrorsBadge(): Promise<void> {
  const btn = document.getElementById("btn-sync-errors");
  if (!btn) return;
  let total = 0;
  try {
    total = (await fetchQuarantine()).total;
  } catch (err) {
    console.warn("[tide] list_quarantine unavailable:", err);
    el<HTMLElement>("sync-errors-count").textContent = "?";
    return;
  }
  el<HTMLElement>("sync-errors-count").textContent = String(total);
  btn.title =
    total > 0
      ? `${total} quarantined record(s)`
      : "No quarantined records";
}

function renderList(rows: QuarantineRow[]): void {
  const list = el<HTMLDivElement>("sync-errors-list");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML =
      '<p class="muted">No quarantined records. Sync is healthy.</p>';
    return;
  }
  for (const view of shapeQuarantineRows(rows)) {
    const row = document.createElement("div");
    row.className = "sync-error-row";

    const head = document.createElement("div");
    head.className = "peer-row";
    const title = document.createElement("strong");
    title.textContent = `#${view.quarantine_id} — ${view.producer} seq ${
      view.seq >= 0 ? String(view.seq) : "?"
    }`;
    const reason = document.createElement("code");
    reason.className = "muted";
    reason.textContent = view.reason; // verbatim reason code
    head.append(title, reason);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "raw metadata";
    const pre = document.createElement("pre");
    pre.textContent = view.raw;
    details.append(summary, pre);

    row.append(head, details);
    list.appendChild(row);
  }
}

export function initSyncErrors(): void {
  document
    .getElementById("btn-sync-errors")
    ?.addEventListener("click", () => {
      void (async () => {
        try {
          renderList((await fetchQuarantine()).rows);
        } catch (err) {
          console.warn("[tide] list_quarantine unavailable:", err);
          renderList([]);
        }
        dlg().showModal();
      })();
    });
  document
    .getElementById("sync-errors-close")
    ?.addEventListener("click", () => {
      dlg().close();
      void refreshSyncErrorsBadge();
    });
  // Refresh the badge after any manual sync completes (devices/sync flows
  // dispatch this event; safe no-op when nothing dispatches it).
  document.addEventListener("tide:sync-done", () => {
    void refreshSyncErrorsBadge();
  });
  void refreshSyncErrorsBadge();
}
