// DC-14 Appendix A dialog wiring, driven through a minimal in-test DOM
// (the repo ships no jsdom/happy-dom). Covers: each A.6 Keep button sends
// resolve_conflict with the §4 option its label names (the earlier dialog's
// Keep handler never fired), Technical details starts collapsed (P3), and
// a conflict whose value cannot be formatted never leaves another
// conflict's buttons on screen.
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: Array<{ op: string; args: unknown }> = [];
let detailFor: Record<string, unknown> = {};
vi.mock("../frontend/devices.ts", () => ({
  syncOp: vi.fn(async (op: string, args?: Record<string, unknown>) => {
    calls.push({ op, args });
    if (op === "list_conflicts") {
      return {
        total_unresolved: Object.keys(detailFor).length,
        conflicts: Object.keys(detailFor).map((id) => ({
          conflict_id: id,
          entity_id: "e-1",
          field_path: (detailFor[id] as { field_path: string }).field_path,
          status: "unresolved",
          participant_count: 2,
        })),
      };
    }
    if (op === "list_events") return [{ id: "e-1", startMs: Date.UTC(2026, 10, 15, 18) }];
    if (op === "conflict_detail") {
      const d = detailFor[String(args?.conflict_id)];
      if (d === undefined) throw new Error("no conflict");
      return d;
    }
    return null;
  }),
}));

