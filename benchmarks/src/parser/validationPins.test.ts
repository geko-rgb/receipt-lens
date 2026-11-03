import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRows,
  matchesTenderFamily,
  parse,
  profileForRows,
  readMoney,
  validate,
  type OcrResult,
  type ParsedItem,
  type ParseResult,
} from "@receipt-lens/core";
import { loadFixtureSplit } from "../fixtures/load.js";
import { matchItems } from "../matching/matcher.js";
import { nameSimilarity, normalizeItemName } from "../matching/similarity.js";
import type { LabeledReceipt } from "../datasets/types.js";

// Every number DECISIONS/0011 publishes about what `validate()` can actually see, re-derived from the
// shipped parser over `benchmarks/fixtures/dev/` only (250 receipts; nothing read from `eval/`, per
// DECISIONS/0004). Same role as `quantityMoneyPins.test.ts` for DECISIONS/0010: 07's conditional table
// is a claim about operand presence in the corpus, and a claim that cannot be regenerated from a
// committed check is a claim about a session.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

async function dev(): Promise<readonly LabeledReceipt[]> {
  const cord = await loadFixtureSplit(fixturesRoot, "dev", "cord-v2");
  const sroie = await loadFixtureSplit(fixturesRoot, "dev", "sroie");
  return [...cord.receipts, ...sroie.receipts];
}

const FLOOR_CRITICAL = 0.5;
const FLOOR_WARNING = 0.7;

/** 06's own money exclusions, reused verbatim so 07 never measures with a looser predicate than the parser (DECISIONS/0010's correction table). */
const BARE_INTEGER = /^\d{1,2}$/;
function rowMoney(words: readonly { text: string }[], profile: ReturnType<typeof profileForRows>) {
  const out: { text: string; paise: number; marker: boolean }[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (/%/.test(text)) continue;
    const reading = readMoney(text, profile);
    if (reading.paise === null) continue;
    if (BARE_INTEGER.test(text) && reading.paise !== 0) continue;
    out.push({ text, paise: reading.paise, marker: reading.unitPriceMarker });
  }
  return out;
}

interface ReceiptView {
  readonly receipt: LabeledReceipt;
  readonly parsed: ParseResult;
  readonly words: ReadonlyMap<string, readonly { text: string }[]>;
  readonly profile: ReturnType<typeof profileForRows>;
}

async function views(): Promise<ReceiptView[]> {
  const receipts = await dev();
  return receipts.map((receipt) => {
    const parsed = parse(receipt.ocr);
    const { rows } = classifyRows(receipt.ocr);
    const profile = profileForRows(rows.map((entry) => entry.row));
    const words = new Map<string, readonly { text: string }[]>(
      receipt.ocr.lines.map((line: OcrResult["lines"][number]) => [line.id, line.words])
    );
    return { receipt, parsed, profile, words };
  });
}

/** The additive charge sum §6's formula uses, or null when an operand's semantics are not established. */
function computedBase(parsed: ParseResult): number | null {
  if (parsed.subtotal === null) return null;
  if (parsed.taxes.some((tax) => tax.amount === null)) return null;
  if (parsed.otherCharges.some((charge) => charge.amount === null || charge.sign === "unknown")) return null;
  let base = parsed.subtotal;
  for (const tax of parsed.taxes) if (!tax.included) base += tax.amount ?? 0;
  for (const charge of parsed.otherCharges) {
    if (charge.included) continue;
    base += charge.sign === "subtract" ? -(charge.amount ?? 0) : (charge.amount ?? 0);
  }
  base += parsed.serviceCharge ?? 0;
  base += parsed.tip ?? 0;
  base -= parsed.discount ?? 0;
  return base;
}

