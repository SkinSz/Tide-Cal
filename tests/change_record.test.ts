import { describe, expect, test } from "vitest";
import {
  changeId,
  validateChangeRecord,
  ChangeRecordError,
  type ChangeRecord,
  type VectorClock,
} from "../src/sync/change_record.ts";
import {
  dominates,
  equalClocks,
  concurrent,
  merge,
  causallyBefore,
} from "../src/sync/vector_clock.ts";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(8).toString("hex");
}

export function makeChange(opts: Partial<ChangeRecord> & { device_id?: string; local_seq?: number; clock?: VectorClock; value?: unknown }): ChangeRecord {
  const device_id = opts.device_id ?? `d-${uid()}`;
  const local_seq = opts.local_seq ?? 1;
  const clock = opts.clock ?? { [device_id]: local_seq };
  return {
    change_id: changeId(device_id, local_seq),
    device_id,
    local_seq,
    entity_id: opts.entity_id ?? `e-${uid()}`,
    entity_type: opts.entity_type ?? "event",
    field_path: opts.field_path ?? "title",
    operation: opts.operation ?? "set",
    payload: opts.payload ?? { value: opts.value ?? "x" },
    hlc_timestamp: opts.hlc_timestamp ?? Date.now(),
    causality_clock: clock,
    schema_version: 1,
    ...(opts as object),
  } as ChangeRecord;
}

describe("DC-01 TR-1 change_id uniqueness/format", () => {
  test("change_id = device_id:local_seq", () => {
    expect(changeId("d-abc", 184)).toBe("d-abc:184");
  });

  test("validation rejects id mismatch", () => {
    const r = makeChange({ device_id: "d-a", local_seq: 2 });
    expect(() =>
      validateChangeRecord({ ...r, change_id: "d-a:3" }),
    ).toThrowError(ChangeRecordError);
  });
});

describe("DC-01 validation (TR-4 analog)", () => {
  test("valid record round-trips", () => {
    const r = makeChange({});
    expect(validateChangeRecord(r)).toMatchObject({ change_id: r.change_id });
  });

  test("rejects invalid operation", () => {
    const r = makeChange({});
    expect(() => validateChangeRecord({ ...r, operation: "upsert" })).toThrowError(
      ChangeRecordError,
    );
  });

  test("rejects bad local_seq", () => {
    const r = makeChange({ local_seq: 0 });
    expect(() => validateChangeRecord(r)).toThrowError(/local_seq/);
  });

  test("rejects non-integer causality entries", () => {
    const r = makeChange({});
    expect(() =>
      validateChangeRecord({
        ...r,
        causality_clock: { "d-x": 1.5 },
      }),
    ).toThrowError(ChangeRecordError);
  });
});

describe("DC-02 §3 comparison algebra", () => {
  const P = { P: 184, D: 72 };
  const D = { P: 180, D: 75 };

  test("worked example: concurrent", () => {
    expect(dominates(P, D)).toBe(false);
    expect(dominates(D, P)).toBe(false);
    expect(concurrent(P, D)).toBe(true);
  });

  test("causal-after dominates", () => {
    const a = { P: 185, D: 75 };
    const b = { P: 184, D: 72 };
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
    expect(concurrent(a, b)).toBe(false);
  });

  test("extra knowledge dominates (absent = 0)", () => {
    expect(dominates({ P: 184, D: 72, T: 5 }, { P: 184, D: 72 })).toBe(true);
    expect(dominates({ P: 184, D: 72 }, { P: 184, D: 72, T: 5 })).toBe(false);
  });

  test("equal clocks are not concurrent", () => {
    expect(equalClocks(P, { P: 184, D: 72 })).toBe(true);
    expect(concurrent(P, { ...P })).toBe(false);
  });

  // TR-1 properties
  test("dominates is reflexive and antisymmetric-ish", () => {
    const samples: VectorClock[] = [P, D, { P: 1 }, {}];
    for (const c of samples) {
      expect(dominates(c, c)).toBe(true);
      if (!equalClocks(c, { P: 1 })) {
        expect(dominates(c, { P: 1 }) && dominates({ P: 1 }, c)).toBe(
          equalClocks(c, { P: 1 }),
        );
      }
    }
  });

  test("concurrent is symmetric", () => {
    const x = { A: 3, B: 1 };
    const y = { A: 2, B: 4 };
    expect(concurrent(x, y)).toBe(concurrent(y, x));
  });
});

describe("DC-02 merge algebra (TR-2)", () => {
  const samples: VectorClock[] = [
    { A: 1, B: 2 },
    { B: 5, C: 7 },
    {},
    { A: 9 },
  ];
  test("commutative", () => {
    for (const a of samples)
      for (const b of samples) {
        expect(equalClocks(merge(a, b), merge(b, a))).toBe(true);
      }
  });
  test("idempotent", () => {
    for (const a of samples) expect(equalClocks(merge(a, a), a)).toBe(true);
  });
  test("associative", () => {
    for (const a of samples)
      for (const b of samples)
        for (const c of samples) {
          expect(
            equalClocks(merge(merge(a, b), c), merge(a, merge(b, c))),
          ).toBe(true);
        }
  });
});

describe("DC-02 causallyBefore", () => {
  const mk = (device_id: string, local_seq: number, clock: VectorClock) => ({
    device_id,
    local_seq,
    clock,
  });
  test("later change on same producer is causallyBefore-able", () => {
    const early = mk("d-p", 184, { "d-p": 184, "d-d": 71 });
    const late = mk("d-p", 185, { "d-p": 185, "d-d": 71 });
    expect(causallyBefore(early, late)).toBe(true);
    expect(causallyBefore(late, early)).toBe(false);
  });
});
