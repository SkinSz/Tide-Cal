// Pkg1 generative property test (QA C-1): bounded randomized interleaving of
// creates, updates, deletes, syncs, snapshot exchange, compaction, restart,
// and fresh-peer bootstrap — every checkpoint compared against the
// INDEPENDENT expected-state oracle (tests/pkg1_helpers.ts ExpectedState).
//
// Determinism: seeded PRNG (mulberry32). Seed: fixed by default; override via
// PKG1_SEED env var. The seed is logged — a failing seed reproduces exactly.
// Schedule note: mutations are barriered by convergence rounds, so the
// expected state uses exact sequential semantics; conflict resolution is
// Pkg5's surface and deliberately out of scope here (see pkg1-diagnosis §8).
import { expect, test } from "vitest";
import {
  assertAgainstOracle,
  closeDevices,
  convergeRound,
  ExpectedState,
  makeDevice,
  restartDevice,
  semanticEvents,
  sessionOnce,
  sweepOn,
  type Device,
} from "./pkg1_helpers.ts";

const SEED = Number(process.env.PKG1_SEED ?? 20260830);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test(`P1.PROP generative: compaction × snapshot × restart vs independent oracle (seed=${SEED})`, async () => {
  console.log(`[pkg1-prop] seed=${SEED}`);
  const rng = mulberry32(SEED);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const expected = new ExpectedState();
  let nextEvent = 0;

  const devices: Device[] = [makeDevice("A"), makeDevice("B")];
  const liveIds: string[] = [];

  try {
    for (let step = 0; step < 24; step++) {
      const roll = rng();
      if (roll < 0.30) {
        // CREATE on a random device
        const d = pick(devices);
        const ev = d.core.createEvent({
          title: `gen-${nextEvent}`,
          description: `step-${step}`,
          startMs: 1_750_000_000_000 + nextEvent * 3600_000,
          endMs: 1_750_000_000_000 + nextEvent * 3600_000 + 1800_000,
          allDay: false,
        });
        nextEvent++;
        expected.create(ev);
        liveIds.push(ev.id);
      } else if (roll < 0.50 && liveIds.length > 0) {
        // UPDATE a random live event on a random device
        const id = pick(liveIds);
        const d = pick(devices);
        const cur = expected.events.get(id)!;
        const input = {
          title: `${cur.title}~u${step}`,
          description: cur.description,
          startMs: cur.startMs,
          endMs: cur.endMs,
          allDay: cur.allDay,
        };
        d.core.updateEvent(id, input);
        expected.update({ id, ...input } as never);
      } else if (roll < 0.58 && liveIds.length > 2) {
        // DELETE a random live event
        const idx = Math.floor(rng() * liveIds.length);
        const id = liveIds.splice(idx, 1)[0]!;
        pick(devices).core.deleteEvent(id);
        expected.delete(id);
      } else if (roll < 0.70) {
        // COMPACTION on a random device (constraint set = all others)
        const idx = Math.floor(rng() * devices.length);
        const target = devices[idx]!;
        const others = devices.filter((_, i) => i !== idx);
        sweepOn(target, others);
      } else if (roll < 0.78 && devices.length < 5) {
        // FRESH PEER bootstrap
        devices.push(makeDevice(`P${devices.length}`));
      } else if (roll < 0.86) {
        // RESTART a random device (durable state must carry over)
        const idx = Math.floor(rng() * devices.length);
        devices[idx] = restartDevice(devices[idx]!);
      } else if (roll < 0.92 && devices.length > 2) {
        // single directional session (snapshot exchange pressure)
        let from = pick(devices);
        let to = pick(devices);
        if (from === to) to = devices[(devices.indexOf(from) + 1) % devices.length]!;
        await sessionOnce(from, to);
      }
      // every step: full convergence barrier + oracle checkpoint
      await convergeRound(devices);
      const oracle = assertAgainstOracle(expected, devices);
      expect(
        oracle.ok,
        `step ${step}: ${oracle.detail} (seed=${SEED})`,
      ).toBe(true);
    }

    // final soak: repeated snapshot exchanges must remain lossless
    for (let i = 0; i < 2; i++) await convergeRound(devices);
    const oracle = assertAgainstOracle(expected, devices);
    expect(oracle.ok, `final: ${oracle.detail} (seed=${SEED})`).toBe(true);
    expect(semanticEvents(devices[0]!.db).size).toBe(expected.events.size);
    console.log(
      `[pkg1-prop] OK seed=${SEED} devices=${devices.length} events=${expected.events.size} deleted=${expected.deleted.length}`,
    );
  } finally {
    closeDevices(devices);
  }
}, 120000);
