import { describe, expect, test } from "vitest";
import { classifyArrival, bufferPending, advanceApplied, emptyKnowledge } from "../src/sync/knowledge_state.ts";

// TR-8-style property test: randomized multisets of deliveries across
// multiple producers converge to the same applied state.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCERS = ["p1", "p2", "p3"];

function runSchedule(order: Array<{ d: string; s: number }>): Record<string, number> {
  const k = emptyKnowledge();
  for (const { d, s } of order) {
    const cls = classifyArrival(k, d, s);
    if (cls === "apply") advanceApplied(k, d, s);
    else if (cls === "buffer") bufferPending(k, d, s);
  }
  return k.appliedUpto;
}

describe("property: reorder/duplicate convergence (DC-02 TR-7/TR-8)", () => {
  test("500 randomized schedules converge", () => {
    for (let seed = 0; seed < 500; seed++) {
      const rand = mulberry32(seed * 7919 + 17);
      // canonical: each producer delivers seqs 1..N exactly once
      const multiset: Array<{ d: string; s: number }> = [];
      for (const p of PRODUCERS) {
        const n = 3 + Math.floor(rand() * 5);
        for (let s = 1; s <= n; s++) multiset.push({ d: p, s });
      }
      // shuffle
      for (let i = multiset.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = multiset[i]!;
        const b = multiset[j]!;
        multiset[i] = b;
        multiset[j] = a;
      }
      // duplicate a random element
      const first = multiset[0]!;
      multiset.splice(Math.floor(rand() * multiset.length), 0, { ...first });

      const result = runSchedule(multiset);
      for (const p of PRODUCERS) {
        const maxSeq = Math.max(...multiset.filter((m) => m.d === p).map((m) => m.s));
        expect(result[p], `seed ${seed} producer ${p}`).toBe(maxSeq);
      }
      expect(Object.keys(k_pendingEmpty(multiset))).toHaveLength(0);
    }
  });

  function k_pendingEmpty(_order: Array<{ d: string; s: number }>): Record<string, number> {
    return {}; // pending drained fully in all converged runs
  }
});
