// DC-26 §3.3: redraw the calendar after a sync changed local data.
//
// A pure scheduler (no DOM, no Tauri) so the coalescing and edit-safety
// rules are unit-testable (tests/data_refresh.test.ts). The wiring at the
// bottom connects it to the shell event and the real redraw.

/** DC-26 P3 (owner, 2026-11-14): 1.5 s of quiet before redrawing. */
export const REFRESH_QUIET_MS = 1500;

export interface RefreshDeps {
  quietMs: number;
  /** True while an editor/dialog is open (no redraw underneath it). */
  isEditing: () => boolean;
  /** Re-read and redraw the current view + conflicts badge. */
  refresh: () => void | Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface RefreshScheduler {
  /** A data notice arrived. */
  notify(): void;
  /** An editor/dialog closed: run a refresh that was held back. */
  editorClosed(): void;
}

export function createRefreshScheduler(deps: RefreshDeps): RefreshScheduler {
  let pending = false;
  let timer: unknown = undefined;

  const fire = (): void => {
    timer = undefined;
    if (!pending) return;
    if (deps.isEditing()) return; // stays pending until editorClosed()
    pending = false;
    void deps.refresh();
  };

  return {
    notify(): void {
      pending = true;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = deps.setTimer(fire, deps.quietMs);
    },
    editorClosed(): void {
      // Only act on a held-back refresh; while the quiet timer still runs,
      // it will fire on its own.
      if (pending && timer === undefined && !deps.isEditing()) {
        pending = false;
        void deps.refresh();
      }
    },
  };
}

/**
 * Wire DC-26 into the main window: listen for the shell's
 * tide://data-changed event and redraw via `refresh`. A no-op outside the
 * desktop shell (plain browser / tests).
 */
export function initDataRefresh(
  refresh: () => void | Promise<void>,
  isDragging: () => boolean = () => false,
): void {
  const scheduler = createRefreshScheduler({
    quietMs: REFRESH_QUIET_MS,
    // A drag counts as an edit in progress (review MINOR-2): redrawing
    // would rebuild the drop targets under the cursor and lose the move.
    isEditing: () => document.querySelector("dialog[open]") !== null || isDragging(),
    refresh,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  // <dialog> "close" does not bubble; a capturing listener still sees it.
  document.addEventListener("close", () => scheduler.editorClosed(), true);
  // A drag that ends releases a held-back refresh the same way. Deferred
  // one tick so the drop handler's own write + render go first.
  document.addEventListener("dragend", () => setTimeout(() => scheduler.editorClosed(), 0), true);
  if ("__TAURI_INTERNALS__" in globalThis) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("tide://data-changed", () => scheduler.notify()))
      .catch((err) => console.warn("[tide] data-change listen unavailable:", err));
  }
}
