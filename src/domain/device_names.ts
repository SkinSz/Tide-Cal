// Tide DC-28: friendly device names. Pure, DOM-free and node-free, so the
// sidecar and the frontend share ONE implementation of the name rule
// (§4.8), the short id (§4.7) and the label rule (§4.7, P7).
//
// Names are DISPLAY-ONLY (D1): nothing here may feed identity, trust,
// routing or matching. Every name is untrusted text: callers render it with
// textContent only and never log it (§4.10).

/** Why a name was refused (machine code; safe to log, never the text). */
export type NameRule =
  | "not_string"
  | "control"
  | "format"
  | "line_separator"
  | "private_use"
  | "surrogate"
  | "too_many_characters"
  | "too_many_bytes"
  | "id_prefix";

export type NameResult =
  | { ok: true; name: string | null } // null = no name (empty after trim)
  | { ok: false; rule: Exclude<NameRule, "id_prefix"> };

/** §4.8 limits. 64 bytes = DC-11 MAX_TXT_VALUE_BYTES. */
export const NAME_MAX_CODE_POINTS = 32;
export const NAME_MAX_UTF8_BYTES = 64;

// Space separators only (Zs). Deliberately NOT String.prototype.trim / \s:
// those also strip tab, newline, U+2028/U+2029 and U+FEFF, which §4.8
// requires to be REJECTED, not silently removed.
const EDGE_ZS = /^\p{Zs}+|\p{Zs}+$/gu;
const RUN_ZS = /\p{Zs}+/gu;
const CC = /\p{Cc}/u;
const ZL_ZP = /[\p{Zl}\p{Zp}]/u;
const CO = /\p{Co}/u;
const CS = /\p{Cs}/u;
// Cf except U+200C ZWNJ / U+200D ZWJ (emoji sequences, several scripts).
const CF_EXCEPT_ZWJ = /(?![‌‍])\p{Cf}/u;

/** UTF-8 length of a string without lone surrogates (checked before). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Code-point count (an astral emoji counts once). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * DC-28 §4.8 validateName (P8): own name, nickname and received names alike.
 *   NFC; trim and collapse Zs runs to one " "; "" -> none;
 *   reject Cc, Zl, Zp, Co, Cs, and Cf except ZWNJ/ZWJ;
 *   reject > 32 code points or > 64 UTF-8 bytes.
 * Invalid names are refused, never repaired or truncated.
 */
export function validateName(input: unknown): NameResult {
  if (typeof input !== "string") return { ok: false, rule: "not_string" };
  // Lone surrogates first: NFC keeps them, and the byte count below assumes
  // well-formed UTF-16.
  if (CS.test(input)) return { ok: false, rule: "surrogate" };
  const s = input.normalize("NFC").replace(EDGE_ZS, "").replace(RUN_ZS, " ");
  if (s === "") return { ok: true, name: null };
  if (CC.test(s)) return { ok: false, rule: "control" };
  if (ZL_ZP.test(s)) return { ok: false, rule: "line_separator" };
  if (CO.test(s)) return { ok: false, rule: "private_use" };
  if (CF_EXCEPT_ZWJ.test(s)) return { ok: false, rule: "format" };
  if (codePointLength(s) > NAME_MAX_CODE_POINTS) return { ok: false, rule: "too_many_characters" };
  if (utf8Length(s) > NAME_MAX_UTF8_BYTES) return { ok: false, rule: "too_many_bytes" };
  return { ok: true, name: s };
}

/**
 * §4.5 on receive: the name a peer announced during pairing. Invalid ->
 * dropped (with the rule, for a debug log that never carries the text).
 * A name that is a prefix of the sender's device id is the placeholder older
 * builds sent (deviceId.slice(0, 12), S3) and is stored as none.
 */
export function announcedNameFromPeer(
  raw: unknown,
  senderDeviceId: string,
): { name: string | null; ignored?: NameRule } {
  if (raw === undefined || raw === null) return { name: null };
  const r = validateName(raw);
  if (!r.ok) return { name: null, ignored: r.rule };
  if (r.name === null) return { name: null };
  if (senderDeviceId.startsWith(r.name)) return { name: null, ignored: "id_prefix" };
  return { name: r.name };
}

const SYNC_DEVICE_ID = /^d-[0-9a-f]{64}$/;

/**
 * §4.7 shortId: the 8 hex characters after "d-" for a sync device id; the
 * first 8 characters for any other (legacy) shape. A complete token, never
 * a truncation: no "..." is ever appended (P10, TD-032).
 * NOT the mDNS instance prefix (DC-11 §2.2 hashes the id again).
 */
export function shortId(deviceId: string): string {
  const id = typeof deviceId === "string" ? deviceId : "";
  return SYNC_DEVICE_ID.test(id) ? id.slice(2, 10) : id.slice(0, 8);
}

/** "This device" for self (P11, the approved precedence). */
export const SELF_LABEL = "This device";

/** A stored value that still passes §4.8 (defence against hand-edited DBs). */
function usable(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const r = validateName(v);
  return r.ok ? r.name : null;
}

/**
 * §4.7 label rule, one function for every surface:
 *   self -> "This device"; nickname > announced name > "Device <short id>".
 */
export function deviceLabel(p: {
  device_id: string;
  self_device_id?: string | null;
  nickname?: string | null;
  announced_name?: string | null;
}): string {
  if (p.self_device_id && p.device_id === p.self_device_id) return SELF_LABEL;
  return usable(p.nickname) ?? usable(p.announced_name) ?? `Device ${shortId(p.device_id)}`;
}

/**
 * P7: within ONE list, devices that would show the same label all get
 * " (<short id>)" appended. Returns new labels in input order; entries for
 * the same device id are not treated as duplicates of each other.
 */
export function disambiguateLabels<T extends { device_id: string; label: string }>(
  items: readonly T[],
): string[] {
  const idsByLabel = new Map<string, Set<string>>();
  for (const it of items) {
    let ids = idsByLabel.get(it.label);
    if (ids === undefined) idsByLabel.set(it.label, (ids = new Set()));
    ids.add(it.device_id);
  }
  return items.map((it) =>
    (idsByLabel.get(it.label)?.size ?? 0) > 1 ? `${it.label} (${shortId(it.device_id)})` : it.label,
  );
}

/** The wire shape §4.9 / §5(d): one device as every surface receives it. */
export interface DeviceNameView {
  device_id: string;
  short_id: string;
  announced_name: string | null;
  nickname: string | null;
  label: string;
}

/**
 * Build §4.9 views for one list from stored peers rows (display_name is the
 * nickname, "" = none; announced_name may be NULL), labels disambiguated
 * within this list (P7).
 */
export function deviceNameViews(
  rows: ReadonlyArray<{ device_id: string; display_name?: string | null; announced_name?: string | null }>,
  selfDeviceId?: string | null,
): DeviceNameView[] {
  const base = rows.map((r) => {
    const nickname = usable(r.display_name);
    const announced = usable(r.announced_name);
    return {
      device_id: r.device_id,
      short_id: shortId(r.device_id),
      announced_name: announced,
      nickname,
      label: deviceLabel({
        device_id: r.device_id,
        self_device_id: selfDeviceId,
        nickname,
        announced_name: announced,
      }),
    };
  });
  const labels = disambiguateLabels(base);
  return base.map((b, i) => ({ ...b, label: labels[i]! }));
}
