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
  /** TD-005 lifecycle: epoch-ms of resolution; null/undefined = still active */
  resolved_at_hlc?: number | null;
  /** TD-005: why the row was resolved; null/undefined = still active */
  resolved_reason?: string | null;
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
  /** TD-005 remainder: short plain-language sentence for the reason code */
  reason_human: string;
  received_at_hlc: number;
  raw: string;
  /** TD-005: true once the row is resolved (archived, not deleted) */
  resolved: boolean;
  /** TD-005: resolution reason (e.g. "revalidated_on_restart"); null while active */
  resolved_reason: string | null;
}

/**
 * TD-005 remainder: plain-language sentences for the machine reason codes
 * validateChangeRecord emits. Codes arrive as
 * "invalid_change_record:<detail>" (see sync_engine's quarantine branch);
 * the bare detail and the bare code are also mapped. The technical code is
 * ALWAYS shown alongside the sentence — information is never hidden.
 * Unknown codes fall back to the code verbatim.
 */
const REASON_HINTS: Record<string, string> = {
  invalid_change_record: "The record failed validation for this version.",
  invalid_member_id:
    "The record contains a field this version doesn't recognize.",
  missing_field:
    "The record is missing a required field this version expects.",
  bad_seq: "The record's sequence number is missing or invalid.",
  bad_operation:
    "The record uses an operation this version doesn't recognize.",
  bad_entity_type:
    "The record has a data type this version doesn't recognize.",
  id_mismatch: "The record's ID doesn't match its contents.",
};

/**
 * TD-005 remainder: map a quarantine reason code to a short plain-language
 * sentence. Real codes emitted by the engine are
 * "invalid_change_record:" + the validator's error MESSAGE (e.g.
 * "invalid operation upsert"), so matching is keyword-based over the detail
 * part; exact short-code hits are tried first. The technical code is ALWAYS
 * shown alongside — information is never hidden. Unknown codes fall back to
 * the code itself — the UI never invents a meaning it doesn't have.
 */
export function humanReason(code: string): string {
  if (REASON_HINTS[code]) return REASON_HINTS[code]!;
  const m = /^invalid_change_record:(.+)$/.exec(code);
  if (!m) return code;
  const d = m[1]!;
  if (REASON_HINTS[d]) return REASON_HINTS[d]!; // short-code detail form
  if (/^invalid operation /.test(d)) {
    return "The record uses an operation this version doesn't recognize.";
  }
  if (/^invalid entity_type /.test(d)) {
    return "The record has a data type this version doesn't recognize.";
  }
  if (d.startsWith("change_id ") && d.includes("!=")) {
    return "The record's ID doesn't match its contents.";
  }
  if (d.includes("local_seq")) {
    return "The record's sequence number is missing or invalid.";
  }
  if (d.includes("non-finite number")) {
    return "The record contains a number this version can't represent.";
  }
  if (d.includes("causality_clock")) {
    return "The record's version information is malformed.";
  }
  if (d.includes("hlc_timestamp")) {
    return "The record's timestamp is missing or invalid.";
  }
  if (d.startsWith("invalid ")) {
    return "The record is missing a required field this version expects.";
  }
  return code; // unknown detail: fall back to the code VERBATIM
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
      reason_human: humanReason(r.quarantine_reason),
      received_at_hlc: r.received_at_hlc,
      raw: r.raw_record,
      resolved: r.resolved_at_hlc != null,
      resolved_reason: r.resolved_reason ?? null,
    };
  });
}