describe("DECISIONS/0011 — the corpus validate() sees", () => {
  it("dev reference OCR supplies no confidence at all, so the floors are unexercisable on dev", async () => {
    const receipts = await dev();
    let words = 0;
    let wordScores = 0;
    let lines = 0;
    let lineScores = 0;
    for (const receipt of receipts) {
      for (const line of receipt.ocr.lines) {
        lines += 1;
        if (line.confidence !== null) lineScores += 1;
        for (const word of line.words) {
          words += 1;
          if (word.confidence !== null) wordScores += 1;
        }
      }
    }
    expect(receipts.length).toBe(250);
    expect({ words, wordScores, lines, lineScores }).toEqual({ words: 10424, wordScores: 0, lines: 5604, lineScores: 0 });

    // Consequently every parsed item's confidence is null: 07's item-scoped checks never fire on dev,
    // and the whole corpus takes the `confidence_unavailable` path.
    const all = await views();
    const items = all.flatMap((view) => [...view.parsed.items]);
    expect(items.length).toBe(518);
    expect(items.filter((item) => item.confidence === null).length).toBe(518);
    expect(items.filter((item) => item.confidence !== null && item.confidence < FLOOR_CRITICAL).length).toBe(0);
    expect(items.filter((item) => item.confidence !== null && item.confidence >= FLOOR_WARNING).length).toBe(0);
  });

  it("operand presence: the counts that make each arithmetic check conditional", async () => {
    const all = await views();
    const present = (pick: (p: ParseResult) => boolean) => all.filter((view) => pick(view.parsed)).length;
    const got = {
      anyItem: present((p) => p.items.length > 0),
      subtotal: present((p) => p.subtotal !== null),
      grandTotal: present((p) => p.grandTotal !== null),
      subtotalAndGrand: present((p) => p.subtotal !== null && p.grandTotal !== null),
      taxes: present((p) => p.taxes.length > 0),
      serviceCharge: present((p) => p.serviceCharge !== null),
      tip: present((p) => p.tip !== null),
      discount: present((p) => p.discount !== null),
      roundOff: present((p) => p.roundOff !== null),
      otherCharges: present((p) => p.otherCharges.length > 0),
      preservedRows: present((p) => p.unclassifiedRows.length > 0),
      fullLineTotalCoverage: present((p) => p.items.length > 0 && p.items.every((item) => item.lineTotal !== null)),
    };
    expect(got).toEqual({
      anyItem: 208,
      subtotal: 82,
      grandTotal: 213,
      subtotalAndGrand: 73,
      taxes: 117,
      serviceCharge: 19,
      tip: 0,
      discount: 43,
      roundOff: 3,
      otherCharges: 14,
      preservedRows: 172,
      fullLineTotalCoverage: 206,
    });
  });

  it("item-sum reconciliation splits by direction, which is what chooses critical vs may-be-missing", async () => {
    const all = await views();
    let comparable = 0;
    let equal = 0;
    let over = 0;
    let under = 0;
    let blockedNoSubtotal = 0;
    let blockedCoverage = 0;
    let blockedNoItems = 0;
    for (const view of all) {
      const { parsed } = view;
      if (parsed.items.length === 0) {
        blockedNoItems += 1;
        continue;
      }
      const withTotal = parsed.items.filter((item) => item.lineTotal !== null);
      const full = withTotal.length === parsed.items.length;
      if (parsed.subtotal === null) {
        if (full) blockedNoSubtotal += 1;
        continue;
      }
      if (!full) {
        blockedCoverage += 1;
        continue;
      }
      comparable += 1;
      const sum = withTotal.reduce((total, item) => total + (item.lineTotal ?? 0), 0);
      if (sum === parsed.subtotal) equal += 1;
      else if (sum > parsed.subtotal) over += 1;
      else under += 1;
    }
    expect({ comparable, equal, over, under, blockedNoSubtotal, blockedCoverage, blockedNoItems }).toEqual({
      comparable: 69,
      equal: 25,
      over: 27,
      under: 17,
      blockedNoSubtotal: 137,
      blockedCoverage: 1,
      blockedNoItems: 42,
    });
  });

  it("total reconciliation runs only where every operand and its semantics are known, and the misses are not small change", async () => {
    const all = await views();
    let comparable = 0;
    let equal = 0;
    let mismatch = 0;
    let withinImplicitRoundOffBand = 0;
    let roundOffPrinted = 0;
    let roundOffInBand = 0;
    let blockedSemantics = 0;
    for (const view of all) {
      const { parsed } = view;
      if (parsed.grandTotal === null) continue;
      if (parsed.otherCharges.some((c) => c.sign === "unknown" || c.amount === null) ||
        parsed.taxes.some((tax) => tax.amount === null)) {
        blockedSemantics += 1;
        continue;
      }
      const base = computedBase(parsed);
      if (base === null) continue;
      const expected = parsed.grandTotal - base;
      if (parsed.roundOff !== null) {
        roundOffPrinted += 1;
        if (Math.abs(parsed.roundOff - expected) <= 2 && Math.abs(parsed.roundOff) <= 100) roundOffInBand += 1;
        continue;
      }
      comparable += 1;
      if (expected === 0) equal += 1;
      else {
        mismatch += 1;
        if (Math.abs(expected) <= 100) withinImplicitRoundOffBand += 1;
      }
    }
    expect({ comparable, equal, mismatch, withinImplicitRoundOffBand, roundOffPrinted, roundOffInBand, blockedSemantics }).toEqual({
      comparable: 68,
      equal: 35,
      mismatch: 33,
      withinImplicitRoundOffBand: 5,
      roundOffPrinted: 1,
      roundOffInBand: 0,
      blockedSemantics: 14,
    });
  });

  it("187 unresolved unit prices split into data-limited, printed-but-unextracted and unattributed", async () => {
    const all = await views();
    let unresolved = 0;
    let noLineTotal = 0;
    let dataLimited = 0;
    let printedNotExtracted = 0;
    let unattributed = 0;
    let quantityAlsoUnresolved = 0;
    const printedNotExtractedExamples: string[] = [];
    for (const view of all) {
      for (const item of view.parsed.items) {
        if (item.priceSource !== "unresolved") continue;
        unresolved += 1;
        if (item.quantitySource === "unresolved") quantityAlsoUnresolved += 1;
        if (item.lineTotal === null) {
          noLineTotal += 1;
          continue;
        }
        const words = item.sourceLineIds.flatMap((id) => [...(view.words.get(id) ?? [])]);
        const money = rowMoney(words, view.profile);
        const others = money.filter((entry) => entry.paise !== item.lineTotal);
        if (others.length === 0) {
          dataLimited += 1;
          continue;
        }
        const qty = item.qty;
        const reconciles =
          qty !== null && qty >= 2 && others.some((entry) => entry.paise * qty === item.lineTotal);
        if (reconciles) {
          printedNotExtracted += 1;
          if (printedNotExtractedExamples.length < 5) printedNotExtractedExamples.push(`${view.receipt.receiptId}/${item.id}`);
        } else {
          unattributed += 1;
        }
      }
    }
    expect({ unresolved, noLineTotal, dataLimited, printedNotExtracted, unattributed, quantityAlsoUnresolved }).toEqual({
      unresolved: 187,
      noLineTotal: 2,
      dataLimited: 130,
      printedNotExtracted: 17,
      unattributed: 38,
      quantityAlsoUnresolved: 141,
    });
    expect(printedNotExtractedExamples.length).toBe(5);
  });

  it("no marker token was ever missed, and the paired gold check still contradicts nothing", async () => {
    const all = await views();
    let markerButUnresolved = 0;
    for (const view of all) {
      for (const item of view.parsed.items) {
        if (item.priceSource !== "unresolved") continue;
        const words = item.sourceLineIds.flatMap((id) => [...(view.words.get(id) ?? [])]);
        if (rowMoney(words, view.profile).some((entry) => entry.marker)) markerButUnresolved += 1;
      }
    }
    expect(markerButUnresolved).toBe(0);

    let pairs = 0;
    let goldUnitAnnotated = 0;
    let goldUnitExact = 0;
    let goldUnitAbsent = 0;
    let goldUnitWrong = 0;
    let lineTotalBoth = 0;
    let lineTotalAgree = 0;
    let lineTotalContradict = 0;
    for (const view of all) {
      const { parsed, receipt } = view;
      const match = matchItems(receipt.gold.items, parsed.items);
      for (const pair of match.pairs) {
        const gold = receipt.gold.items[pair.goldIndex]!;
        const item: ParsedItem = parsed.items[pair.predictedIndex]!;
        pairs += 1;
        if (gold.lineTotal !== null && item.lineTotal !== null) {
          lineTotalBoth += 1;
          if (gold.lineTotal === item.lineTotal) lineTotalAgree += 1;
          else lineTotalContradict += 1;
        }
        if (gold.unitPrice === null) continue;
        goldUnitAnnotated += 1;
        if (item.unitPrice === null) goldUnitAbsent += 1;
        else if (item.unitPrice === gold.unitPrice) goldUnitExact += 1;
        else goldUnitWrong += 1;
      }
    }
    expect({ pairs, goldUnitAnnotated, goldUnitExact, goldUnitAbsent, goldUnitWrong, lineTotalBoth, lineTotalAgree, lineTotalContradict }).toEqual({
      pairs: 135,
      goldUnitAnnotated: 3,
      goldUnitExact: 3,
      goldUnitAbsent: 0,
      goldUnitWrong: 0,
      lineTotalBoth: 133,
      lineTotalAgree: 133,
      lineTotalContradict: 0,
    });
  });

  it("price provenance: 331 detected, and 230 of them are a promoted line total, not a printed price", async () => {
    // The count behind ticket 06's rescue note. `priceSource: "detected"` is §7's claim that the value was
    // read off the receipt, so a line total promoted under an *assumed* qty 1 is a different kind of number
    // and 09b must not score the two together.
    const all = await views();
    let items = 0;
    let detected = 0;
    let unresolved = 0;
    let rescue = 0;
    let rescueFromExplicitQty = 0;
    for (const view of all) {
      for (const item of view.parsed.items) {
        items += 1;
        if (item.priceSource === "detected") detected += 1;
        if (item.priceSource === "unresolved") unresolved += 1;
        if (item.unitPrice === null || item.unitPrice !== item.lineTotal) continue;
        if (item.quantitySource === "assumed") rescue += 1;
        else rescueFromExplicitQty += 1;
      }
    }
    expect({ items, detected, unresolved }).toEqual({ items: 518, detected: 331, unresolved: 187 });
    expect({ promotedUnderAssumedQty: rescue, sameValueUnderExplicitOrUserQty: rescueFromExplicitQty }).toEqual({
      promotedUnderAssumedQty: 230,
      sameValueUnderExplicitOrUserQty: 101,
    });
  });

  it("the two items with no line total are individually identified, and neither is a receipt that printed nothing", async () => {
    const all = await views();
    const found: { receiptId: string; itemId: string; name: string; text: string }[] = [];
    for (const view of all) {
      for (const item of view.parsed.items) {
        if (item.lineTotal !== null) continue;
        const text = item.sourceLineIds.map((id) => view.receipt.ocr.lines.find((line) => line.id === id)?.text ?? "").join(" | ");
        found.push({ receiptId: view.receipt.receiptId, itemId: item.id, name: item.name, text });
      }
    }
    expect(found).toEqual([
      {
        receiptId: "cord-v2/dev/78",
        itemId: "i1",
        name: "Mineral Water",
        text: "2 | Mineral Water | 18 000",
      },
      {
        receiptId: "sroie/dev/3",
        itemId: "i1",
        name: "CASHIER [NAME] TIME",
        text: "CASHIER [NAME] TIME 12 31 00",
      },
    ]);
  });

  it("name-length outliers need at least 5 items, and the sigma multiple decides whether the finding is signal", async () => {
    const all = await views();
    let eligible = 0;
    const flagged: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    let longest = 0;
    for (const view of all) {
      const items = view.parsed.items;
      if (items.length < 5) continue;
      eligible += 1;
      const lengths = items.map((item) => item.name.length);
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
      longest = Math.max(longest, ...lengths);
      if (sd === 0) continue;
      for (const k of [1, 2, 3]) flagged[k] += lengths.filter((length) => Math.abs(length - mean) > k * sd).length;
    }
    expect({ receiptsWithAtLeast5Items: eligible, flaggedAtK: flagged, longestNameAmongEligible: longest }).toEqual({
      receiptsWithAtLeast5Items: 25,
      flaggedAtK: { 1: 62, 2: 6, 3: 0 },
      longestNameAmongEligible: 62,
    });
  });

  it("emission census: the shipped validate() reproduces DECISIONS/0011's published dev table", async () => {
    // This is the census 0011 V1 and the ticket-09b handoff quote. It runs the real validator rather than
    // an in-test restatement of its rules: a replication agrees with itself, `validate()` can disagree.
    const all = await views();
    let preservedRows = 0;
    let receiptsWithPreserved = 0;
    let uncertainReceipts = 0;
    let scoredItems = 0;
    let advisoryFindings = 0;
    let criticalFindings = 0;
    let totalFindings = 0;
    const byCode: Record<string, number> = {};
    const chargeLabels = new Set<string>();
    for (const view of all) {
      const { parsed } = view;
      preservedRows += parsed.unclassifiedRows.length;
      if (parsed.unclassifiedRows.length > 0) receiptsWithPreserved += 1;
      for (const tax of parsed.taxes) chargeLabels.add(tax.label);
      for (const charge of parsed.otherCharges) chargeLabels.add(charge.label);
      const out = validate(parsed);
      if (out.uncertain) uncertainReceipts += 1;
      totalFindings += out.findings.length;
      scoredItems += out.items.filter((item) => item.confidence !== null).length;
      for (const finding of out.findings) {
        byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
        if (finding.advisory) advisoryFindings += 1;
        if (finding.severity === "critical") criticalFindings += 1;
      }
    }
    expect({ preservedRows, receiptsWithPreserved }).toEqual({ preservedRows: 820, receiptsWithPreserved: 172 });
    expect(byCode).toEqual({
      ambiguous_row: 820,
      confidence_unavailable: 250,
      qty_assumed: 231,
      price_not_resolved: 185,
      qty_unresolved: 141,
      zero_items: 42,
      arithmetic_total: 34,
      arithmetic_item_sum: 27,
      unclassified_charge: 22,
      items_may_be_missing: 18,
      name_length_outlier: 6,
      ambiguous_price_separator: 2,
      item_without_price: 2,
      invalid_result_schema: 1,
    });
    expect({ uncertainReceipts, totalFindings, criticalFindings, advisoryFindings, scoredItems }).toEqual({
      uncertainReceipts: 86,
      totalFindings: 1781,
      criticalFindings: 106,
      advisoryFindings: 0,
      scoredItems: 0,
    });
    // Relaxed mode: the same checks run and every arithmetic finding says so — no other code is advisory.
    const relaxed = validate(all[0]!.parsed, { criticalOcrConfidenceFloor: 0.5, warningOcrConfidenceFloor: 0.7, strictArithmetic: false });
    const arithmetic = relaxed.findings.filter((f) => f.code.startsWith("arithmetic_"));
    expect(arithmetic.every((f) => f.advisory === true)).toBe(true);
    expect(relaxed.findings.filter((f) => f.advisory === true).length).toBe(arithmetic.length);
    // The dictionary gap DECISIONS/0010 Q2 names: no `Srv Ch`/`SR` label reaches the public shape at all,
    // so `unclassified_charge` can never fire on it from inside validate().
    expect([...chargeLabels].sort()).toEqual(["gst", "pajak", "tax", "total"]);
  });

  it("the item-sum criticals are over-inclusive item lists, not a broken subtotal parse", async () => {
    const all = await views();
    let overSum = 0;
    let goldAnnotatesSubtotal = 0;
    let subtotalAgrees = 0;
    let subtotalDisagrees = 0;
    let excessIsPercentItems = 0;
    let percentItemsPresent = 0;
    let excessIsTenderItem = 0;
    for (const view of all) {
      const { parsed, receipt } = view;
      const withTotal = parsed.items.filter((item) => item.lineTotal !== null);
      if (parsed.items.length === 0 || parsed.subtotal === null || withTotal.length !== parsed.items.length) continue;
      const sum = withTotal.reduce((total, item) => total + (item.lineTotal ?? 0), 0);
      if (sum <= parsed.subtotal) continue;
      overSum += 1;
      const excess = sum - parsed.subtotal;

      // Q5's predicted mechanism is a charge row 06 *typed*; these rows never reach `readCharges` at all,
      // because 05 classified them `item`. Both shipped predicates are tested, no new regex.
      const rowText = (item: ParsedItem) =>
        item.sourceLineIds.map((id) => receipt.ocr.lines.find((line) => line.id === id)?.text ?? "").join(" ").trim();
      const percentItems = withTotal.filter((item) => rowText(item).includes("%"));
      if (percentItems.length > 0) percentItemsPresent += 1;
      if (percentItems.length > 0 && percentItems.reduce((a, i) => a + (i.lineTotal ?? 0), 0) === excess) {
        excessIsPercentItems += 1;
      }
      const tenderItems = withTotal.filter((item) => matchesTenderFamily(rowText(item)));
      if (tenderItems.length > 0 && tenderItems.reduce((a, i) => a + (i.lineTotal ?? 0), 0) === excess) excessIsTenderItem += 1;

      const goldSubtotal = receipt.gold.subtotal;
      if (goldSubtotal !== null && goldSubtotal !== undefined) {
        goldAnnotatesSubtotal += 1;
        if (goldSubtotal === parsed.subtotal) subtotalAgrees += 1;
        else subtotalDisagrees += 1;
      }
    }
    expect({ overSum, goldAnnotatesSubtotal, subtotalAgrees, subtotalDisagrees }).toEqual({
      overSum: 27,
      goldAnnotatesSubtotal: 21,
      subtotalAgrees: 21,
      subtotalDisagrees: 0,
    });
    expect({ excessIsPercentItems, percentItemsPresent, excessIsTenderItem }).toEqual({
      excessIsPercentItems: 8,
      percentItemsPresent: 11,
      excessIsTenderItem: 1,
    });
  });

  it("the matcher's money gate hid 06's wrong unit prices: 49 gold-annotated, 2 actively wrong", async () => {
    const all = await views();
    let goldAnnotated = 0;
    let noNameMatch = 0;
    let exact = 0;
    let absent = 0;
    let wrong = 0;
    let wrongFromAssumedQtyRescue = 0;
    let rescuePopulation = 0;
    for (const view of all) {
      const { parsed, receipt } = view;
      // The rescue at parse/items.ts:132 turns a line total into a "detected" unit price whenever the
      // quantity reads as 1 — including an *assumed* 1, which is the mechanism the two errors share.
      rescuePopulation += parsed.items.filter(
        (item) => item.quantitySource === "assumed" && item.unitPrice !== null && item.unitPrice === item.lineTotal
      ).length;
      for (const gold of receipt.gold.items) {
        if (gold.unitPrice === null) continue;
        goldAnnotated += 1;
        // Name-only best match: `matchItems` refuses a pair whose monetary fields conflict (§8.2,
        // DECISIONS/0006 Option B), so counting pairs alone can never see a wrong price at all.
        let best: ParsedItem | null = null;
        let bestScore = 0;
        for (const item of parsed.items) {
          const score = nameSimilarity(normalizeItemName(gold.name), normalizeItemName(item.name));
          if (score > bestScore) {
            bestScore = score;
            best = item;
          }
        }
        if (best === null || bestScore < 0.7) {
          noNameMatch += 1;
          continue;
        }
        if (best.unitPrice === null) absent += 1;
        else if (best.unitPrice === gold.unitPrice) exact += 1;
        else {
          wrong += 1;
          if (best.quantitySource === "assumed" && best.unitPrice === best.lineTotal) wrongFromAssumedQtyRescue += 1;
        }
      }
    }
    expect({ goldAnnotated, noNameMatch, exact, absent, wrong, wrongFromAssumedQtyRescue, rescuePopulation }).toEqual({
      goldAnnotated: 49,
      noNameMatch: 44,
      exact: 3,
      absent: 0,
      wrong: 2,
      wrongFromAssumedQtyRescue: 2,
      rescuePopulation: 230,
    });
  });
});
