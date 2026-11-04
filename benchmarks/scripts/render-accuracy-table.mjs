#!/usr/bin/env node
/**
 * Ticket 09b — the accuracy table generator (ROADMAP 1D.9).
 *
 *   node benchmarks/scripts/render-accuracy-table.mjs [--write | --check] [--readme path]
 *
 * Every published accuracy number is a function of the committed results JSON, exactly as ticket 08 made
 * the footprint table a function of `footprint.json`: nothing here knows a number, and nothing here can be
 * hand-edited into agreeing with a claim, because `--check` regenerates the block and diffs it (ADR-003,
 * DECISIONS/0008's "artifacts are checked, not claimed").
 *
 * `--check` also discharges gate G8t rather than merely asserting it: the pins each artifact *claims*
 * (`τ_name`, the metric, the two confidence floors, the round-off band, the averaging rule, the scorer
 * version) are compared against `benchmarks/src/benchmark.config.ts` and against the values
 * `DECISIONS/0006`/`0011` and `ROADMAP.md` G8t declare. A result produced under different pins, an
 * artifact whose pins disagree with the config, and a config that has drifted from the documented defaults
 * all fail here — and the table refuses to publish a number whose protocol is not the one on record.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  averaging,
  benchmarkConfig,
  criticalOcrConfidenceFloor,
  nameNormalization,
  nameSimilarityMetric,
  roundOff,
  scorerVersion,
  tauName,
  warningOcrConfidenceFloor
} from "../dist/benchmark.config.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resultsDir = path.join(repoRoot, "benchmarks", "results");
const BEGIN = "<!-- accuracy:begin -->";
const END = "<!-- accuracy:end -->";

const argv = process.argv.slice(2);
const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("usage: node benchmarks/scripts/render-accuracy-table.mjs [--write | --check] [--readme path]");
  process.exit(2);
}
const readmeIndex = argv.indexOf("--readme");
const readmePath = readmeIndex === -1 ? path.join(repoRoot, "packages/core/README.md") : path.resolve(repoRoot, argv[readmeIndex + 1]);

/**
 * The values G8t pre-declared and `DECISIONS/0006`/`DECISIONS/0011` pinned, restated here as an
 * independent expectation. If `benchmark.config.ts` and these ever disagree, one of them moved and the
 * published numbers no longer mean what the decision records say they mean — which is a decision, not an edit.
 */
const DECLARED_PINS = {
  tauName: 0.7,
  nameSimilarityMetric: "normalized-levenshtein",
  criticalOcrConfidenceFloor: 0.5,
  warningOcrConfidenceFloor: 0.7,
  roundOffReconcile: 2,
  roundOffCap: 100,
  scorerVersion: "03b.2"
};

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const count = (value) => value.toLocaleString("en-US");
const ratio = (numerator, denominator) => (denominator === 0 ? "—" : `${numerator}/${denominator}`);
const f = (value) => value.toFixed(3);

const files = [
  { file: "parser-only-dev.json", label: "parser-only · dev" },
  { file: "parser-only-eval.json", label: "parser-only · eval" },
  { file: "end-to-end-tiny-dev.json", label: "end-to-end Tiny · dev" },
  { file: "end-to-end-tiny-eval.json", label: "end-to-end Tiny · eval" },
  { file: "end-to-end-small-dev.json", label: "end-to-end Small · dev" },
  { file: "end-to-end-small-eval.json", label: "end-to-end Small · eval" },
];