function dlg(): HTMLDialogElement {
  return document.getElementById("sync-errors-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

// ---------------------------------------------------------------------------
// TD-006 / DC-16 §4.1: per-peer misbehavior state in the Sync-Errors surface
// (extended badge/dialog, NOT a new screen). Level 0 peers add nothing —
// healthy peers stay silent (no noise).
// ---------------------------------------------------------------------------

/** Wire shape of one entry of the `peer_state` op result (sidecar). */
export interface PeerStateRow {
  device_id: string;
  level: number;
  recommend_unpair: boolean;
  window_invalid: number;
  window_total: number;
  window_ratio: number;
  dropped_while_throttled: number;
  paired: boolean;
  display_name: string | null;
  paired_at: number | null;
  ladder_label: string;
  hard_block: {
    first_triggered_at: number;
    last_triggered_at: number;
    trigger_count: number;
  } | null;
  tally: { total_invalid: number; last_invalid_at: number } | null;
}

/** One display row of the per-peer state section. */
export interface PeerStateView {
  device_id: string;
  display: string;
  /** DC-16 §3 ladder level 0-3 (+ hard-block flag rendered separately) */
  level: number;
  label: string;
  /** true when the peer must appear in the UI (Level 1+ or hard-blocked) */
  notable: boolean;
  /** human one-liner: level, window counts, drop counter, hard block */
  summary: string;
  /** L4 RECOMMENDATION only — never an executed state (DC-16 D7) */
  recommend_unpair: boolean;
}

/** Pure shaping (unit-testable without DOM). Verbatim numbers, no spin. */
export function shapePeerStates(rows: PeerStateRow[]): PeerStateView[] {
  return rows.map((r) => {
    const hardBlocked = r.hard_block !== null;
    const notable = r.level > 0 || hardBlocked;
    const parts: string[] = [];
    if (r.level > 0 || hardBlocked) {
      parts.push(`level ${r.level} (${r.ladder_label})`);
      parts.push(
        `window: ${r.window_invalid} invalid / ${r.window_total} received` +
          ` (${Math.round(r.window_ratio * 100)}%)`,
      );
      if (r.dropped_while_throttled > 0) {
        parts.push(`${r.dropped_while_throttled} dropped while throttled`);
      }
      if (hardBlocked && r.hard_block) {
        parts.push(
          `HARD BLOCKED since ${new Date(r.hard_block.first_triggered_at).toISOString()}` +
            ` (triggers: ${r.hard_block.trigger_count})`,
        );
      }
    }
    return {
      device_id: r.device_id,
      display:
        r.display_name ??
        (r.device_id.length > 16 ? r.device_id.slice(0, 16) + "…" : r.device_id),
      level: r.level,
      label: r.ladder_label,
      notable,
      summary: parts.join(" — "),
      recommend_unpair: r.recommend_unpair === true,
    };
  });
}

/** Render the per-peer state section (notable peers only; silence at L0). */
function renderPeerStates(): void {
  const box = el<HTMLDivElement>("peer-state-list");
  box.innerHTML = "";
  void (async () => {
    let rows: PeerStateRow[] = [];
    try {
      rows = (await syncOp<{ peers: PeerStateRow[] }>("peer_state")).peers;
    } catch {
      return; // shell unavailable: leave the section empty (honest degrade)
    }
    const views = shapePeerStates(rows).filter((v) => v.notable);
    if (views.length === 0) return; // DC-16 §4.1: Level 0 adds nothing
    const heading = document.createElement("h3");
    heading.textContent = "Peer state";
    box.appendChild(heading);
    for (const v of views) {
      const row = document.createElement("div");
      row.className = "sync-error-row peer-state-row";
      const name = document.createElement("strong");
      name.textContent = v.display;
      const state = document.createElement("code");
      state.className = "muted";
      state.textContent = v.summary;
      row.append(name, state);
      if (v.recommend_unpair) {
        const rec = document.createElement("div");
        rec.className = "muted";
        rec.textContent =
          "Recommendation: unpair this device via the pairing/revocation flow (requires your confirmation; nothing happens automatically).";
        row.appendChild(rec);
      }
      box.appendChild(row);
    }
  })();
}

async function fetchQuarantine(): Promise<{
  rows: QuarantineRow[];
  total: number;
}> {
  return syncOp<{ rows: QuarantineRow[]; total: number }>("list_quarantine");
}

interface QuarantineStats {
  active: number;
  resolved: number;
  total: number;
}

/**
 * TD-005: badge counts ACTIVE quarantine rows only — resolved rows are
 * archived diagnostics, not pending problems. Falls back to the pre-TD-005
 * total (list_quarantine) when the stats op is unavailable.
 */
async function fetchQuarantineStats(): Promise<QuarantineStats> {
  try {
    return await syncOp<QuarantineStats>("quarantine_stats");
  } catch {
    // Older sidecar without quarantine_stats: keep the badge working.
    const { total } = await fetchQuarantine();
    return { active: total, resolved: 0, total };
  }
}

/** Update the toolbar badge count (called on init + dialog close + syncs). */
export async function refreshSyncErrorsBadge(): Promise<void> {
  const btn = document.getElementById("btn-sync-errors");
  if (!btn) return;
  let stats: QuarantineStats;
  try {
    stats = await fetchQuarantineStats();
  } catch (err) {
    console.warn("[tide] quarantine stats unavailable:", err);
    el<HTMLElement>("sync-errors-count").textContent = "?";
    return;
  }
  el<HTMLElement>("sync-errors-count").textContent = String(stats.active);
  btn.title =
    stats.active > 0
      ? `${stats.active} active quarantined record(s)` +
        (stats.resolved > 0 ? `, ${stats.resolved} resolved` : "")
      : "No active quarantined records";
}

function renderList(rows: QuarantineRow[]): void {
  const list = el<HTMLDivElement>("sync-errors-list");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML =
      '<p class="muted">No quarantined records. Sync is healthy.</p>';
    return;
  }
  const views = shapeQuarantineRows(rows);
  const active = views.filter((v) => !v.resolved);
  const resolved = views.filter((v) => v.resolved);
  if (active.length === 0 && resolved.length > 0) {
    list.innerHTML =
      '<p class="muted">No active quarantined records. Sync is healthy.</p>';
  }
  for (const view of active) list.appendChild(renderErrorRow(view));
  if (resolved.length > 0) {
    // TD-005: resolved rows collapse under an archive section — visible,
    // searchable history, but out of the way of live problems.
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "muted";
    summary.textContent = `Resolved (${resolved.length})`;
    details.appendChild(summary);
    for (const view of resolved) details.appendChild(renderErrorRow(view));
    list.appendChild(details);
  }
}

function renderErrorRow(view: SyncErrorView): HTMLDivElement {
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
  reason.textContent = view.reason; // verbatim reason code — never hidden
  head.append(title, reason);

  // TD-005 remainder: plain-language sentence above the raw code.
  const human = document.createElement("div");
  human.className = "reason-human";
  human.textContent = view.reason_human;

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "raw metadata";
  const pre = document.createElement("pre");
  pre.textContent = view.raw;
  details.append(summary, pre);

  row.append(head, human, details);
  if (view.resolved) {
    // TD-005: show both the original quarantine reason (above) and how the
    // row was resolved. Archive only — no retry/delete actions exist.
    const res = document.createElement("div");
    res.className = "muted";
    res.textContent = `resolved: ${RESOLVED_HINTS[view.resolved_reason ?? ""] ?? view.resolved_reason ?? "unknown"}`;
    row.appendChild(res);
    return row;
  }

  // --- TD-005 remainder: per-item actions on ACTIVE rows only ------------
  const actions = document.createElement("div");
  actions.className = "sync-error-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.title = "Re-check this record now and apply it if it has become valid.";
  retry.addEventListener("click", () => {
    retry.disabled = true;
    retry.textContent = "Retrying…";
    void (async () => {
      let note: string;
      try {
        const r = await syncOp<{ outcome: string }>("retry_quarantine", {
          quarantine_id: view.quarantine_id,
        });
        note =
          r.outcome === "applied" || r.outcome === "duplicate"
            ? "Applied."
            : r.outcome === "buffered"
              ? "Still blocked by an earlier missing record."
              : "Still invalid — remains quarantined.";
      } catch (err) {
        note = `Retry failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const noteEl = document.createElement("span");
      noteEl.className = "muted";
      noteEl.textContent = note;
      actions.replaceChildren(noteEl);
      await refreshListAndBadge();
    })();
  });

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.title = "Give up on this record permanently.";
  del.addEventListener("click", () => {
    // DC-15 §3.5 two-step confirmation (destructive action):
    // state what happens, require an explicit second click.
    const warn = document.createElement("span");
    warn.className = "delete-warning";
    warn.textContent =
      "This record will be permanently discarded from this device. " +
      "It will NEVER be applied, and the sender will not be notified.";
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = "Confirm delete";
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      void (async () => {
        let note: string;
        try {
          await syncOp("delete_quarantine", {
            quarantine_id: view.quarantine_id,
            confirm: true, // explicit flag — the op refuses without it
          });
          note = "Record given up on. Later records from this device still sync.";
        } catch (err) {
          note = `Delete failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        const noteEl = document.createElement("span");
        noteEl.className = "muted";
        noteEl.textContent = note;
        actions.replaceChildren(noteEl);
        await refreshListAndBadge();
      })();
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      actions.replaceChildren(retry, del);
    });
    actions.replaceChildren(warn, confirmBtn, cancelBtn);
  });

  actions.append(retry, del);
  row.appendChild(actions);
  return row;
}

/** Plain-language labels for resolved_reason codes (verbatim fallback). */
const RESOLVED_HINTS: Record<string, string> = {
  revalidated_on_restart: "applied after re-validation",
  retried_by_user: "applied after you clicked Retry",
  user_deleted: "given up on by you (never applied)",
};

/** Re-render the dialog list + badge after a retry/delete action. */
async function refreshListAndBadge(): Promise<void> {
  try {
    renderList((await fetchQuarantine()).rows);
  } catch {
    /* leave the current list as-is */
  }
  await refreshSyncErrorsBadge();
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
        renderPeerStates(); // TD-006 §4.1: per-peer ladder / hard-block state
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
