// DC-28 TR-6 + TR-9, one DOM test per §4.10 surface: Devices & sync,
// Paired Devices (rows, Rename, Unpair panel, Removed devices), Sync Errors
// (cards, peer-state rows) and the conflict dialog. The REAL frontend
// modules run against a minimal in-test DOM (the repo ships no jsdom); the
// only stub is the Tauri invoke seam.
//
// TR-9: the fake DOM's innerHTML setter PARSES tags into child elements, so
// a surface that put a name through innerHTML would create a <b> element.
// Every name here is "<b>x</b>"-shaped and must show literally.
// TR-6: no surface text may contain "..." / "…" right after id characters.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SELF = "d-5e1f5e1f" + "0".repeat(56);
const W = "d-7178a859" + "a".repeat(56);
const R = "d-2ee25c62" + "b".repeat(56);
const EVIL = "<b>x</b>";
const EVIL_R = "<i>r</i>";
const OWN = "<u>me</u>";

const invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function peerRow(): Record<string, unknown> {
  return {
    device_id: W,
    paired: true,
    refused_us: false,
    label: EVIL,
    short_id: "7178a859",
    nickname: EVIL,
    announced_name: null,
    paired_at: 1,
    level: 2,
    ladder_label: "throttle",
    dropped_while_throttled: 0,
    window_invalid: 7,
    window_total: 9,
    window_ratio: 7 / 9,
    recommend_unpair: false,
    hard_block: null,
    tally: null,
  };
}

async function syncOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "device_info":
      return {
        device_id: SELF,
        paired_peers: [{ device_id: W, label: EVIL, short_id: "7178a859", nickname: EVIL, announced_name: null, paired_at: 1 }],
        listening_port: 1,
      };
    case "list_paired_devices":
      return { self_device_id: SELF, devices: [peerRow()] };
    case "peer_state":
      return { peers: [peerRow()] };
    case "list_removed_devices":
      return { removed: [{ device_id: R, label: EVIL_R, removed_at: Date.UTC(2026, 10, 1), told: [{ device_id: W, label: EVIL, done: false }] }] };
    case "list_quarantine":
      return {
        rows: [
          {
            quarantine_id: 1,
            quarantine_reason: "invalid_change_record:bad_seq",
            received_at_hlc: Date.now(),
            sender_device_id: W,
            raw_record: JSON.stringify({ device_id: W, local_seq: 3 }),
          },
        ],
        total: 1,
      };
    case "quarantine_stats":
      return { active: 1, resolved: 0, total: 1 };
    case "pairing_accept":
      return { peer_device_id: W, safety_number: "1-2-3-4-5" };
    case "set_peer_nickname":
      return { device_id: W, label: String(args.nickname) };
    case "list_conflicts":
      return {
        total_unresolved: 1,
        conflicts: [{ conflict_id: "cf-1", entity_id: "e-1", field_path: "title", status: "unresolved", participant_count: 2 }],
      };
    case "list_events":
      return [{ id: "e-1", startMs: Date.UTC(2026, 10, 15, 18) }];
    case "conflict_detail":
      return {
        conflict_id: "cf-1",
        entity_id: "e-1",
        entity_title: "Dentist",
        field_path: "title",
        status: "unresolved",
        local_change_id: "c-local",
        candidates: [
          { change_id: "c-local", device_id: SELF, device_name: "This device", deleted: false, value: "A", hlc_timestamp: Date.UTC(2026, 10, 14, 9) },
          { change_id: "c-remote", device_id: W, device_name: EVIL, deleted: false, value: "B", hlc_timestamp: Date.UTC(2026, 10, 14, 10) },
        ],
      };
    default:
      return null;
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    if (cmd === "sync_op") return syncOp(String(args.op), (args.args ?? {}) as Record<string, unknown>);
    if (cmd === "get_device_name") return { device_name: OWN, suggestion: "Linux PC" };
    if (cmd === "set_device_name") return { device_name: args.name };
    return null;
  }),
}));
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