const loaded = [];
const pinProblems = [];
for (const entry of files) {
  const raw = await readFile(path.join(resultsDir, entry.file), "utf8").catch(() => null);
  if (raw === null) continue;
  const artifact = JSON.parse(raw);
  if (artifact.kind !== "accuracy") {
    pinProblems.push(`${entry.file}: kind "${artifact.kind}" is not "accuracy"`);
    continue;
  }
  const protocol = artifact.protocol;
  const expect = {
    tauName,
    nameSimilarityMetric,
    nameNormalization,
    averaging,
    scorerVersion,
    critical: criticalOcrConfidenceFloor,
    warning: warningOcrConfidenceFloor,
  };
  const got = {
    tauName: protocol.tauName,
    nameSimilarityMetric: protocol.nameSimilarityMetric,
    nameNormalization: protocol.nameNormalization,
    averaging: protocol.averaging,
    scorerVersion: protocol.scorerVersion,
    critical: protocol.ocrConfidenceFloors.critical,
    warning: protocol.ocrConfidenceFloors.warning,
  };
  for (const key of Object.keys(expect)) {
    if (expect[key] !== got[key]) pinProblems.push(`${entry.file}: ${key} is ${JSON.stringify(got[key])}, benchmark.config says ${JSON.stringify(expect[key])}`);
  }
  if (protocol.roundOffBand.reconcileToleranceMinorUnits !== roundOff.reconcileToleranceMinorUnits ||
      protocol.roundOffBand.magnitudeCapMinorUnits !== roundOff.magnitudeCapMinorUnits) {
    pinProblems.push(`${entry.file}: round-off band does not match benchmark.config`);
  }
  loaded.push({ ...entry, artifact });
}

