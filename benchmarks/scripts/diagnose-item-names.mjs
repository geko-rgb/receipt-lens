#!/usr/bin/env node
/**
 * Ticket 09b — why is CORD `item.name` F1 0.212? (DECISIONS/0015 C6)
 *
 *   node benchmarks/scripts/diagnose-item-names.mjs [--split dev] [--check]
 *
 * A diagnostic, not a change. τ stays 0.70 and `DECISIONS/0006` stays closed: this file measures which of
 * three explanations the data supports, and writes the answer as a committed artifact so the explanation
 * is re-derivable rather than a story about a session (DECISIONS/0008).
 *
 * The three candidates, and the test that separates them:
 *
 *  1. **The parser extracts the wrong name** (ticket 06's surface). Test: among pairs the matcher *did*
 *     form, how do the predicted names differ from gold — truncation, extra tokens, or unrelated text?
 *  2. **The metric shape is wrong for Indonesian item names** — gold prints the discriminating token
 *     first or last and word order varies. Test: re-score the same pairs with the token order canonicalised
 *     (sorted), using the *same* normalized-Levenshtein function, and count how many name misses that
 *     alone would convert to agreement. High recovery = an ordering effect; low recovery = the text itself
 *     differs, and no reordering or translation would help.
 *  3. **CORD's annotation convention is genuinely different from the printed line** — abbreviations,
 *     modifiers, `-` separated variants. Test: the τ sweep (a metric that only needs loosening would move
 *     steeply) plus the token-overlap distribution of unpaired gold items.
 *
 * Every number here comes out of the committed scorer (`scoring/itemScores.ts`) or the committed matcher
 * (`matching/matcher.ts`); neither is re-implemented in this file, which is the mistake DECISIONS/0008
 * names — a measurement predicate that is not the predicate under test.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@receipt-lens/core";
import { tauName } from "../dist/benchmark.config.js";
import { loadFixtureSplit } from "../dist/fixtures/load.js";
import { matchItems } from "../dist/matching/matcher.js";
import { nameSimilarity, normalizeItemName } from "../dist/matching/similarity.js";
import { scoreReceiptItems } from "../dist/scoring/itemScores.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const split = process.argv.includes("--split") ? process.argv[process.argv.indexOf("--split") + 1] : "dev";
const checkMode = process.argv.includes("--check");
const dataset = "cord-v2";

const { receipts } = await loadFixtureSplit(path.join(repoRoot, "benchmarks", "fixtures"), split, dataset);

const tokens = (name) => normalizeItemName(name).split(" ").filter((token) => token !== "");
const sortedJoin = (name) => [...tokens(name)].sort().join(" ");
/** Gold ⊆ prediction, or prediction ⊆ gold, as token sets — the shape of a truncation or an added modifier. */
const subsetIn = (smaller, larger) => smaller.length > 0 && smaller.every((token) => larger.includes(token));
const jaccard = (left, right) => {
  const shared = left.filter((token) => right.includes(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
};

const missClasses = {};
const missExamples = [];
/**
 * Where the extra tokens came from: `parse()` merges ticket 05's continuation rows into one item, so an
 * item whose name spans more than one source line is the continuation-merge case, and a single-line item
 * is the name-span case (ticket 06 read the whole priced row as the name). The two have different owners.
 */
const extraTokenMissBySourceLines = { singleLine: 0, multipleLines: 0 };
/** How many of the extra-token misses are surplus *digits* — i.e. the quantity, not a descriptor. */
let extraTokenIsNumeric = 0;
const orderOnlyAgreement = { count: 0, examples: [] };
/** Gold items the pinned τ refuses on string order alone — sorted-token similarity would admit them. */
const orderAdmitsPair = { count: 0, examples: [] };
let pairs = 0;
let nameAgreement = 0;
let unpairedGold = 0;
let unpairedGoldAllTokensOnPage = 0;
let bestSimilarityBuckets = { "0.00-0.20": 0, "0.20-0.40": 0, "0.40-0.60": 0, "0.60-0.70": 0, "0.70-0.85": 0, "0.85-1.00": 0 };

for (const receipt of receipts) {
  const items = parse(receipt.ocr).items;
  const match = matchItems(receipt.gold.items, items, tauName);
  const pageTokens = new Set(receipt.ocr.lines.flatMap((line) => line.words.map((word) => normalizeItemName(word.text))));

  for (const pair of match.pairs) {
    pairs += 1;
    const gold = receipt.gold.items[pair.goldIndex];
    const asserted = items[pair.predictedIndex];
    const goldTokens = tokens(gold.name);
    const assertedTokens = tokens(asserted.name);
    if (normalizeItemName(gold.name) === normalizeItemName(asserted.name)) {
      nameAgreement += 1;
      continue;
    }
    let klass = "different_text";
    if (subsetIn(assertedTokens, goldTokens)) klass = "prediction_truncated";
    else if (subsetIn(goldTokens, assertedTokens)) klass = "prediction_has_extra_tokens";
    else if (goldTokens.length === assertedTokens.length && sortedJoin(gold.name) === sortedJoin(asserted.name)) klass = "same_tokens_reordered";
    else if (jaccard(goldTokens, assertedTokens) >= 0.5) klass = "half_the_tokens_shared";
    missClasses[klass] = (missClasses[klass] ?? 0) + 1;
    if (klass === "prediction_has_extra_tokens") {
      const extra = assertedTokens.filter((token) => !goldTokens.includes(token));
      // The shape the examples showed: the surplus is the printed quantity digit, not a word. Counted
      // rather than eyeballed, so the claim about which ticket owns the fix rests on an artifact.
      if (extra.length > 0 && extra.every((token) => /^\d+$/.test(token))) extraTokenIsNumeric += 1;
      if (asserted.sourceLineIds.length > 1) extraTokenMissBySourceLines.multipleLines += 1;
      else extraTokenMissBySourceLines.singleLine += 1;
      if (missExamples.length < 12) {
        missExamples.push({
          receiptId: receipt.receiptId,
          gold: gold.name,
          predicted: asserted.name,
          extraTokens: extra,
          sourceLines: asserted.sourceLineIds.length,
        });
      }
    }

    // Two separate order tests. `orderOnlyAgreement` is the strict one: the same tokens, differently
    // arranged, which canonicalising order would turn into exact field agreement. `orderAdmitsPair` is
    // the gate one: a pair the pinned τ currently refuses that sorted-token similarity would admit.
    if (sortedJoin(gold.name) === sortedJoin(asserted.name)) {
      orderOnlyAgreement.count += 1;
      if (orderOnlyAgreement.examples.length < 8) orderOnlyAgreement.examples.push({ receiptId: receipt.receiptId, gold: gold.name, predicted: asserted.name });
    }
  }

  for (const index of match.unmatchedGold) {
    unpairedGold += 1;
    const gold = receipt.gold.items[index];
    const goldTokens = tokens(gold.name);
    if (goldTokens.every((token) => pageTokens.has(token))) unpairedGoldAllTokensOnPage += 1;
    let best = 0;
    let bestSorted = 0;
    for (const item of items) {
      best = Math.max(best, nameSimilarity(normalizeItemName(gold.name), normalizeItemName(item.name)));
      bestSorted = Math.max(bestSorted, nameSimilarity(sortedJoin(gold.name), sortedJoin(item.name)));
    }
    if (best < tauName && bestSorted >= tauName) {
      orderAdmitsPair.count += 1;
      if (orderAdmitsPair.examples.length < 8) orderAdmitsPair.examples.push({ receiptId: receipt.receiptId, gold: gold.name, bestSimilarity: Math.round(best * 1000) / 1000, sortedSimilarity: Math.round(bestSorted * 1000) / 1000 });
    }
    const bucket = best < 0.2 ? "0.00-0.20" : best < 0.4 ? "0.20-0.40" : best < 0.6 ? "0.40-0.60" : best < 0.7 ? "0.60-0.70" : best < 0.85 ? "0.70-0.85" : "0.85-1.00";
    bestSimilarityBuckets[bucket] += 1;
  }
}

/** The same scorer at other τ values — measurement only; the pinned τ does not move (DECISIONS/0006). */
const tauSweep = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((tau) => {
  const totals = { tp: 0, fp: 0, fn: 0 };
  for (const receipt of receipts) {
    const outcome = scoreReceiptItems(receipt.gold.items, parse(receipt.ocr).items, ["name"], tau);
    totals.tp += outcome.counts.name.tp;
    totals.fp += outcome.counts.name.fp;
    totals.fn += outcome.counts.name.fn;
  }
  const precision = totals.tp + totals.fp === 0 ? 0 : totals.tp / (totals.tp + totals.fp);
  const recall = totals.tp + totals.fn === 0 ? 0 : totals.tp / (totals.tp + totals.fn);
  return {
    tau,
    pinned: tau === tauName,
    pairs: receipts.reduce((sum, receipt) => sum + matchItems(receipt.gold.items, parse(receipt.ocr).items, tau).pairs.length, 0),
    nameTp: totals.tp,
    nameFp: totals.fp,
    nameFn: totals.fn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round((precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)) * 1000) / 1000,
  };
});

const goldItems = receipts.reduce((sum, receipt) => sum + receipt.gold.items.length, 0);
const predictedItems = receipts.reduce((sum, receipt) => sum + parse(receipt.ocr).items.length, 0);
const report = {
  kind: "diagnostic-item-names",
  schemaVersion: "1.0",
  dataset,
  split,
  tauPinned: tauName,
  note: "τ is not changed by this file; DECISIONS/0006 is closed and consumed (DECISIONS/0015 C6).",
  totals: {
    receipts: receipts.length,
    goldItems,
    predictedItems,
    pairsAtPinnedTau: pairs,
    nameAgreementAmongPairs: nameAgreement,
    nameMissesAmongPairs: pairs - nameAgreement,
  },
  nameMissClassesAmongPairs: missClasses,
  extraTokenMissBySourceLines,
  extraTokenIsNumeric,
  nameMissExamples: missExamples,
  orderOnlyAgreement,
  orderAdmitsPair,
  unpairedGold: {
    items: unpairedGold,
    everyTokenPresentSomewhereOnTheReceipt: unpairedGoldAllTokensOnPage,
    bestNameSimilarityToAnyPrediction: bestSimilarityBuckets,
  },
  tauSweep,
};

const target = path.join(repoRoot, "benchmarks", "results", `diagnostic-item-names-${dataset}-${split}.json`);
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (checkMode) {
  const committed = await readFile(target, "utf8").catch(() => null);
  if (committed !== rendered) {
    console.error(`${path.relative(repoRoot, target)} does not re-derive from the committed fixtures and shipped parser`);
    process.exit(1);
  }
  console.log(`${path.relative(repoRoot, target)} re-derives`);
} else {
  await writeFile(target, rendered, "utf8");
  console.log(`wrote ${path.relative(repoRoot, target)}`);
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(JSON.stringify(report.nameMissClassesAmongPairs, null, 2));
  console.log(JSON.stringify(report.extraTokenMissBySourceLines, null, 2));
  console.log(JSON.stringify({ orderOnlyAgreement: report.orderOnlyAgreement.count, orderAdmitsPair: report.orderAdmitsPair.count }, null, 2));
  console.log(report.nameMissExamples.map((example) => `  gold "${example.gold}" ⊆ predicted "${example.predicted}" (+${example.extraTokens.join(" ")}) lines=${example.sourceLines}`).join("\n"));
  console.log(JSON.stringify(report.unpairedGold, null, 2));
  console.log(tauSweep.map((row) => `τ ${row.tau}${row.pinned ? " (pinned)" : "  "}  pairs ${row.pairs}  name F1 ${row.f1}`).join("\n"));
}
