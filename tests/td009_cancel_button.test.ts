// TD-009 regression test: the Cancel button for a pending pairing offer in
// the Devices dialog. Uses the same minimal in-file DOM stub pattern as
// month_view_clicks.test.ts, plus a mocked @tauri-apps/api/core so the real
// frontend/devices.ts code runs end to end:
//   * create code (pairing_offer resolves)  -> cancel button visible
//   * supersede (create a second offer)     -> cancel button still visible
//   * cancel click                          -> syncOp("cancel_pairing_offer"),
//                                              button hidden, "Pairing offer
//                                              cancelled" in devices-log
//   * cancel click with backend error       -> button stays visible, inline
//                                              error logged
//   * dialog close event                    -> button hidden
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

type Listener = (e: unknown) => void;

const byId = new Map<string, DomEl>();

class DomEl {
  hidden = false;
  value = "";
  textContent = "";
  children: DomEl[] = [];
  listeners = new Map<string, Set<Listener>>();

  appendChild(child: DomEl): DomEl {
    this.children.push(child);
    return child;
  }
  prepend(child: DomEl): void {
    this.children.unshift(child);
  }
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this });
  }
  querySelector(sel: string): DomEl {
    const id = sel.replace(/^#/, "");
    if (!byId.has(id)) byId.set(id, new DomEl());
    return byId.get(id)!;
  }
  showModal() {}
  close() {
    this.dispatch("close");
  }
}

function installDom(): void {
  byId.clear();
  (globalThis as { document?: unknown }).document = {
    createElement: () => new DomEl(),
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, new DomEl());
      return byId.get(id)!;
    },
  };
}

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = vi.mocked(invoke);

const prevDoc = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  installDom();
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  mockInvoke.mockReset();
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

async function initAndCreateOffer(): Promise<void> {
  const { initDevices } = await import("../frontend/devices.ts");
  initDevices();
  mockInvoke.mockResolvedValue({ qr_text: "PAIR-CODE" });
  byId.get("btn-pairing-show")!.dispatch("click");
  await vi.waitFor(() => {
    expect(mockInvoke).toHaveBeenCalledWith("sync_op", {
      op: "pairing_offer",
      args: {},
    });
  });
}

async function clickCancel(): Promise<void> {
  byId.get("btn-pairing-cancel")!.dispatch("click");
  await vi.waitFor(() => {
    expect(mockInvoke).toHaveBeenCalledWith("sync_op", {
      op: "cancel_pairing_offer",
      args: {},
    });
  });
}

function logText(): string {
  return byId
    .get("devices-log")!
    .children.map((c) => c.textContent)
    .join("\n");
}

describe("TD-009: pairing offer cancel button", () => {
  test("creating an offer shows the cancel button", async () => {
    await initAndCreateOffer();
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(false);
  });

  test("creating a second offer (supersede) keeps the cancel button", async () => {
    await initAndCreateOffer();
    byId.get("btn-pairing-show")!.dispatch("click");
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(false);
  });

  test("cancel click calls cancel_pairing_offer, hides button, logs", async () => {
    await initAndCreateOffer();
    await clickCancel();
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(true);
    expect(logText()).toContain("Pairing offer cancelled");
  });

  test("cancel click with backend error keeps button and logs inline", async () => {
    await initAndCreateOffer();
    mockInvoke.mockRejectedValue(new Error("sidecar gone"));
    await clickCancel();
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(false);
    expect(logText()).toContain("pairing offer cancel failed");
  });

  test("dialog close event hides the cancel button", async () => {
    await initAndCreateOffer();
    byId.get("devices-dialog")!.dispatch("close");
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(true);
  });
});
