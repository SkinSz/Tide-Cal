import { describe, expect, test } from "vitest";
import {
  emptyKnowledge,
  classifyArrival,
  bufferPending,
  advanceApplied,
  neededRanges,
} from "../src/sync/knowledge_state.ts";

describe("DC-02 §7 arrival classification", () => {
  test("contiguous apply", () => {
    const k = emptyKnowledge();
    expect(classifyArrival(k, "p", 1)).toBe("apply");
    advanceApplied(k, "p", 1);
    expect(classifyArrival(k, "p", 2)).toBe("apply");
  });

  test("duplicate detection both applied and pending (TR-7)", () => {
    const k = emptyKnowledge();
    advanceApplied(k, "p", 1);
    expect(classifyArrival(k, "p", 1)).toBe("duplicate");
    bufferPending(k, "p", 3);
    expect(classifyArrival(k, "p", 3)).toBe("duplicate");
  });

  test("gap buffers then drains in order (§7.2)", () => {
    const k = emptyKnowledge();
    advanceApplied(k, "p", 1); // applied_upto[p] = 1
    expect(classifyArrival(k, "p", 3)).toBe("buffer");
    bufferPending(k, "p", 3);
    // gap fills with 2, drain should emit 2 AND 3
    expect(classifyArrival(k, "p", 2)).toBe("apply");
    const drained = advanceApplied(k, "p", 2);
    expect(drained).toEqual([
      { device_id: "p", local_seq: 2 },
      { device_id: "p", local_seq: 3 },
    ]);
    expect(k.appliedUpto["p"]).toBe(3);
  });

  test("reordered delivery converges (TR-8 reorder safety)", () => {
    const orderA = [1, 2, 3, 4];
    const orderB = [4, 1, 3, 2];

    function run(order: number[]): Record<string, number> {
      const k = emptyKnowledge();
      for (const seq of order) {
        const cls = classifyArrival(k, "p", seq);
        if (cls === "apply") advanceApplied(k, "p", seq);
        else if (cls === "buffer") bufferPending(k, "p", seq);
      }
      return k.appliedUpto;
    }
    expect(run(orderB)).toEqual(run(orderA));
  });
});

describe("DC-02 §5 neededRanges (TR-3)", () => {
  test("example from contract §5", () => {
    const k = emptyKnowledge();
    k.appliedUpto = { P: 184, D: 7 };
    bufferPending(k, "D", 9);
    const need = neededRanges(k, { P: 200, D: 9 });
    expect(need).toContainEqual({ device_id: "P", lo: 185, hi: 200 });
    expect(need).toContainEqual({ device_id: "D", lo: 8, hi: 8 });
    expect(need).toHaveLength(2);
  });

  test("pending excluded from ranges", () => {
    const k = emptyKnowledge();
    k.appliedUpto = { P: 10 };
    bufferPending(k, "P", 12);
    bufferPending(k, "P", 14);
    const need = neededRanges(k, { P: 15 });
    expect(need).toEqual([
      { device_id: "P", lo: 11, hi: 11 },
      { device_id: "P", lo: 13, hi: 13 },
      { device_id: "P", lo: 15, hi: 15 },
    ]);
  });

  test("nothing needed when dominated", () => {
    const k = emptyKnowledge();
    k.appliedUpto = { P: 50 };
    expect(neededRanges(k, { P: 40, Q: 3 })).toEqual([
      { device_id: "Q", lo: 1, hi: 3 },
    ]);
  });
});