// --- minimal DOM -----------------------------------------------------------
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  private ownText = "";
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.ownText = v;
  }
}
class FakeEl extends FakeNode {
  id = "";
  type = "";
  className = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  open = false;
  title = "";
  private handlers: Record<string, Array<() => void>> = {};
  classList = {
    toggle: (c: string, on?: boolean) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !set.has(c)) set.add(c);
      else set.delete(c);
      this.className = [...set].join(" ");
    },
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: () => void): void {
    (this.handlers[ev] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.handlers.click ?? []) fn();
  }
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  appendChild(n: FakeNode): FakeNode {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.textContent = "";
    this.append(...nodes);
  }
  before(n: FakeNode): void {
    const p = this.parent!;
    n.parent = p;
    p.children.splice(p.children.indexOf(this), 0, n);
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
    const walk = (n: FakeNode) => {
      for (const c of n.children) {
        if (c instanceof FakeEl) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  private matches(sel: string): boolean {
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    return this.tagName === sel;
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function el(tag: string, id = ""): FakeEl {
  const e = new FakeEl(tag);
  e.id = id;
  return e;
}

const dialog = el("dialog", "conflict-dialog");
const list = el("div", "conflict-list");
const detailPane = el("div", "conflict-detail");
dialog.append(list, detailPane);

vi.stubGlobal("document", {
  documentElement: { dataset: {}, lang: "" },
  getElementById: (id: string) => (id === "conflict-dialog" ? dialog : null),
  createElement: (tag: string) => el(tag),
  createTextNode: (t: string) => {
    const n = new FakeNode("#text");
    n.textContent = t;
    return n;
  },
  addEventListener: () => {},
});

const OTHER = "d-2ee25c62" + "a".repeat(56);
function makeDetail(id: string, remoteValue: unknown) {
  return {
    conflict_id: id,
    entity_id: "e-1",
    entity_title: "Test-Windoof",
    field_path: "schedule",
    status: "unresolved",
    local_change_id: "c-local",
    candidates: [
      {
        change_id: "c-local",
        device_id: "d-self",
        device_name: "This device",
        deleted: false,
        value: { startMs: Date.UTC(2026, 10, 15, 8), endMs: Date.UTC(2026, 10, 15, 9), allDay: false },
        hlc_timestamp: Date.UTC(2026, 10, 14, 23, 23),
      },
      {
        change_id: "c-remote",
        device_id: OTHER,
        // DC-28 §4.7: what the sidecar sends for a device with no name.
        device_name: "Device 2ee25c62",
        deleted: false,
        value: remoteValue,
        hlc_timestamp: Date.UTC(2026, 10, 14, 23, 30),
      },
    ],
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function openWith(details: Record<string, unknown>) {
  detailFor = details;
  calls.length = 0;
  const m = await import("../frontend/conflicts.ts");
  m.openConflictsDialog();
  await flush();
  return m;
}

function rowFor(id: string): FakeEl {
  return list.querySelectorAll(".conflict-row").find((r) => r.dataset.conflictId === id)!;
}

function buttons(): FakeEl[] {
  return detailPane.querySelectorAll("button");
}

describe("DC-14 A.6 dialog wiring (DOM level)", () => {
  beforeEach(() => {
    list.replaceChildren();
    detailPane.replaceChildren();
  });

  test("each Keep button resolves with the option its label names", async () => {
    const good = { startMs: Date.UTC(2026, 10, 15, 18), endMs: Date.UTC(2026, 10, 15, 19), allDay: false };
    await openWith({ "cf-a": makeDetail("cf-a", good) });
    rowFor("cf-a").click();
    await flush();
    const labels = buttons().map((b) => b.textContent);
    expect(labels).toEqual(["Keep this device's", "Keep Device 2ee25c62's", "Decide later"]);

    calls.length = 0;
    buttons().find((b) => b.textContent === "Keep Device 2ee25c62's")!.click();
    await flush();
    expect(calls.find((c) => c.op === "resolve_conflict")?.args).toEqual({
      conflict_id: "cf-a",
      option: { kind: "keep_theirs", change_id: "c-remote" },
    });

    rowFor("cf-a").click();
    await flush();
    calls.length = 0;
    buttons().find((b) => b.textContent === "Keep this device's")!.click();
    await flush();
    expect(calls.find((c) => c.op === "resolve_conflict")?.args).toEqual({
      conflict_id: "cf-a",
      option: { kind: "keep_mine" },
    });
  });

  test("Technical details starts collapsed and holds no full device id", async () => {
    const good = { startMs: Date.UTC(2026, 10, 15, 18), endMs: Date.UTC(2026, 10, 15, 19), allDay: false };
    await openWith({ "cf-a": makeDetail("cf-a", good) });
    rowFor("cf-a").click();
    await flush();
    const tech = detailPane.querySelector("details")!;
    expect(tech).not.toBeNull();
    expect(tech.open).toBe(false);
    expect(tech.attrs.open).toBeUndefined();
    expect(tech.querySelector("summary")!.textContent).toBe("Technical details");
    expect(detailPane.textContent).not.toContain(OTHER);
    // Visible columns: readable dates (runtime locale), no epoch numbers;
    // the raw epochs live only inside the collapsed disclosure.
    const sides = detailPane.querySelector(".conflict-sides")!.textContent;
    expect(sides).toContain("Nov");
    expect(sides).not.toMatch(/\d{10,}/);
    expect(tech.textContent).toMatch(/\d{13}/);
  });

  test("out-of-range timestamp: no throw, fallback shown, highlight + buttons belong to that conflict", async () => {
    const good = { startMs: Date.UTC(2026, 10, 15, 18), endMs: Date.UTC(2026, 10, 15, 19), allDay: false };
    const huge = { startMs: 9e15, endMs: 9e15, allDay: false };
    await openWith({ "cf-a": makeDetail("cf-a", good), "cf-b": makeDetail("cf-b", huge) });
    rowFor("cf-a").click();
    await flush();
    rowFor("cf-b").click();
    await flush();
    expect(rowFor("cf-b").classList.contains("selected")).toBe(true);
    expect(rowFor("cf-a").classList.contains("selected")).toBe(false);
    expect(detailPane.textContent).toContain("This change can't be shown in detail");
    calls.length = 0;
    buttons().find((b) => b.textContent === "Keep Device 2ee25c62's")!.click();
    await flush();
    expect((calls.find((c) => c.op === "resolve_conflict")?.args as { conflict_id: string }).conflict_id).toBe("cf-b");
  });

  test("a detail that fails to load clears the pane (no stale buttons)", async () => {
    const good = { startMs: Date.UTC(2026, 10, 15, 18), endMs: Date.UTC(2026, 10, 15, 19), allDay: false };
    await openWith({ "cf-a": makeDetail("cf-a", good), "cf-b": makeDetail("cf-b", good) });
    rowFor("cf-a").click();
    await flush();
    expect(buttons().length).toBe(3);
    delete detailFor["cf-b"]; // conflict_detail now throws for cf-b
    rowFor("cf-b").click();
    await flush();
    expect(buttons().length).toBe(0);
    expect(rowFor("cf-b").classList.contains("selected")).toBe(true);
    expect(detailPane.textContent).toContain("can't be shown right now");
  });
});