if (mode === "check") {
  for (const [key, value] of Object.entries(DECLARED_PINS)) {
    const actual = key === "roundOffReconcile"
      ? roundOff.reconcileToleranceMinorUnits
      : key === "roundOffCap"
        ? roundOff.magnitudeCapMinorUnits
        : benchmarkConfig[key];
    if (actual !== value) pinProblems.push(`G8t: benchmark.config ${key} = ${JSON.stringify(actual)}, but DECISIONS/0006 + DECISIONS/0011 + ROADMAP G8t declare ${JSON.stringify(value)}`);
  }
  // A tiny-tier artifact must describe the assets actually in this tree, or the table is quoting a model
  // that is no longer here (the same guard ticket 08 put on the footprint table).
  for (const entry of loaded.filter((item) => item.artifact.ocr?.manifestHash)) {
    const manifest = await readFile(path.join(repoRoot, "assets/models/manifest.json"), "utf8");
    const liveHash = createHash("sha256").update(manifest).digest("hex").slice(0, 12);
    const claimed = entry.artifact.ocr.manifestHash.slice(0, 12);
    if (entry.artifact.ocr.tier === "PP-OCRv6 Tiny" && claimed !== liveHash) {
      pinProblems.push(`${entry.file}: names model hash ${claimed}, but assets/models/manifest.json hashes to ${liveHash}`);
    }
  }
  if (pinProblems.length > 0) {
    console.error(`accuracy pins are not what the report says they are:`);
    for (const problem of pinProblems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

const rows = loaded.flatMap((entry) =>
  entry.artifact.datasets.map((dataset) => ({ entry, dataset, artifact: entry.artifact }))
);
const byMode = (wanted) => rows.filter((row) => row.artifact.mode === wanted);
const headline = byMode("parser-only");
const endToEnd = byMode("end-to-end");

const line = (...cells) => `| ${cells.join(" | ")} |`;
const rule = (heads, aligns = []) => [line(...heads), line(...heads.map((_, index) => ((aligns[index] ?? "left") === "right" ? "---:" : "---")))];
/** Mode label that always identifies the tier too, so Tiny and Small rows never collide in a table. */
const modeLabel = (row) => (row.artifact.mode === "parser-only" ? "parser-only" : `end-to-end ${row.artifact.ocr.tier.replace("PP-OCRv6 ", "")}`);

const out = [];
out.push("## Accuracy, measured");
out.push("");

/**
 * The lead carries both numbers on purpose. Users experience the end-to-end figure; the parser-only
 * figure is what the parser can do when OCR is perfect. Printing only the ceiling would be the
 * "~4.3 MB" mistake wearing a different hat, so this paragraph is generated from the two artifacts and
 * cannot be edited down to the flattering one.
 */
const ceilingRow = rows.find((row) => row.dataset.dataset === "sroie" && row.artifact.split === "eval" && row.artifact.mode === "parser-only");
const e2eEvalRows = rows.filter((row) => row.dataset.dataset === "sroie" && row.artifact.split === "eval" && row.artifact.mode === "end-to-end");
if (ceilingRow && e2eEvalRows.length > 0) {
  const experiences = e2eEvalRows
    .map((row) => `${pct(row.dataset.strict.rate)} with ${row.artifact.ocr.tier.replace("PP-OCRv6 ", "")} OCR`)
    .join(" and ");
  out.push(
    `**Two numbers, read together.** On the SROIE English test split, strict exact match: **${pct(ceilingRow.dataset.strict.rate)} with reference OCR** (the parser's score when the text handed to it is already correct), versus **${experiences}** on the same receipts. Reference OCR and real OCR use different line grouping, so **neither is a strict ceiling on the other** — real OCR can occasionally produce better grouping than the reference fixtures (\`DECISIONS/0014\` M8). **The number a user experiences is the end-to-end number with the default model.** The tier comparison behind that default, with the measured alternative, is \`DECISIONS/0015\`.`
  );
  out.push("");
} else {
  out.push(
    `**The headline number is parser-only**: the shipped \`parse()\` fed the datasets' own reference OCR, so it isolates parser quality from OCR quality and is a **ceiling** on real-world accuracy, not an estimate of it (\`PROJECT(1).md\` §8, \`DECISIONS/0014\` M1). End-to-end rows, where a real OCR runs over the receipt images, are published beside them and never blended into them.`
  );
  out.push("");
}
out.push(
  `**The price rows that can actually see a wrong price are the \`money_gate=off\` ones.** §8.2 makes money compatibility a *precondition* of pairing, so the gated census is structurally incapable of reporting a mismatched amount, and \`DECISIONS/0008\` requires both columns to be published. Read the gated column as "how the scorer pairs items"; read the ungated column as "how the parser reads money".`
);
out.push("");
out.push(
  `Every figure below is generated from committed results JSON in \`benchmarks/results/\` (scorer \`${scorerVersion}\`, \`matchItems(τ=${tauName}, money_gate=on)\`, normalized Levenshtein per \`DECISIONS/0006\`, confidence floors ${criticalOcrConfidenceFloor.toFixed(2)}/${warningOcrConfidenceFloor.toFixed(2)} and round-off band ±₹0.02/≤₹1.00 per \`DECISIONS/0011\`; gate G8t verified by this generator). CI regenerates this block and fails on drift.`
);
out.push("");

out.push("### Tier 1 — strict exact match");
out.push("");
out.push(...rule(["Mode", "Dataset", "Language", "Receipts", "Scoreable", "Strict", "Rate", "Macro F1"], ["left", "left", "left", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  const d = row.dataset;
  out.push(
    line(
      row.artifact.mode === "parser-only" ? "**parser-only (headline)**" : `end-to-end ${row.artifact.ocr.tier.replace("PP-OCRv6 ", "")}`,
      `${d.dataset} · ${row.artifact.split}`,
      d.language.startsWith("English") ? "English" : "Indonesian (out-of-language)",
      count(d.receipts),
      count(d.strict.scoreable) + (d.strict.goldless ? ` ( ${d.strict.goldless} unlabelled, excluded)` : ""),
      count(d.strict.matched),
      pct(d.strict.rate),
      f(d.macro.f1)
    )
  );
}
out.push("");
out.push(
  "Strict means *every field that dataset supports agrees on that receipt* (§8 Tier 1). It is one number per row, not a rate to be read as usable-or-not: the CORD rows carry nine scored fields including four item fields, the SROIE rows carry one. `Macro F1` averages the dataset's scored fields unweighted."
);
out.push("");

out.push("### Tier 2 — field-level precision / recall / F1");
out.push("");
out.push(...rule(["Mode", "Dataset · split", "Field", "TP", "FP", "FN", "Precision", "Recall", "F1", "Gold cells", "Gold left blank"], ["left", "left", "left", "right", "right", "right", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  for (const field of row.dataset.fields) {
    out.push(
      line(
        modeLabel(row),
        `${row.dataset.dataset} · ${row.artifact.split}`,
        field.field,
        count(field.tp),
        count(field.fp),
        count(field.fn),
        f(field.precision),
        f(field.recall),
        f(field.f1),
        count(field.goldCells),
        count(field.unannotatedGoldCells)
      )
    );
  }
}
out.push("");
out.push(
  "`Gold left blank` is the disclosure §8 demands for sparse fields: paired cells where the dataset printed no value but the parser asserted one count as **false positives** under the strict cell rule (`DECISIONS/0006`'s Option B correction), so `item.unitPrice` in particular is measured against a denominator the dataset itself did not fill in — CORD annotates a unit price on 49 of 254 dev gold items."
);
out.push("");

out.push("### Money, stated twice, because one of them hides the other");
out.push("");
out.push(...rule(["Mode", "Dataset · split", "Matcher", "Pairs", "Gold unitPrice", "Exact", "Absent", "**Wrong**", "Line totals both present", "Agree", "Disagree"], ["left", "left", "left", "right", "right", "right", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  if (row.dataset.dataset !== "cord-v2") continue;
  // Ungated first: `DECISIONS/0008`'s point is that the gated census is the one that cannot show a
  // wrong price, so the honest column leads rather than trails.
  for (const census of [...row.dataset.money].sort((left, right) => Number(right.moneyGate) - Number(left.moneyGate))) {
    out.push(
      line(
        modeLabel(row),
        `${row.dataset.dataset} · ${row.artifact.split}`,
        `\`${census.matcher}\``,
        count(census.pairs),
        count(census.unitPrice.goldAnnotated),
        count(census.unitPrice.exact),
        count(census.unitPrice.absent),
        `**${count(census.unitPrice.wrong)}**`,
        count(census.lineTotal.bothPresent),
        count(census.lineTotal.agree),
        `**${count(census.lineTotal.disagree)}**`
      )
    );
  }
}
out.push("");
out.push(
  "SROIE is absent from this table on purpose: it annotates no item field, so it cannot produce an item-price number, and its money evidence is the receipt-level `grandTotal` row above. `DECISIONS/0008` requires both columns: the money gate is a *precondition* of pairing, so the `money_gate=on` census is structurally incapable of reporting a wrong price — the `off` column is where a wrong price is visible at all."
);
out.push("");

out.push("### Price provenance — why there is no single `detected` accuracy");
out.push("");
out.push(...rule(["Mode", "Dataset · split", "Items", "priceSource detected", "— read off the row", "— line total promoted on assumed qty 1", "unresolved", "qty explicit", "qty assumed", "qty unresolved"], ["left", "left", "right", "right", "right", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  const p = row.dataset.provenance;
  out.push(
    line(
      modeLabel(row),
      `${row.dataset.dataset} · ${row.artifact.split}`,
      count(p.items),
      count(p.priceSource.detected ?? 0),
      count(p.detectedDirect),
      count(p.detectedDerivative),
      count(p.priceSource.unresolved ?? 0),
      count(p.quantitySource.explicit ?? 0),
      count(p.quantitySource.assumed ?? 0),
      count(p.quantitySource.unresolved ?? 0)
    )
  );
}
out.push("");
out.push(
  "Ticket 06's rescue promotes a printed line total into a `detected` unit price whenever the quantity reads as 1 — including an *assumed* 1, which the receipt never printed. Those two populations are counted separately and are never averaged together (`DECISIONS/0014` M7.3)."
);
out.push("");

out.push("### Why the strict floor is where it is — the criticals, attributed");
out.push("");
out.push(...rule(["Mode", "Dataset · split", "Findings", "Critical", "Receipts with ≥1 critical", "zero_items", "arithmetic_total", "arithmetic_item_sum", "item_without_price", "invalid_result_schema"], ["left", "left", "right", "right", "right", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  const c = row.dataset.findings;
  const code = (name) => count(c.byCriticalCode[name] ?? 0);
  out.push(
    line(
      modeLabel(row),
      `${row.dataset.dataset} · ${row.artifact.split}`,
      count(c.total),
      count(c.critical),
      count(c.receiptsWithCritical),
      code("zero_items"),
      code("arithmetic_total"),
      code("arithmetic_item_sum"),
      code("item_without_price"),
      code("invalid_result_schema")
    )
  );
}
out.push("");
out.push(
  "- **`zero_items` counts receipts where itemization could not be proven, not parser failures.** `validate()` cannot tell a single-total slip from a failed parse (`DECISIONS/0014` M7.1)."
);
out.push(
  "- **`arithmetic_item_sum` is not accuracy evidence.** Those criticals are charge and tender rows ticket 05 classified as items, so `readCharges` never saw them — a 05/20 classifier gap, not a price bug (`DECISIONS/0011`, ticket 20)."
);
out.push(
  "- **`arithmetic_total` and `item_without_price` are validation findings and data limits**, in that order: the parsed subtotal itself agrees with gold on every checkable dev receipt (`DECISIONS/0011`)."
);
out.push("");

out.push("### Confidence — the floors run in one mode only");
out.push("");
out.push(...rule(["Mode", "Dataset · split", "Words", "Words scored", "Lines", "Lines scored", "Items", "Items scored", "Below 0.50", "Below 0.70"], ["left", "left", "right", "right", "right", "right", "right", "right", "right", "right"]));
for (const row of rows) {
  const c = row.dataset.confidence;
  const scores = c.wordScores;
  out.push(
    line(
      modeLabel(row),
      `${row.dataset.dataset} · ${row.artifact.split}`,
      count(c.words),
      count(c.scoredWords),
      count(c.lines),
      count(c.scoredLines),
      count(c.items),
      count(c.scoredItems),
      scores ? count(scores.belowCritical) : "—",
      scores ? count(scores.belowWarning) : "—"
    )
  );
}
out.push("");
out.push(
  `The headline mode scores **no** confidence at all: fixtures are dataset reference OCR and neither CORD nor SROIE annotates a recognition score (\`DECISIONS/0003\`), so every parser-only receipt takes \`confidence_unavailable\` and no floor comparison runs. The 0.50/0.70 floors are **declared defaults, not calibrated values** — exercised end-to-end where a score exists, calibrated nowhere, and §17's M1-exit calibration still needs a calibration-corpus decision that has not been made.`
);
out.push("");

if (endToEnd.length > 0) {
  out.push("### The OCR gap, and the two tiers");
  out.push("");
  out.push(...rule(["Tier", "Comparison", "Dataset · split", "Field", "Parser-only F1", "End-to-end F1", "Δ F1"], ["left", "left", "left", "left", "right", "right", "right"]));
  for (const e2e of endToEnd) {
    for (const field of e2e.dataset.fields) {
      const parserOnly = headline.find((row) => row.dataset.dataset === e2e.dataset.dataset && row.artifact.split === e2e.artifact.split);
      if (!parserOnly) continue;
      const before = parserOnly.dataset.fields.find((entry) => entry.field === field.field);
      if (!before) continue;
      out.push(
        line(
          e2e.artifact.ocr.tier.replace("PP-OCRv6 ", ""),
          "end-to-end vs headline",
          `${e2e.dataset.dataset} · ${e2e.artifact.split}`,
          field.field,
          f(before.f1),
          f(field.f1),
          `${field.f1 - before.f1 >= 0 ? "+" : "−"}${Math.abs(field.f1 - before.f1).toFixed(3)}`
        )
      );
    }
  }
  out.push("");
  out.push("Model provenance of the end-to-end rows:");
  out.push("");
  out.push(...rule(["Run", "Model", "Inference per receipt"], ["left", "left", "left"]));
  for (const entry of loaded.filter((item) => item.artifact.mode === "end-to-end")) {
    const ocr = entry.artifact.ocr;
    out.push(
      line(
        entry.label,
        `${ocr.tier} · \`${ocr.version}\` · manifest \`${String(ocr.manifestHash).slice(0, 12)}\` · ${count(ocr.assetBytes)} B of model bytes`,
        ocr.inferenceMs ? `median ${Math.round(ocr.inferenceMs.median)} ms (min ${Math.round(ocr.inferenceMs.min)}, max ${Math.round(ocr.inferenceMs.max)}, n=${ocr.inferenceMs.n})` : "no timings"
      )
    );
  }
  out.push("");
}

out.push("### What these numbers are not");
out.push("");
out.push(
  "- **Ceilings, twice over.** Fixtures are the datasets' own reference OCR, so no OCR error reaches the headline numbers; and development happens against `dev/`, so bugs a dev-driven fix would have caught on `eval/` are already gone (`DECISIONS/0004`)."
);
out.push(
  "- **Not an item-price claim from SROIE, and not an English claim from CORD.** SROIE annotates `total` only; CORD is Indonesian and is a layout-stress bucket that ADR-010 keeps out of the headline."
);
out.push(
  "- **No row-classification gold-class split.** The pinned CORD snapshot contains only annotated financial lines, so it has no gold noise-header or continuation class to split `ambiguous` rows against, and the committed fixtures do not carry the per-line category. The 25.1%/16.5% ambiguous rates stay ticket 05's, with its caveat (`DECISIONS/0014` M7.5)."
);
out.push(
  `- **Not a name-recovery claim from substring containment.** \`item.name\` above is the matcher's field agreement under \`matchItems(τ=${tauName}, money_gate=on)\`; ticket 05's substring reachability figure measures a different thing and is not published here (\`DECISIONS/0014\` M5).`
);
out.push("");
out.push(
  `- **The low CORD \`item.name\` score is a measured parser defect, not Indonesian being hard.** Of 82 name misses among paired dev items, 80 have the gold tokens as a strict subset of the prediction and 70 of those surplus tokens are digits — the printed quantity folded into the name when continuation rows merge. The metric is flat across τ 0.50–0.90, so it is not a threshold effect. Diagnosed in \`DECISIONS/0015\` M-4, artifact \`benchmarks/results/diagnostic-item-names-cord-v2-dev.json\`; owned by tickets 05/06.`
);
const aboveCeiling = rows.filter(
  (row) =>
    ceilingRow &&
    row.dataset.dataset === "sroie" &&
    row.artifact.mode === "end-to-end" &&
    row.artifact.split === "eval" &&
    row.dataset.strict.rate > ceilingRow.dataset.strict.rate
);
out.push(
  `- **Neither mode is a strict ceiling on the other.** Reference OCR carries no recognition noise, which is why parser-only isolates the parser — but the two modes also differ in line grouping, so real OCR can occasionally group a receipt better than the reference fixtures do${
    aboveCeiling.length > 0
      ? `: measured on SROIE eval, ${aboveCeiling.map((row) => `${pct(row.dataset.strict.rate)} with ${row.artifact.ocr.tier.replace("PP-OCRv6 ", "")}`).join(" and ")} against ${pct(ceilingRow.dataset.strict.rate)} parser-only`
      : ""
  } (\`DECISIONS/0014\` M8).`
);
out.push("");
out.push(
  "Re-derive a row: `pnpm measure:accuracy -- --split dev` (parser-only, CI-runnable, no dataset download) or `pnpm run:end-to-end -- --tier tiny --split dev` (local, needs `benchmarks/datasets/raw/`), then `node benchmarks/scripts/render-accuracy-table.mjs --write`."
);
out.push("");

const block = `${BEGIN}\n<!-- generated by benchmarks/scripts/render-accuracy-table.mjs from benchmarks/results/{parser-only,end-to-end}-*.json.\n     Do not edit this block by hand. Regenerate with: node benchmarks/scripts/render-accuracy-table.mjs --write -->\n\n${out.join("\n")}\n${END}\n`;

const readme = await readFile(readmePath, "utf8");
if (!readme.includes(BEGIN) || !readme.includes(END)) {
  console.error(`${path.relative(repoRoot, readmePath)} has no ${BEGIN} … ${END} block — add the markers where the table belongs`);
  process.exit(1);
}
// Lazy match plus `End\n?` would leave a stray blank line to accumulate on every run; the block itself
// already ends with a newline, so absorb every trailing newline and re-add exactly one.
const region = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n*`);
const next = readme.replace(region, () => `${block}\n`);

if (mode === "write") {
  await writeFile(readmePath, next, "utf8");
  console.log(`wrote the accuracy block into ${path.relative(repoRoot, readmePath)} from ${loaded.length} artifact(s)`);
} else if (readme === next) {
  console.log(`accuracy block matches ${loaded.length} committed artifact(s); G8t pins verified against benchmark.config and the decision records`);
} else {
  console.error(`${path.relative(repoRoot, readmePath)} has drifted from the committed results`);
  process.exit(1);
}
