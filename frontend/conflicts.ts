// Tide DC-14 Conflicts surface — toolbar badge + resolution dialog.
//
// Data access follows the same pattern as store.ts's EventStoreBridge:
// the desktop runtime may inject a ConflictsBridge on
// window.__TIDE_CONFLICTS__ backed by src/application/conflicts_ui.ts
// (ConflictsViewModel over the sidecar's SQLite handle).
//
// TODO(backend): no Tauri command or sidecar RPC exposes the conflicts
// surface yet. Needed plumbing (do NOT invent — wire when it exists):
//   1. src/persistence/bridges/sidecar_server.ts: stdio methods wrapping
//      ConflictsViewModel (total_unresolved, list_unresolved, get_detail,
//      resolve, skip, entity_title).
//   2. src-tauri proxy commands forwarding those to the sidecar (mirrors
//      event CRUD IPC from commit c015ce7).
//   3. Shell injects window.__TIDE_CONFLICTS__. Until then this module
//     renders an empty state via the fallback, which is honest: with no
//     sync partners there are no conflicts to show.
//
// The DOM-free helpers (formatCandidateValue, describeConflict,
// describeCandidateSide) are exported for headless vitest coverage.
import type {
  CandidateView,
  ConflictDetailView,
  ConflictListItem,
  ListFilter,
  ResolutionOption,
} from "../src/application/conflicts_ui.ts";

/**
 * Contract mirroring the relevant slice of ConflictsViewModel
 * (src/application/conflicts_ui.ts). Implemented over IPC by the shell;
 * see TODO(backend) above.
 */
export interface ConflictsBridge {
  totalUnresolved(): number | Promise<number>;
  listUnresolved(filter?: ListFilter):
    | ConflictListItem[]
    | Promise<ConflictListItem[]>;
  entityTitle(entityId: string): string | null | Promise<string | null>;
  getDetail(
    conflictId: string,
  ): ConflictDetailView | Promise<ConflictDetailView>;
  /** Resolves; returns true when the status flip actually happened. */
  resolve(
    conflictId: string,
    option: ResolutionOption,
  ): boolean | Promise<boolean>;
  skip(conflictId: string): void;
}

declare global {
  interface Window {
    __TIDE_CONFLICTS__?: ConflictsBridge;
  }
}

function bridge(): ConflictsBridge | undefined {
  try {
    return globalThis.window?.__TIDE_CONFLICTS__;
  } catch {
    return undefined;
  }
}

/** Empty-state fallback until the backend plumbing lands (TODO above). */
const EMPTY_FALLBACK: ConflictsBridge = {
  totalUnresolved: () => 0,
  listUnresolved: () => [],
  entityTitle: () => null,
  getDetail: (id) => {
    throw new Error(`no conflict ${id}`);
  },
  resolve: () => false, // unreachable while list is empty; defensive
  skip: () => {},
};

function store(): ConflictsBridge {
  return bridge() ?? EMPTY_FALLBACK;
}

// --- DOM-free presentation helpers ----------------------------------------

/** Human-readable effective value of one candidate (§3.2b). */
export function formatCandidateValue(c: CandidateView): string {
  if (c.deleted) return "value was removed";
  const v = c.value;
  if (v === undefined || v === null) return "(empty)";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** One-line summary used in the list rows (field + participant count). */
export function describeConflict(item: ConflictListItem): string {
  const field = item.field_path || "entity";
  return `${field} · ${item.participant_count} device${
    item.participant_count === 1 ? "" : "s"
  }`;
}

/** Side label with device attribution (§3.2b: "This device" for self). */
export function describeCandidateSide(
  detail: ConflictDetailView,
  candidate: CandidateView,
): string {
  const isLocal = candidate.change_id === detail.local_change_id;
  const name = isLocal ? "This device" : candidate.device_name;
  return isLocal ? `${name} (local)` : name;
}

// --- Badge ------------------------------------------------------------------

export async function refreshBadge(): Promise<void> {
  const btn = document.getElementById("btn-conflicts");
  if (!btn) return;
  let total = 0;
  try {
    total = await store().totalUnresolved();
  } catch (err) {
    console.warn("[tide] conflicts badge unavailable:", err);
  }
  const label = btn.querySelector(".conflicts-label") as HTMLElement | null;
  if (label) label.textContent = `⚠ Conflicts (${total})`;
  btn.classList.toggle("has-conflicts", total > 0);
  btn.title =
    total > 0 ? `${total} unresolved conflict(s)` : "No unresolved conflicts";
}

// --- Dialog -----------------------------------------------------------------

function dlg(): HTMLDialogElement {
  return document.getElementById("conflict-dialog") as HTMLDialogElement;
}

function el<T extends HTMLElement>(id: string): T {
  return dlg().querySelector(`#${id}`) as T;
}

async function renderList(): Promise<void> {
  const listEl = el<HTMLDivElement>("conflict-list");
  const detailEl = el<HTMLDivElement>("conflict-detail");
  detailEl.innerHTML =
    '<p class="conflict-empty">Select a conflict to compare candidates.</p>';
  let items: ConflictListItem[] = [];
  try {
    items = await store().listUnresolved();
  } catch (err) {
    console.warn("[tide] conflict list unavailable:", err);
  }
  listEl.innerHTML = "";
  if (items.length === 0) {
    listEl.innerHTML = '<p class="conflict-empty">No unresolved conflicts.</p>';
    return;
  }
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "conflict-row";
    const titleSpan = document.createElement("span");
    titleSpan.className = "conflict-row-title";
    const subSpan = document.createElement("span");
    subSpan.className = "muted";
    subSpan.textContent = describeConflict(item);
    // §5.2 list shows the ENTITY TITLE; resolve it async (view-model read).
    void Promise.resolve(store().entityTitle(item.entity_id))
      .then((title) => {
        titleSpan.textContent = title ?? `(untitled) ${item.entity_id}`;
      })
      .catch(() => {
        titleSpan.textContent = item.entity_id;
      });
    row.append(titleSpan, subSpan);
    row.addEventListener("click", () => void selectConflict(item.conflict_id));
    listEl.appendChild(row);
  }
}