// --- minimal DOM -----------------------------------------------------------
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  id = "";
  type = "";
  className = "";
  title = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  spellcheck = true;
  hidden = false;
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private ownText = "";
  private handlers: Record<string, Array<(ev?: unknown) => void>> = {};
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = v;
  }
  /** A real browser parses markup: model that, so misuse creates elements. */
  set innerHTML(v: string) {
    this.textContent = "";
    for (const m of v.matchAll(/<([a-z][a-z0-9]*)[^>]*>([^<]*)/gi)) {
      const child = new FakeEl(m[1]!.toLowerCase());
      child.textContent = m[2]!;
      this.appendChild(child);
    }
    if (this.children.length === 0) this.ownText = v;
  }
  get parentElement(): FakeEl | null {
    return this.parent;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  classList = {
    toggle: (c: string, on?: boolean) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !set.has(c)) set.add(c);
      else set.delete(c);
      this.className = [...set].join(" ");
    },
    add: (c: string) => this.classList.toggle(c, true),
    remove: (c: string) => this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };
  setAttribute(k: string, v: string): void {
    this.dataset["attr:" + k] = v;
  }
  removeAttribute(): void {}
  addEventListener(ev: string, fn: (ev?: unknown) => void): void {
    (this.handlers[ev] ??= []).push(fn);
  }
  click(): void {
    if (this.disabled) return;
    for (const fn of this.handlers.click ?? []) fn({ preventDefault() {}, stopPropagation() {} });
  }
  focus(): void {}
  scrollIntoView(): void {}
  append(...nodes: Array<FakeEl | string>): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? textNode(n) : n);
  }
  prepend(n: FakeEl): void {
    n.parent = this;
    this.children.unshift(n);
  }
  appendChild(n: FakeEl): FakeEl {
    if (n.parent) n.remove();
    n.parent = this;
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes: FakeEl[]): void {
    this.textContent = "";
    this.append(...nodes);
  }
  before(n: FakeEl): void {
    const p = this.parent!;
    n.parent = p;
    p.children.splice(p.children.indexOf(this), 0, n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    for (const fn of this.handlers.close ?? []) fn();
  }
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
function textNode(t: string): FakeEl {
  const n = new FakeEl("#text");
  n.textContent = t;
  return n;
}

const byId = new Map<string, FakeEl>();
function mk(tag: string, id: string, parent?: FakeEl): FakeEl {
  const e = new FakeEl(tag);
  e.id = id;
  byId.set(id, e);
  parent?.appendChild(e);
  return e;
}
const body = new FakeEl("body");
// Devices & sync
const devices = mk("dialog", "devices-dialog", body);
for (const [tag, id] of [
  ["strong", "self-device-name"], ["span", "self-device-id"], ["button", "btn-rename-self"],
  ["div", "self-name-editor"], ["div", "peers-list"], ["div", "devices-busy"], ["div", "devices-log"],
  ["textarea", "pairing-code-in"], ["textarea", "pairing-code-out"], ["button", "btn-pairing-show"],
  ["button", "btn-pairing-accept"], ["button", "btn-pairing-cancel"], ["button", "devices-close"],
  ["div", "firewall-notice"], ["span", "firewall-notice-text"], ["button", "firewall-retry"],
] as const) mk(tag, id, devices);
mk("span", "self-listen-port", mk("span", "self-listen-port-wrap", devices));
mk("button", "btn-devices", body);
// Paired Devices
const paired = mk("dialog", "paired-devices-dialog", body);
mk("div", "paired-devices-list", paired);
mk("div", "removed-devices-list", mk("section", "removed-devices-section", paired));
mk("button", "btn-paired-devices", body);
mk("button", "paired-devices-close", paired);
// Sync Errors
const syncErrors = mk("dialog", "sync-errors-dialog", body);
mk("div", "sync-errors-list", syncErrors);
mk("div", "peer-state-list", syncErrors);
mk("button", "sync-errors-close", syncErrors);
const btnSyncErrors = mk("button", "btn-sync-errors", body);
mk("span", "sync-errors-count", btnSyncErrors);
// Conflicts
const conflicts = mk("dialog", "conflict-dialog", body);
mk("div", "conflict-list", conflicts);
mk("div", "conflict-detail", conflicts);
mk("button", "btn-conflicts", body);

vi.stubGlobal("document", {
  documentElement: { dataset: {}, lang: "" },
  body,
  getElementById: (id: string) => byId.get(id) ?? null,
  createElement: (tag: string) => new FakeEl(tag),
  createTextNode: (t: string) => textNode(t),
  addEventListener: () => {},
  dispatchEvent: () => true,
});
vi.stubGlobal("window", { addEventListener: () => {}, dispatchEvent: () => true });

const flush = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

const devicesMod = await import("../frontend/devices.ts");
const pairedMod = await import("../frontend/paired_devices.ts");
const syncErrorsMod = await import("../frontend/sync_errors.ts");
const conflictsMod = await import("../frontend/conflicts.ts");
devicesMod.initDevices();
pairedMod.initPairedDevices();
syncErrorsMod.initSyncErrors();

const TRUNCATED_ID = /[0-9a-f]{4,}(…|\.\.\.)/i;
function visibleText(n: FakeEl, skipClass?: string): string {
  if (skipClass && n.classList.contains(skipClass)) return "";
  return n.children.length === 0 ? n.textContent : n.children.map((c) => visibleText(c, skipClass)).join("");
}
/**
 * `skipClass`: a collapsed raw-data disclosure (Sync Errors "Technical
 * details" shows the raw record verbatim by design) is excluded from the
 * full-id check only; the "..." and markup checks still cover it.
 */
function assertSafe(root: FakeEl, names: string[], skipClass?: string): void {
  const text = root.textContent;
  for (const n of names) expect(text).toContain(n); // shown literally (TR-9)
  for (const tag of ["b", "i", "u"]) expect(root.querySelectorAll(tag)).toHaveLength(0); // no element created
  expect(text).not.toMatch(TRUNCATED_ID); // TR-6
  const shown = visibleText(root, skipClass);
  for (const id of [W, R, SELF]) expect(shown).not.toContain(id); // never a full id
}
const buttonByText = (root: FakeEl, t: string) => root.all().find((e) => e.tagName === "button" && e.textContent === t) ?? null;

beforeEach(() => {
  invokes.length = 0;
});

describe("TR-6 / TR-9 every §4.10 surface: short ids only, names as literal text", () => {
  test("TR-6 TR-9 Devices & sync: own-name line, peers list, 'paired with <label>' log, rename editor", async () => {
    byId.get("btn-devices")!.click();
    await flush();
    expect(byId.get("self-device-name")!.textContent).toBe(OWN);
    expect(byId.get("self-device-id")!.textContent).toBe("5e1f5e1f");
    expect(byId.get("peers-list")!.textContent).toContain(`${EVIL}id 7178a859`);
    byId.get("pairing-code-in")!.value = '{"v":1}';
    byId.get("btn-pairing-accept")!.click();
    await flush();
    expect(byId.get("devices-log")!.textContent).toContain(`paired with ${EVIL} (safety`);
    byId.get("btn-rename-self")!.click();
    await flush();
    const input = byId.get("self-name-editor")!.querySelector("input")!;
    expect(input.value).toBe(OWN); // value property, never markup
    expect(byId.get("self-name-editor")!.textContent).toContain("Shown on devices you pair with from now on.");
    assertSafe(devices, [OWN, EVIL]);
    buttonByText(byId.get("self-name-editor")!, "Save")!.click();
    await flush();
    expect(invokes.find((i) => i.cmd === "set_device_name")?.args).toEqual({ name: OWN });
  });

  test("TR-6 TR-9 Paired Devices: row label + 'id <short id>', Rename, Unpair panel, Removed devices", async () => {
    byId.get("btn-paired-devices")!.click();
    await flush();
    const list = byId.get("paired-devices-list")!;
    expect(list.textContent).toContain(`${EVIL}id 7178a859`);
    buttonByText(list, "Rename")!.click();
    await flush();
    const editor = list.querySelector(".name-editor")!;
    expect(editor.querySelector("input")!.value).toBe(EVIL);
    expect(editor.textContent).toContain(pairedMod.NICKNAME_HELP);
    // opening Unpair closes the editor (one open action per dialog)
    buttonByText(list, "Unpair...")!.click();
    await flush();
    expect(list.querySelector(".name-editor")).toBeNull();
    expect(list.querySelector(".unpair-panel")!.textContent).toContain(`Unpair ${EVIL}?`);
    expect(byId.get("removed-devices-list")!.textContent).toContain(EVIL_R);
    expect(byId.get("removed-devices-list")!.textContent).toContain(`${EVIL} - waiting`);
    assertSafe(paired, [EVIL, EVIL_R]);
    // Rename -> Save sends the nickname through set_peer_nickname
    buttonByText(list, "Rename")!.click();
    await flush();
    const ed = list.querySelector(".name-editor")!;
    ed.querySelector("input")!.value = "";
    buttonByText(ed, "Save")!.click();
    await flush();
    const sent = invokes.find((i) => i.cmd === "sync_op" && i.args.op === "set_peer_nickname");
    expect(sent?.args.args).toEqual({ device_id: W, nickname: "" });
  });

  test("TR-6 TR-9 Sync Errors: error card 'From: <label>' and the peer-state row", async () => {
    byId.get("btn-sync-errors")!.click();
    await flush();
    expect(byId.get("sync-errors-list")!.textContent).toContain(`From: ${EVIL}`);
    expect(byId.get("peer-state-list")!.textContent).toContain(EVIL);
    assertSafe(syncErrors, [EVIL], "sync-error-details");
  });

  test("TR-6 TR-9 conflict dialog: candidate side and Keep button", async () => {
    conflictsMod.openConflictsDialog();
    await flush();
    byId.get("conflict-list")!.querySelector(".conflict-row")!.click();
    await flush();
    const detail = byId.get("conflict-detail")!;
    expect(detail.textContent).toContain("This device (local)");
    expect(detail.querySelectorAll("button").map((b) => b.textContent)).toContain(`Keep ${EVIL}'s`);
    assertSafe(conflicts, [EVIL]);
  });

  test("TR-9 source: no surface module assigns innerHTML from data", () => {
    for (const f of ["devices.ts", "paired_devices.ts", "sync_errors.ts", "conflicts.ts", "name_editor.ts", "device-label.ts"]) {
      const src = readFileSync(join(__dirname, "../frontend", f), "utf8");
      for (const m of src.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
        // only string literals (static markup) or "" are allowed
        expect(m[1]!.trim(), `${f}: ${m[1]}`).toMatch(/^("[^"$`]*"|'[^'$`]*')$/);
      }
    }
  });
});
