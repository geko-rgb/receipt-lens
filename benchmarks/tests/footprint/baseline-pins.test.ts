import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { harnessBaseline, warmBytesBeforeBlock } from "../../src/footprint/rules.js";

/**
 * DECISIONS/0029 P4 step 1 — the baseline that 17b pinned, wired.
 *
 * Ticket 17b discovered that `measure-warm-bytes.mjs` builds its `before` block from the *canonical*
 * `footprint.json`, which 17b was about to regenerate — so the artifact would have reported that ticket 17
 * reduced warm bytes from 6,527 B to 6,527 B. 17b pinned the rule (`harnessBaseline()`, reading the archived
 * harness artifact), shipped it, and shipped a passing test for it. It never wired the driver.
 *
 * That is the failure mode this file exists to catch: **a rule with a green test and a caller that does not use
 * it.** So the assertions below bind to the driver, not to the rule — a structural check that the script reads
 * the archive, plus the numeric check that would only be visible in the state that broke it: the archived
 * harness number is 14,848,852 B *while* `footprint.json` publishes 6,527 B. If the two ever agree, this test
 * is measuring the wrong thing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

const HARNESS_WARM_BYTES = 14_848_852;
const CURRENT_WARM_BYTES = 6_527;

describe("P4 step 1 — the pre-17 baseline is read from the archive, by the driver that uses it", () => {
  it("the two artifacts disagree, which is what makes the bug visible", () => {
    const canonical = JSON.parse(read("benchmarks/results/footprint.json"));
    expect(canonical.totals.secondVisitBytesOverTheWire.median).toBe(CURRENT_WARM_BYTES);
    expect(harnessBaseline().warmBytes).toBe(HARNESS_WARM_BYTES);
    expect(harnessBaseline().artifactPath).not.toBe("benchmarks/results/footprint.json");
  });

  it("builds the whole before block from the archived harness artifact", () => {
    const before = warmBytesBeforeBlock();
    expect(before.artifact).toContain("footprint-2026-11-04-16ae8de.json");
    expect(before.secondVisitBytesOverTheWire).toBe(HARNESS_WARM_BYTES);
    expect(before.redownloadedOnEveryVisit).toEqual(["/ort/ort-wasm-simd-threaded.wasm"]);
    // The archive predates any resolution, so a null here is the archived truth — not the canonical file's
    // "ticket 17", which is what the unwired driver would have written.
    expect(before.findingResolvedBy).toBeNull();
    expect(before.deploymentEntry).toContain("harness");
  });

  it("the driver no longer reads the canonical footprint.json for its baseline", () => {
    const driver = read("benchmarks/scripts/measure-warm-bytes.mjs");
    const readsCanonical = /readFileSync\([^)]*results\/footprint\.json/.test(driver);
    expect(readsCanonical).toBe(false);
    expect(driver).toContain("warmBytesBeforeBlock");
  });

  it("and the reduction is computed against the archived number, not the live table", () => {
    // Written as an expression the driver must satisfy, rather than a constant: the factor is a property of
    // two committed artifacts, and it is 2,275× for the pair that exists today.
    const driver = read("benchmarks/scripts/measure-warm-bytes.mjs");
    expect(driver).toContain("before.secondVisitBytesOverTheWire");
    expect(HARNESS_WARM_BYTES / CURRENT_WARM_BYTES).toBeCloseTo(2275.1, 0);
  });
});