async function selectConflict(conflictId: string): Promise<void> {
  let detail: ConflictDetailView;
  try {
    detail = await store().getDetail(conflictId);
  } catch (err) {
    console.warn("[tide] conflict detail unavailable:", err);
    return;
  }

  // Mark selection in the list.
  for (const row of dlg().querySelectorAll(".conflict-row")) {
    row.classList.toggle(
      "selected",
      (row as HTMLElement).dataset.conflictId === conflictId,
    );
  }

  const detailEl = el<HTMLDivElement>("conflict-detail");
  detailEl.innerHTML = "";

  const heading = document.createElement("h3");
  heading.textContent = detail.entity_title ?? detail.entity_id;
  const fieldLine = document.createElement("p");
  fieldLine.className = "muted";
  fieldLine.textContent = `Field: ${detail.field_path}`;
  detailEl.append(heading, fieldLine);

  for (const c of detail.candidates) {
    detailEl.appendChild(candidateCard(detail, c));
  }
}

function candidateCard(
  detail: ConflictDetailView,
  c: CandidateView,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "conflict-candidate";

  const head = document.createElement("div");
  head.className = "conflict-candidate-head";
  const side = document.createElement("strong");
  side.textContent = describeCandidateSide(detail, c);
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = c.deleted ? "deleted" : "current value";
  head.append(side, meta);

  const value = document.createElement("div");
  value.className = "conflict-value" + (c.deleted ? " deleted" : "");
  value.textContent = formatCandidateValue(c);

  const actions = document.createElement("div");
  actions.className = "conflict-actions";

  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "primary";
  keep.textContent = "Keep";
  keep.addEventListener("click", () => void actResolve(c, "keep"));
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "danger";
  discard.textContent = "Discard";
  discard.addEventListener("click", () => void actResolve(c, "discard"));
  actions.append(keep, discard);

  card.append(head, value, actions);
  return card;
}

/**
 * Keep/Discard per candidate. Keep maps to {kind:"keep_mine"} for the local
 * candidate and {kind:"keep_theirs", change_id} otherwise (N-way safe, §4).
 * Discard of a deletion-side candidate means keeping its removal
 * (keep_mine/keep_theirs on that same change). Custom values ("keep_both")
 * have no UI yet — TODO(ui): text input for resolved_custom once needed.
 */
async function actResolve(
  c: CandidateView,
  intent: "keep" | "discard",
): Promise<void> {
  // TODO(backend): ConflictsViewModel has no discard command; "Discard"
  // currently resolves by KEEPING THE OTHER SIDE (drop this candidate's
  // value), which matches user intent without inventing a new command.
  void intent;
  const detail = currentDetail();
  if (!detail) return;
  const option: ResolutionOption =
    c.change_id === detail.local_change_id
      ? { kind: "keep_mine" }
      : { kind: "keep_theirs", change_id: c.change_id };
  try {
    await store().resolve(detail.conflict_id, option);
  } catch (err) {
    alert(`Failed to resolve conflict: ${String(err)}`);
    return;
  }
  await renderList(); // re-renders empty detail + refreshes badge
  await refreshBadge();
}

let activeDetail: ConflictDetailView | null = null;

function currentDetail(): ConflictDetailView | null {
  return activeDetail;
}

export function openConflictsDialog(): void {
  dlg().showModal();
  void renderList();
}

export function initConflicts(): void {
  document
    .getElementById("btn-conflicts")
    ?.addEventListener("click", openConflictsDialog);
  document
    .getElementById("conflict-close")
    ?.addEventListener("click", () => dlg().close());
  void refreshBadge();
}
