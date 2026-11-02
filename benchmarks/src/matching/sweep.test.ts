import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtureSplit } from "../fixtures/load.js";
import { tauName } from "../benchmark.config.js";
import { distinctNames, measureSweep, moneyEqualSurface, sweepViolations, tauBand, type BandRow, type SweepMeasurement } from "./sweep.js";

// DECISIONS/0006's evidence, committed and asserted. This is why the τ pin is a measurement
// rather than a claim: change the metric, the normalization, or the threshold, and these
// numbers move — the sweep goes red instead of published results quietly meaning something new.
// It runs over the committed dev fixtures only (DECISIONS/0004 forbids tuning against eval/)
// and needs no raw dataset, so it is a per-push gate like every other test here.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

async function devCord() {
  return (await loadFixtureSplit(fixturesRoot, "dev", "cord-v2")).receipts;
}

// The sweep is a pure function of immutable committed fixtures, so one measurement serves the
// whole file. Recomputing ~97,000 edit distances per test would make this the slowest file in
// CI for no additional evidence.
const measurementPromise = devCord().then((receipts) => measureSweep(receipts));

function pinnedRow(measured: SweepMeasurement): BandRow {
  const row = measured.band.find((candidate) => candidate.tau === measured.tau);
  if (!row) throw new Error(`no band row at τ=${measured.tau}`);
  return row;
}

describe("the τ-sweep over the committed dev/cord-v2 fixtures", () => {
  it("holds every guarantee DECISIONS/0006 states", async () => {
    expect(sweepViolations(await measurementPromise)).toEqual([]);
  });

  it("admits zero false candidates on the money-equal surface across the whole safe band", async () => {
    const measured = await measurementPromise;

    expect(measured.band.map((row) => row.tau)).toEqual([...tauBand]);
    for (const row of measured.band) {
      expect(row.moneyEqual.levenshtein, `τ=${row.tau}`).toBe(0);
    }
    // 16 pairs on 100 dev receipts: §8.2 gates on both monetary fields, so a pair whose other
    // amount conflicts is not in this surface at all.
    expect(measured.sizes).toEqual({ moneyEqual: 16, ignoringMoney: 406, sameFirstWord: 60 });
  });

  it("shows the rejected metrics failing the same surface they were rejected on", async () => {
    const measured = await measurementPromise;
    const row = pinnedRow(measured);

    // On the dev money-equal surface, Jaro-Winkler admits 3 of 16 false candidates at τ=0.70
    // (18.8%), including the same-brand-different-dish pattern; Levenshtein admits 0.
    expect(row.moneyEqual).toEqual({ levenshtein: 0, jaro: 3, jaroWinkler: 3 });
    expect(measured.sameBrandDifferentDish).toEqual({
      a: "jamur enoki",
      b: "jamur kuping",
      levenshtein: expect.closeTo(0.5, 6),
      jaroWinkler: expect.closeTo(0.891, 3),
    });
    // Without §8.2's money gate the same three are joined by more: prefix twins dominate.
    expect(row.ignoringMoney).toEqual({ levenshtein: 3, jaro: 13, jaroWinkler: 13 });
    expect(row.sameFirstWord).toEqual({ levenshtein: 5, jaro: 43, jaroWinkler: 43 });
  });

  it("keeps at least 95% of single-substitution and 85% of transposition variants", async () => {
    const row = pinnedRow(await measurementPromise);

    expect(row.substitution.kept / row.substitution.total).toBeGreaterThanOrEqual(0.95);
    expect(row.transposition.kept / row.transposition.total).toBeGreaterThanOrEqual(0.85);
    // Exhaustive, not sampled: every position × every alphabet character that differs, so a
    // reader can reproduce these without trusting a seed.
    expect(row.substitution).toEqual({ kept: 96740, total: 97300 });
    expect(row.transposition).toEqual({ kept: 2021, total: 2089 });
    // The one class the rejected metric wins: Levenshtein keeps 176 of 454 right-clipped names,
    // Jaro-Winkler keeps all 454. DECISIONS/0006 buys the 0 false candidates instead.
    expect(row.truncation).toEqual({ kept: 176, total: 454, jaroWinklerKept: 454 });
  });

  it("tightening past 0.70 costs tolerance and buys no safety", async () => {
    const measured = await measurementPromise;

    for (const row of measured.band) {
      expect(row.moneyEqual.levenshtein, `τ=${row.tau}`).toBe(0);
    }
    const at070 = measured.band.find((row) => row.tau === 0.7)!.transposition;
    const at085 = measured.band.find((row) => row.tau === 0.85)!.transposition;

    expect(at085.kept / at085.total).toBeLessThan(at070.kept / at070.total);
  });

  it("records the fixture facts DECISIONS/0006 accepts as limitations", async () => {
    const measured = await measurementPromise;

    // Exactly one dev gold item prints `-` and normalizes to the empty string.
    expect(measured.emptyNormalizingNames).toBe(1);
    // No name hits a codepoint where toLowerCase() and Unicode casefolding disagree.
    expect(measured.casefoldHazardNames).toEqual([]);
  });

  it("is stable across repeated runs and pins the τ the config declares", async () => {
    const measured = measureSweep(await devCord());

    // Recomputed from a second, independent read of the fixtures: identical bytes to the
    // memoized measurement above, which is the determinism claim DECISIONS/0006 rests on.
    expect(JSON.stringify(measured)).toBe(JSON.stringify(await measurementPromise));
    expect(measured.tau).toBe(tauName);
  });
});

describe("the item tier on a dataset that labels no items", () => {
  it("finds no names and no money-equal surface in dev/sroie", async () => {
    const receipts = (await loadFixtureSplit(fixturesRoot, "dev", "sroie")).receipts;

    expect(distinctNames(receipts)).toEqual([]);
    expect(moneyEqualSurface(receipts)).toEqual([]);
    const measured = measureSweep(receipts);

    expect(measured.moneyEqualPairs).toBe(0);
    expect(measured.band.every((row) => row.moneyEqual.levenshtein === 0)).toBe(true);
    // No surface to measure against is not a pass: the retention denominators are empty, and
    // the sweep says so instead of reporting a vacuous 100%.
    const row = pinnedRow(measured);

    expect(row.substitution.total).toBe(0);
    expect(sweepViolations(measured).filter((violation) => violation.includes("below the"))).toHaveLength(2);
  });
});
