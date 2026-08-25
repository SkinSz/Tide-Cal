import { describe, expect, test } from "vitest";
import { detect, effectiveValue, type ConflictRecord } from "../src/sync/conflict_detection.ts";
import { makeChange } from "./change_record.test.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

// DC-03 §6 worked scenarios
describe("DC-03 detection", () => {
  test("TR-2: same-field concurrency -> conflict preserving both", () => {
    const local = makeChange({ device_id: "d-phone", local_seq: 184, clock: { "d-phone": 184, "d-desktop": 72 }, value: "Dentist" });
    const incoming = makeChange({ device_id: "d-desktop", local_seq: 75, clock: { "d-desktop": 75, "d-phone": 180 }, value: "Doctor" });
    const out = detect(incoming, { deleted: false, value: "Dentist" }, [local]);
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.conflicting).toEqual([local]);
    }
  });

  test("TR-3: different-field concurrency applies cleanly", () => {
    const titleEdit = makeChange({ device_id: "d-p", field_path: "title", clock: { "d-p": 5 } });
    const descEdit = makeChange({ device_id: "d-d", field_path: "description", clock: { "d-d": 4 } });
    // caller only passes locals touching SAME (entity_id, field_path)
    const out = detect(descEdit, { deleted: false, value: "" }, []);
    expect(out.kind).toBe("apply");
  });

  test("TR-1: causal-after applies cleanly", () => {
    const early = makeChange({ device_id: "d-p", local_seq: 1, value: "old", clock: { "d-p": 1 } });
    const late = makeChange({ device_id: "d-p", local_seq: 2, value: "new", clock: { "d-p": 2 } });
    expect(detect(late, effectiveValue(early), [early]).kind).toBe("apply");
  });

  test("TR-5: identical-value convergence is a no-op under concurrency", () => {
    const local = makeChange({ device_id: "d-p", value: "Dentist", clock: { "d-p": 9 } });
    const incoming = makeChange({ device_id: "d-d", value: "Dentist", clock: { "d-d": 8 } });
    expect(detect(incoming, { deleted: false, value: "Dentist" }, [local]).kind).toBe(
      "noop",
    );
  });

  test("TR-4: delete-vs-edit concurrency preserves conflict", () => {
    const deleter = makeChange({ device_id: "d-p", operation: "remove", payload: {}, clock: { "d-p": 3 } });
    const editor = makeChange({ device_id: "d-d", value: "moved", clock: { "d-d": 2 } });
    const out = detect(editor, { deleted: true, value: undefined }, [deleter]);
    expect(out.kind).toBe("conflict");
    // symmetric direction
    const out2 = detect(deleter, { deleted: false, value: "moved" }, [editor]);
    expect(out2.kind).toBe("conflict");
  });

  test("DC-03 §6.1 spec example: Dentist vs Doctor", () => {
    const phone = makeChange({ entity_id: "e-a1b2", device_id: "d-phone", local_seq: 184, clock: { "d-phone": 184, "d-desktop": 72 }, value: "Dentist" });
    const desktop = makeChange({ entity_id: "e-a1b2", device_id: "d-desktop", local_seq: 75, clock: { "d-desktop": 75, "d-phone": 180 }, value: "Doctor" });
    expect(detect(desktop, effectiveValue(phone), [phone]).kind).toBe("conflict");
  });

  test("multi-participant collapse (§3.5)", () => {
    const l1 = makeChange({ device_id: "d-1", value: "a", clock: { "d-1": 10 } });
    const l2 = makeChange({ device_id: "d-2", value: "b", clock: { "d-2": 11 } });
    const inc = makeChange({ device_id: "d-3", value: "c", clock: { "d-3": 12 } });
    const out = detect(inc, { deleted: false, value: "local" }, [l1, l2]);
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") expect(out.conflicting).toHaveLength(2);
  });
});

describe("DC-03 conflict record shape (§4)", () => {
  test("record holds both payloads verbatim + status unresolved", () => {
    const rec: ConflictRecord = {
      conflict_id: "c-123",
      entity_id: "e-a1b2",
      field_path: "title",
      participants: [
        {
          change_id: "d-phone:184",
          device_id: "d-phone",
          local_seq: 184,
          causality_clock: { "d-phone": 184 },
          payload: { value: "Dentist" },
        },
        {
          change_id: "d-desktop:75",
          device_id: "d-desktop",
          local_seq: 75,
          causality_clock: { "d-desktop": 75 },
          payload: { value: "Doctor" },
        },
      ],
      detected_at_hlc: 1724600000999,
      status: "unresolved",
    };
    expect(rec.status).toBe("unresolved");
    expect(rec.participants).toHaveLength(2);
  });
});
