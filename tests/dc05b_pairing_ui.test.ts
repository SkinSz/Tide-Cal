// DC-05 Appendix B (P7/P8/P13) in the Devices dialog: the single text for a
// refused code on the scanner side, and the displayer's code replaced by the
// same text once its offer ended. Text-only rendering (textContent/value).
// Same minimal DOM stub as tests/td009_cancel_button.test.ts.
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
const P13 = "This pairing code is no longer valid. Create a new one.";

beforeEach(() => {
  installDom();
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  mockInvoke.mockReset();
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

const logLines = () => byId.get("devices-log")!.children.map((c) => c.textContent);
type Args = { op: string };
function route(table: Record<string, unknown | (() => unknown)>): void {
  mockInvoke.mockImplementation(async (_cmd: string, a?: unknown) => {
    const op = (a as Args | undefined)?.op ?? _cmd;
    const v = table[op];
    if (v instanceof Error) throw v;
    return typeof v === "function" ? (v as () => unknown)() : (v ?? {});
  });
}

describe("DC-05 B.10 P13 in the pairing UI", () => {
  test("P13 scanner side: a refused code shows exactly the single text", async () => {
    const { initDevices } = await import("../frontend/devices.ts");
    initDevices();
    // the shell passes the sidecar's error message through as a string
    route({ pairing_accept: () => Promise.reject(P13) });
    (document as unknown as { getElementById(id: string): DomEl }).getElementById("pairing-code-in").value = '{"v":1}';
    byId.get("btn-pairing-accept")!.dispatch("click");
    await vi.waitFor(() => expect(logLines()).toContain(P13));
    expect(logLines().some((l) => l.startsWith("pairing failed"))).toBe(false);
  });

  test("P7/P8 displayer side: an ended offer clears the code and shows the single text", async () => {
    vi.useFakeTimers();
    const mod = await import("../frontend/devices.ts");
    mod.initDevices();
    (byId.get("devices-dialog") as unknown as { open: boolean }).open = true;
    let status = "open";
    route({ pairing_offer: { qr_text: "CODE-WITH-SECRET" }, pairing_offer_status: () => ({ status }) });
    byId.get("btn-pairing-show")!.dispatch("click");
    await vi.waitFor(() => expect(byId.get("pairing-code-out")!.value).toBe("CODE-WITH-SECRET"));
    await vi.advanceTimersByTimeAsync(mod.OFFER_POLL_MS);
    expect(byId.get("pairing-code-out")!.value).toBe("CODE-WITH-SECRET"); // still open
    status = "ended";
    await vi.advanceTimersByTimeAsync(mod.OFFER_POLL_MS);
    expect(byId.get("pairing-code-out")!.value).toBe("");
    expect(byId.get("btn-pairing-cancel")!.hidden).toBe(true);
    expect(logLines()[0]).toBe(P13);
    const polls = mockInvoke.mock.calls.filter((c) => (c[1] as Args | undefined)?.op === "pairing_offer_status").length;
    await vi.advanceTimersByTimeAsync(mod.OFFER_POLL_MS * 3);
    expect(mockInvoke.mock.calls.filter((c) => (c[1] as Args | undefined)?.op === "pairing_offer_status").length).toBe(polls); // polling stopped
  });

  test("polling runs only while the dialog is open", async () => {
    vi.useFakeTimers();
    const mod = await import("../frontend/devices.ts");
    mod.initDevices();
    route({ pairing_offer: { qr_text: "C" }, pairing_offer_status: { status: "ended" } });
    byId.get("btn-pairing-show")!.dispatch("click");
    await vi.waitFor(() => expect(byId.get("pairing-code-out")!.value).toBe("C"));
    await vi.advanceTimersByTimeAsync(mod.OFFER_POLL_MS * 2); // dialog not open
    expect(mockInvoke.mock.calls.some((c) => (c[1] as Args | undefined)?.op === "pairing_offer_status")).toBe(false);
  });

  test("the UI texts equal the backend constants", async () => {
    const ui = await import("../frontend/devices.ts");
    const be = await import("../src/network/pairing_manager.ts");
    expect(ui.CODE_INVALID_TEXT).toBe(be.PAIRING_CODE_INVALID_MESSAGE);
    expect(ui.UNREACHABLE_TEXT).toBe(be.PAIRING_UNREACHABLE_MESSAGE);
  });

  test("unreachable: the plain sentence is shown exactly, no raw error or address", async () => {
    const { initDevices, UNREACHABLE_TEXT } = await import("../frontend/devices.ts");
    initDevices();
    route({ pairing_accept: () => Promise.reject(UNREACHABLE_TEXT) });
    (document as unknown as { getElementById(id: string): DomEl }).getElementById("pairing-code-in").value = "code";
    byId.get("btn-pairing-accept")!.dispatch("click");
    await vi.waitFor(() => expect(logLines()).toContain(UNREACHABLE_TEXT));
    expect(logLines().some((l) => l.startsWith("pairing failed"))).toBe(false);
  });
});
