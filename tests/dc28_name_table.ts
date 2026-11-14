// DC-28 TR-1 / V2: the validateName table. Shared by the vitest run (Node,
// the sidecar's engine) and the JavaScriptCore run (WebKitGTK's engine,
// diagnostics bundle), so both engines are checked against the SAME rows.
// expect: string = accepted and normalized to it; null = "no name";
// "invalid:<rule>" = refused with that rule.

export interface NameCase {
  label: string;
  input: unknown;
  expect: string | null;
}

const ZWJ_FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // man ZWJ woman ZWJ girl (18 bytes)

export const NAME_CASES: NameCase[] = [
  { label: "plain", input: "Windows PC", expect: "Windows PC" },
  { label: "NFC: e + combining acute -> e-acute", input: "Café", expect: "Café" },
  { label: "trim spaces", input: "   Laptop  ", expect: "Laptop" },
  { label: "trim no-break space (Zs)", input: " Laptop ", expect: "Laptop" },
  { label: "collapse internal runs", input: "Office    laptop", expect: "Office laptop" },
  { label: "empty -> none", input: "", expect: null },
  { label: "spaces only -> none", input: "   ", expect: null },
  { label: "not a string", input: 42, expect: "invalid:not_string" },
  { label: "null", input: null, expect: "invalid:not_string" },
  { label: "U+0007 bell (Cc)", input: "Ding\u0007", expect: "invalid:control" },
  { label: "tab (Cc), not trimmed away", input: "\tLaptop", expect: "invalid:control" },
  { label: "newline (Cc)", input: "Lap\ntop", expect: "invalid:control" },
  { label: "U+2028 line separator (Zl), not trimmed away", input: " Laptop", expect: "invalid:line_separator" },
  { label: "U+2029 paragraph separator (Zp)", input: "Lap top", expect: "invalid:line_separator" },
  { label: "U+202E right-to-left override (Cf)", input: "Bob‮exe.cod", expect: "invalid:format" },
  { label: "U+2066 isolate (Cf)", input: "a⁦b", expect: "invalid:format" },
  { label: "U+200E LRM (Cf)", input: "a‎b", expect: "invalid:format" },
  { label: "U+061C ALM (Cf)", input: "a؜b", expect: "invalid:format" },
  { label: "U+200B zero width space (Cf)", input: "Lap​top", expect: "invalid:format" },
  { label: "U+FEFF BOM (Cf), not trimmed away", input: "﻿Laptop", expect: "invalid:format" },
  { label: "U+E000 private use (Co)", input: "PC", expect: "invalid:private_use" },
  { label: "lone high surrogate (Cs)", input: "PC\ud800", expect: "invalid:surrogate" },
  { label: "lone low surrogate (Cs)", input: "\udc00PC", expect: "invalid:surrogate" },
  { label: "ZWJ emoji sequence accepted", input: `${ZWJ_FAMILY} home`, expect: `${ZWJ_FAMILY} home` },
  { label: "ZWNJ accepted (Persian)", input: "می‌خواهم", expect: "می‌خواهم" },
  { label: "32 code points accepted", input: "a".repeat(32), expect: "a".repeat(32) },
  { label: "33 code points refused", input: "a".repeat(33), expect: "invalid:too_many_characters" },
  { label: "17 astral emoji = 17 code points but 68 bytes", input: "\u{1F600}".repeat(17), expect: "invalid:too_many_bytes" },
  { label: "16 astral emoji = exactly 64 bytes accepted", input: "\u{1F600}".repeat(16), expect: "\u{1F600}".repeat(16) },
  { label: "21 Cyrillic letters = 42 bytes accepted", input: "Ж".repeat(21), expect: "Ж".repeat(21) },
  { label: "22 CJK chars = 66 bytes refused", input: "東".repeat(22), expect: "invalid:too_many_bytes" },
  { label: "21 CJK chars = 63 bytes accepted", input: "東".repeat(21), expect: "東".repeat(21) },
  { label: "HTML-looking text is just text", input: "<b>x</b>", expect: "<b>x</b>" },
];

/** Encode a validateName result the way the table states expectations. */
export function encodeResult(r: { ok: true; name: string | null } | { ok: false; rule: string }): string | null {
  return r.ok ? r.name : `invalid:${r.rule}`;
}
