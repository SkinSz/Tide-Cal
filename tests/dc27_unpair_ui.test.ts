// DC-27 TR-4 (UI half) + P1/P6/P8 wording: the Paired Devices Unpair flow
// driven through a minimal in-test DOM (the repo ships no jsdom/happy-dom).
// Two clicks are needed (open the panel, then "Unpair <label>"); Cancel,
// another row action, and any re-render return the flow to idle.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls: Array<{ op: string; args: unknown }> = [];
let devices: Array<Record<string, unknown>> = [];
let removed: Array<Record<string, unknown>> = [];
let unpairResult: () => Promise<unknown> = async () => ({ ok: true, already: false });

vi.mock("../frontend/devices.ts", () => ({
  syncOp: vi.fn(async (op: string, args?: Record<string, unknown>) => {
    calls.push({ op, args });
    if (op === "list_paired_devices") return { devices };
    if (op === "list_removed_devices") return { removed };
    if (op === "unpair_device") return unpairResult();
    if (op === "reset_peer_state") return { ok: true };
    return null;
  }),
}));

// --- minimal DOM -----------------------------------------------------------
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  id = "";
  type = "";
  className = "";
  title = "";
  hidden = false;
  disabled = false;
  private ownText = "";
  private handlers: Record<string, Array<() => void>> = {};
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = v;
  }
  set innerHTML(v: string) {
    this.textContent = v;
  }
  addEventListener(ev: string, fn: () => void): void {
    (this.handlers[ev] ??= []).push(fn);
  }
  click(): void {
    if (this.disabled) return;
    for (const fn of this.handlers.click ?? []) fn();
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  appendChild(n: FakeEl): FakeEl {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  showModal(): void {}
  close(): void {}
  all(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  private matches(sel: string): boolean {
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith(".")) return this.className.split(/\s+/).includes(sel.slice(1));
    return this.tagName === sel;
  }
  querySelector(sel: string): FakeEl | null {
    return this.all().find((e) => e.matches(sel)) ?? null;
  }
}
function el(tag: string, id = ""): FakeEl {
  const e = new FakeEl(tag);
  e.id = id;
  return e;
}

const dialog = el("dialog", "paired-devices-dialog");
const list = el("div", "paired-devices-list");
const section = el("section", "removed-devices-section");
const removedList = el("div", "removed-devices-list");
section.appendChild(removedList);
dialog.append(list, section);
const opener = el("button", "btn-paired-devices");
const closer = el("button", "paired-devices-close");
const byId: Record<string, FakeEl> = {
  "paired-devices-dialog": dialog,
  "btn-paired-devices": opener,
  "paired-devices-close": closer,
};
vi.stubGlobal("document", {
  getElementById: (id: string) => byId[id] ?? null,
  createElement: (tag: string) => el(tag),
});

const {
  initPairedDevices,
  unpairNextStep,
  unpairPanelText,
  unpairFailedText,
  unpairFailureReason,
  shapeRemovedDevice,
} = await import("../frontend/paired_devices.ts");
initPairedDevices();

const W = "d-7178aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55a859";
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: W,
    paired: true,
    refused_us: false,
    display_name: "Windows PC",
    paired_at: 1,
    level: 0,
    ladder_label: "observe",
    dropped_while_throttled: 0,
    window_invalid: 0,
    window_total: 0,
    recommend_unpair: false,
    hard_block: null,
    tally: null,
    ...over,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const byText = (t: string) => dialog.all().find((e) => e.tagName === "button" && e.textContent === t) ?? null;
const unpairCalls = () => calls.filter((c) => c.op === "unpair_device");

async function openDialog(): Promise<void> {
  opener.click();
  await flush();
  await flush();
}

beforeEach(() => {
  calls.length = 0;
  devices = [row()];
  removed = [];
  unpairResult = async () => ({ ok: true, already: false });
});

describe("TR-4 Unpair needs two clicks; any re-render returns it to idle", () => {
  test("TR-4 state machine", () => {
    expect(unpairNextStep("idle", "open")).toBe("confirm");
    expect(unpairNextStep("confirm", "confirm")).toBe("execute");
    expect(unpairNextStep("idle", "confirm")).toBe("idle"); // one click never executes
    for (const e of ["cancel", "rerender", "other_action"] as const) {
      expect(unpairNextStep("confirm", e)).toBe("idle");
    }
  });

  test("TR-4 DOM: first click shows the panel and sends nothing; second click sends confirm:true once", async () => {
    await openDialog();
    byText("Unpair...")!.click();
    expect(unpairCalls()).toEqual([]);
    const panel = dialog.querySelector(".unpair-panel")!;
    expect(panel).not.toBeNull();
    byText("Unpair Windows PC")!.click();
    await flush();
    expect(unpairCalls()).toEqual([{ op: "unpair_device", args: { device_id: W, confirm: true } }]);
  });

  test("TR-4 DOM: Cancel, another row action, and a re-render disarm the panel", async () => {
    await openDialog();
    // Cancel
    byText("Unpair...")!.click();
    let confirm = byText("Unpair Windows PC")!;
    byText("Cancel")!.click();
    expect(dialog.querySelector(".unpair-panel")).toBeNull();
    confirm.click();
    // other row action
    byText("Unpair...")!.click();
    confirm = byText("Unpair Windows PC")!;
    byText("Reset peer state")!.click();
    expect(dialog.querySelector(".unpair-panel")).toBeNull();
    confirm.click();
    await flush();
    await flush();
    // re-render (the dialog is opened again)
    byText("Unpair...")!.click();
    confirm = byText("Unpair Windows PC")!;
    await openDialog();
    expect(dialog.querySelector(".unpair-panel")).toBeNull();
    confirm.click();
    await flush();
    expect(unpairCalls()).toEqual([]);
  });

  test("TR-4 DOM: a failure shows the inline P8 line without codes", async () => {
    unpairResult = async () => {
      throw new Error("ERR_BUSY: the device is still syncing; try again");
    };
    await openDialog();
    byText("Unpair...")!.click();
    byText("Unpair Windows PC")!.click();
    await flush();
    await flush();
    expect(dialog.querySelector(".unpair-error")!.textContent).toBe(
      "Unpair failed: the device is still syncing; try again. Nothing was changed.",
    );
  });
});

describe("P1 / P6 / P8 wording", () => {
  test("P1 Step-1 panel text is the §4.1 wording", () => {
    expect(unpairPanelText("Windows PC", false)).toEqual({
      heading: "Unpair Windows PC?",
      lines: [
        "Windows PC will stop syncing with this device and with your other paired devices.",
        "Appointments already received from Windows PC stay here.",
        "Changes made on Windows PC that have not synced yet will not arrive. If Windows PC is reachable, press Sync now first.",
        "This cannot be undone. To use Windows PC with Tide again, it must start fresh and be paired again.",
      ],
      cancel: "Cancel",
      confirm: "Unpair Windows PC",
    });
  });

  test("P6 hint line only when the peer refused our last attempt", async () => {
    expect(unpairPanelText("Windows PC", true).lines[4]).toBe(
      "Windows PC may already have unpaired this device. Unpairing it here also removes it from devices this one can still reach.",
    );
    devices = [row({ refused_us: true })];
    await openDialog();
    byText("Unpair...")!.click();
    expect(dialog.querySelector(".unpair-panel")!.textContent).toContain("may already have unpaired this device");
  });

  test("P8 failure line and Removed devices section", async () => {
    expect(unpairFailedText(unpairFailureReason(new Error("ERR_NOT_PAIRED: device is not paired")))).toBe(
      "Unpair failed: device is not paired. Nothing was changed.",
    );
    const t = Date.UTC(2026, 10, 14, 12);
    expect(
      shapeRemovedDevice({
        device_id: W,
        label: "Windows PC",
        removed_at: t,
        told: [
          { device_id: "d-91ab", label: "Phone", done: true },
          { device_id: "d-03cd", label: "Tablet", done: false },
        ],
      }).told,
    ).toBe("Other devices told: Phone - done; Tablet - waiting");
    expect(shapeRemovedDevice({ device_id: W, label: "Windows PC", removed_at: t, told: [] }).told).toBe(
      "No other devices to tell.",
    );
    removed = [{ device_id: W, label: "Windows PC", removed_at: t, told: [] }];
    devices = [];
    await openDialog();
    expect(section.hidden).toBe(false);
    expect(removedList.textContent).toContain("Windows PC  removed 2026-11-1");
    expect(removedList.textContent).toContain("No other devices to tell.");
    // the section has no actions (no un-revoke exists)
    expect(removedList.all().some((e) => e.tagName === "button")).toBe(false);
  });

  test("text only: the Unpair flow never writes innerHTML with data", () => {
    const src = readFileSync(join(__dirname, "../frontend/paired_devices.ts"), "utf8");
    for (const m of src.matchAll(/innerHTML\s*=\s*([^;]+);/g)) expect(m[1]!.trim()).toBe('""');
    // the dialog has an entry point (index.html)
    const html = readFileSync(join(__dirname, "../frontend/index.html"), "utf8");
    expect(html).toContain('id="btn-paired-devices"');
  });
});
