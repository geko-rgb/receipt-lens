import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFindings, phaseDescriptions, warmModuleChunkDefect, warmRequestReason, type Finding } from "../../src/footprint/rules.js";

/**
 * DECISIONS/0029 implementation finding 9 — published prose is derived, not typed.
 *
 * Ticket 17c changed what the origin answers, and three strings in the committed artifacts kept describing the
 * origin that changed: `footprint.json`'s warm phase said "this origin answers no 304" in a file whose own totals
 * record two 304s per warm sample, its structural-reason list called the defect 17c had just closed "open", and
 * `warm-bytes.json` said the server sends `no-store` for everything. They were literals in the drivers, so they
 * described the ticket that wrote them rather than the deployment measured.
 *
 * So the text moved into the rule module and these tests bind it three ways: the functions are right, the
 * drivers *call* them (the Blocker-A lesson — a green rule with an unused caller proves nothing), and the
 * committed artifacts' prose equals what the functions derive from the artifacts' own numbers. That last group is
 * what makes the repair auditable: nobody typed a sentence into a measurement.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");
const footprint = JSON.parse(read("benchmarks/results/footprint.json"));
const warmBytes = JSON.parse(read("benchmarks/results/warm-bytes.json"));

const MODULE_CHUNK = "/assets/cache-names-BCswqTtv.js";
const MANIFEST = "/assets/models/manifest.json";

describe("P2/P7 — the phase text states the pass condition as bytes, not as a status", () => {
  it("never claims the origin answers no 304", () => {
    for (const text of Object.values(phaseDescriptions())) {
      expect(text).not.toMatch(/answers no .*304/i);
    }
  });

  it("names what a warm pass means now that a 304 is evidence for the claim", () => {
    const warm = phaseDescriptions().warm;
    expect(warm).toContain("page.reload()");
    expect(warm).toContain("no body");
    expect(warm).toMatch(/304/);
    expect(warm).toContain("DECISIONS/0029");
  });
});

describe("P6/P7 — a structural warm request is explained by the outcome the run showed", () => {
  it("keeps the W6 probe's mechanism legible, because it is the whole warm cost", () => {
    const reason = warmRequestReason(MANIFEST, "redownloaded-200");
    expect(reason).toContain("cache: \"reload\"");
    expect(reason).toContain("DECISIONS/0027 W6");
  });

  it("reports the worker module chunk as closed only when the run closed it", () => {
    const open = warmRequestReason(MODULE_CHUNK, "redownloaded-200");
    const closed = warmRequestReason(MODULE_CHUNK, "revalidated-304");
    expect(open).toContain("the open defect ticket 17c owns");
    expect(closed).not.toContain("open defect");
    expect(closed).toContain("ticket 17c");
    expect(closed).toMatch(/304|If-None-Match/);
  });

  it("still explains the byte-check, and still refuses to explain anything else", () => {
    expect(warmRequestReason("/sw.js", "revalidated-304")).toContain("byte-check");
    expect(warmRequestReason("/something-new.js", "redownloaded-200")).toMatch(/unexplained/);
  });
});

describe("P6 — a warm finding names the asset that carries the cost", () => {
  const previousFinding: Finding = { code: "warm_not_zero", detail: "archived", evidence: "archived", affectsClaim: "archived" };

  it("attributes the whole warm total to the paid path when one path pays all of it", () => {
    const findings = buildFindings({
      previousFinding,
      warmBytes: 2700,
      warmPaths: [MANIFEST, "/sw.js", MODULE_CHUNK],
      moduleChunk: warmModuleChunkDefect(0),
      measuredAt: "2026-11-06T12:00:00.000Z",
      warmOutcomes: { "/sw.js": "revalidated-304", [MODULE_CHUNK]: "revalidated-304", [MANIFEST]: "redownloaded-200" },
      warmPaid: [{ path: MANIFEST, bytes: 2700, reason: warmRequestReason(MANIFEST, "redownloaded-200") }],
    });
    const detail = findings.find((finding) => finding.code === "warm_visit_served_by_service_worker")?.detail ?? "";
    expect(detail).toContain("the whole of it is " + MANIFEST);
    expect(detail).toContain("cache: \"reload\"");
    expect(detail).toContain("2,700");
  });

  it("stays silent about a single payer when the run had several", () => {
    const findings = buildFindings({
      previousFinding,
      warmBytes: 3827,
      warmPaths: [MANIFEST, "/sw.js"],
      moduleChunk: warmModuleChunkDefect(955),
      measuredAt: "2026-11-06T12:00:00.000Z",
      warmOutcomes: { "/sw.js": "redownloaded-200", [MANIFEST]: "redownloaded-200" },
      warmPaid: [
        { path: MANIFEST, bytes: 2700, reason: warmRequestReason(MANIFEST, "redownloaded-200") },
        { path: "/sw.js", bytes: 1127, reason: warmRequestReason("/sw.js", "redownloaded-200") },
      ],
    });
    const detail = findings.find((finding) => finding.code === "warm_visit_served_by_service_worker")?.detail ?? "";
    expect(detail).not.toContain("the whole of it");
  });
});

describe("finding 9 — the committed artifacts read like the code that produced them", () => {
  const phases = phaseDescriptions();

  it("footprint.json's phase text is the rule module's text", () => {
    expect(footprint.measurement.phases.cold.description).toBe(phases.cold);
    expect(footprint.measurement.phases.warm.description).toBe(phases.warm);
    expect(footprint.measurement.phases.repeat.description).toBe(phases.repeat);
  });

  it("every structural warm reason is what the outcome derives", () => {
    const listed = footprint.measurement.deployment.warmStructuralRequests as { path: string; outcome: string; reason: string }[];
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) {
      expect(row.reason, row.path).toBe(warmRequestReason(row.path, row.outcome as never));
    }
  });

  it("the artifact cannot claim an unconditional origin while listing 304s", () => {
    const revalidated = footprint.totals.assetsRevalidatedOnWarmVisits as string[];
    const text = JSON.stringify(footprint.measurement);
    if (revalidated.length > 0) {
      expect(text).not.toMatch(/answers no ["'` ]*304/i);
      expect(text).not.toMatch(/never answers ["'` ]*304/i);
    }
  });

  it("the warm finding names the manifest probe and its mechanism", () => {
    const detail = (footprint.findings as Finding[]).find((finding) => finding.code === "warm_visit_served_by_service_worker")?.detail ?? "";
    expect(detail).toContain(MANIFEST);
    expect(detail).toContain("cache: \"reload\"");
    expect(detail).toContain(footprint.totals.secondVisitBytesOverTheWire.median.toLocaleString("en-US"));
  });

  it("warm-bytes.json describes the two-policy origin it measured", () => {
    const servedBy: string = warmBytes.deployment.servedBy;
    expect(servedBy).toMatch(/no-cache|ETag/);
    expect(servedBy).not.toMatch(/no-store, exactly as the shipping server/);
    // and its own numbers agree with the witness relationship P5 pins
    expect(warmBytes.samples.median).toBe(footprint.totals.secondVisitBytesOverTheWire.median);
  });
});

describe("finding 9 — the drivers call the rule module, they do not paraphrase it", () => {
  const driver = read("benchmarks/scripts/measure-footprint.mjs");
  const warmDriver = read("benchmarks/scripts/measure-warm-bytes.mjs");

  it("measure-footprint.mjs imports both text derivations", () => {
    expect(driver).toMatch(/phaseDescriptions/);
    expect(driver).toMatch(/warmRequestReason/);
    expect(driver).toMatch(/from "\.\.\/dist\/footprint\/rules\.js"/);
  });

  it("no driver carries a literal copy of the phase or reason text", () => {
    expect(driver).not.toMatch(/answers no .*304/);
    expect(driver).not.toMatch(/the open defect ticket 17c owns/);
    expect(driver).not.toMatch(/version probe, deliberately cache/);
    expect(warmDriver).not.toMatch(/no-store, exactly as the shipping server/);
  });
});

describe("checkpoint 3 — the README publishes the cross-ticket latency comparison, not a reassurance", () => {
  const readme = read("packages/core/README.md");
  const supersededPath = (footprint.findings as Finding[])
    .flatMap((finding) => finding.history ?? [])
    .map((entry) => entry.artifact as string)
    .filter((artifact) => artifact.startsWith("footprint-"))
    .at(-1);

  it("the superseded artifact is discoverable from this one", () => {
    expect(supersededPath).toBeTruthy();
    const previous = JSON.parse(read("benchmarks/results/" + supersededPath));
    expect(previous.git.shortRevision).not.toBe(footprint.git.shortRevision);
  });

  it("the block names both runs, both cold medians and the non-overlap", () => {
    const section = readme.slice(readme.indexOf("### How this run's latency compares to the one it replaced"));
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain(footprint.git.shortRevision);
    expect(section).toContain(JSON.parse(read("benchmarks/results/" + supersededPath)).git.shortRevision);
    expect(section).toMatch(/not re-rolled/);
    expect(section).toMatch(/overlap/);
  });

  it("the comparison quotes the artifacts' numbers rather than a copy", () => {
    const previous = JSON.parse(read("benchmarks/results/" + supersededPath));
    const oneDecimal = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const cells = [
      ["desktop-chromium-unthrottled", "cold"],
      ["desktop-chromium-unthrottled", "warm"],
      ["desktop-chromium-cpu4x", "cold"],
      ["desktop-chromium-cpu4x", "warm"],
    ] as const;
    const section = readme.slice(readme.indexOf("### How this run's latency compares to the one it replaced"));
    for (const [classId, phase] of cells) {
      for (const stat of [previous.latency[classId][phase].firstResultMs, footprint.latency[classId][phase].firstResultMs]) {
        expect(section).toContain(oneDecimal(stat.median));
      }
    }
  });
});
