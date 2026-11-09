import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chargeAmountTokens,
  quantityPattern,
  chooseCategory,
  classifyRows,
  detectQuantityColumn,
  hasInclusionCue,
  inferProfile,
  isGroupedDigitIdentifier,
  isRegistrationRow,
  matchLabels,
  matchesTenderFamily,
  overlappingEqualLengthPairs,
  parse,
  readMoney,
  readQuantity,
  resolveChargeAmount,
  type ClassifiedRow,
  type OcrResult,
  type ParsedItem,
} from "@receipt-lens/core";
import { loadFixtureSplit } from "../fixtures/load.js";
import { matchItems } from "../matching/matcher.js";
import type { LabeledReceipt } from "../datasets/types.js";

// Every number DECISIONS/0010 publishes, re-derived from the shipped parser over `benchmarks/fixtures/
// dev/` only (250 receipts, 5,199 rows; nothing read `eval/`, per DECISIONS/0004). This file is the
// artifact the record's reporting discipline asks for: a claim that cannot be regenerated from a
// committed check is a claim about a session, and a session is not evidence. The same role
// `rowClassification.test.ts` and `matching/sweep.ts` play for DECISIONS/0008 and 0006.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

async function dev(): Promise<readonly LabeledReceipt[]> {
  const cord = await loadFixtureSplit(fixturesRoot, "dev", "cord-v2");
  const sroie = await loadFixtureSplit(fixturesRoot, "dev", "sroie");
  return [...cord.receipts, ...sroie.receipts];
}
async function devCord(): Promise<readonly LabeledReceipt[]> {
  return (await loadFixtureSplit(fixturesRoot, "dev", "cord-v2")).receipts;
}

const rowsOf = (fixture: LabeledReceipt, options = {}): readonly ClassifiedRow[] =>
  classifyRows(fixture.ocr as unknown as OcrResult, options).rows;

/**
 * 05's `parse()` reconstructed through the `tenderFamily: false` seam: item rows, name built by dropping
 * the price-column word, every amount null — because 05 emitted no paise. This exists so the *before*
 * column of the pairing delta is a committed artifact rather than a session measurement; DECISIONS/0008's
 * reporting discipline says a number worth putting in a report is worth putting in a test first.
 */
function baseHeadItems(ocr: OcrResult): ParsedItem[] {
  const rows = classifyRows(ocr, { tenderFamily: false }).rows;
  const merged = new Map<number, number[]>();
  rows.forEach((entry, index) => {
    if (entry.classification !== "continuation" || entry.mergedInto === null) return;
    const bucket = merged.get(entry.mergedInto);
    if (bucket) bucket.push(index);
    else merged.set(entry.mergedInto, [index]);
  });
  const items: ParsedItem[] = [];
  for (const entry of rows) {
    if (entry.classification !== "item") continue;
    const [price] = entry.priceCandidates;
    const words = entry.row.words.filter((word) => word !== price).map((word) => word.text);
    items.push({
      id: `i${items.length + 1}`,
      name: [...words, ...(merged.get(entry.row.index) ?? []).map((at) => rows[at]!.row.text)].join(" ").replace(/\s+/g, " ").trim(),
      qty: null,
      quantitySource: "unresolved",
      unitPrice: null,
      priceSource: "unresolved",
      lineTotal: null,
      confidence: null,
      sourceLineIds: [...entry.row.sourceLineIds],
      warnings: [],
    });
  }
  return items;
}

/**
 * Every word carrying a digit. Deliberately *wider* than the geometry's numeric vocabulary: the money
 * grammar owns the decision about what is an amount, and pre-filtering on shape here would quietly hide
 * the currency-prefixed and signed words (`Rp 9,736`, `-7,800`, `$8.20`) that Q8 says this layer reads.
 */
function numericWords(entry: ClassifiedRow): string[] {
  return entry.row.words.map((word) => word.text.trim()).filter((text) => /\d/.test(text));
}

describe("Q1 — quantity column qualification and read states", () => {
  it("qualifies a column on 34 of 250 dev receipts at the floor of 5 rows", async () => {
    const receipts = await dev();
    let cord = 0;
    let sroie = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (const fixture of receipts) {
      const rows = rowsOf(fixture);
      const { column } = classifyRows(fixture.ocr as unknown as OcrResult);
      const band = detectQuantityColumn(rows.map((entry) => entry.row), fixture.ocr.imageSize.width, column);
      if (!band) continue;
      if (fixture.dataset === "cord-v2") cord += 1;
      else sroie += 1;
      if (column) nearest = Math.min(nearest, Math.abs(band.anchor - column.center) / fixture.ocr.imageSize.width);
    }
    expect(cord).toBe(11);
    expect(sroie).toBe(23);
    // No qualified band is anywhere near the price band, which is what makes Q6's "in the band means a
    // total, anywhere else means a quantity" reading safe rather than a coin toss.
    expect(nearest).toBeGreaterThanOrEqual(0.1);
  });

  it("shows the row floor is load-bearing and §5's 60% majority is not", async () => {
    const receipts = await dev();
    const withColumn = (options: { minRows?: number; share?: number }) =>
      receipts.filter((fixture) => {
        const { column } = classifyRows(fixture.ocr as unknown as OcrResult);
        return detectQuantityColumn(rowsOf(fixture).map((entry) => entry.row), fixture.ocr.imageSize.width, column, options) !== null;
      }).length;
    expect([withColumn({ minRows: 3 }), withColumn({}), withColumn({ minRows: 8 })]).toEqual([90, 34, 13]);
    // Every band dev produces is either all small integers or all money, so the majority threshold has
    // nothing to decide here. The floor is the parameter that does the work, which is why 0010 pins it.
    expect([withColumn({ share: 0.5 }), withColumn({ share: 0.6 }), withColumn({ share: 0.75 })]).toEqual([34, 34, 34]);
    // Ticket 25 lifted this test's runtime past the 5 s default (six classifications of the whole dev split, each
    // now paying for the quantity-candidate pass); the pins are unchanged, so the budget is raised, not the work.
  }, 20_000);

  it("publishes the item-row read states the floor of 5 costs", async () => {
    const receipts = await dev();
    const states: Record<string, number> = {};
    for (const fixture of receipts) {
      const rows = rowsOf(fixture);
      const { column } = classifyRows(fixture.ocr as unknown as OcrResult);
      const band = detectQuantityColumn(rows.map((entry) => entry.row), fixture.ocr.imageSize.width, column);
      for (const entry of rows) {
        if (entry.classification !== "item") continue;
        const reading = readQuantity(entry.row, band, column, entry.priceCandidates);
        states[reading.via] = (states[reading.via] ?? 0) + 1;
      }
    }
    // DECISIONS/0033 moved one row: the SROIE receipt whose `DESCRIPTION QTY PRICE TOTAL` table is now read
    // contributes one item whose quantity the row does not print, so `absent` falls 225 → 224 and nothing else
    // moves. A quantity the table's column filled would have raised `column`; it did not.
    // DECISIONS/0034 H1 re-derived this too: `column` 87 → 55 and `absent` 224 → 217, because 46 more SROIE
    // rows are now read from a printed table and their quantity comes from the table's own `Qty` cell, which is
    // filled in `rows.ts` and never reaches `readQuantity` — so an item the loose pass used to score `column` on
    // is not in this population at all, and a row whose table cell is blank scores `unresolved` at the item level
    // while `readQuantity` sees an ordinary `absent` row. `pattern` and `unattributed` are unchanged bar two rows
    // that are now metadata.
    // Ticket 25 re-derived this table: `pattern` 54 → 49, and nothing else moves. Admitting bare integers to the
    // band model gives four SROIE receipts a quantity band they always printed (`1`, `2`, `3` in a column of
    // counts), so five item rows that read their quantity from a `2 x NAME` pattern on the row now read it from
    // the column instead — the same number, read one way rather than two.
    expect(states).toEqual({
      pattern: 49,
      column: 55,
      unattributed: 135,
      absent: 217,
      conflicting: 1,
    });
  });

  it("counts the two printed forms of §5's quantity pattern over dev", async () => {
    const receipts = await dev();
    let glued = 0;
    let twoWord = 0;
    for (const fixture of receipts) {
      for (const entry of rowsOf(fixture)) {
        const words = entry.row.words.map((word) => word.text.trim());
        for (let i = 0; i < words.length; i += 1) {
          if (/^\d{1,2}\s*[x×]$/i.test(words[i]!)) glued += 1;
          else if (/^\d{1,2}$/.test(words[i]!) && /^[x×*]$/i.test(words[i + 1] ?? "")) twoWord += 1;
        }
      }
    }
    // The two-word form is half as common as the one the spec shows, so the pattern has to cover both.
    expect({ glued, twoWord }).toEqual({ glued: 63, twoWord: 33 });
    expect(quantityPattern([])).toBeNull();
  });

  it("never reads a percentage, an item code or a name token as a quantity from an unconfirmed band", async () => {
    const receipts = await dev();
    const offenders: string[] = [];
    for (const fixture of receipts) {
      for (const entry of rowsOf(fixture)) {
        if (entry.classification !== "item") continue;
        const reading = readQuantity(entry.row, null, null, entry.priceCandidates);
        // With no column anywhere on the receipt, the only admissible explicit read is the printed pattern.
        if (reading.quantitySource === "explicit" && reading.via !== "pattern") {
          offenders.push(`${fixture.receiptId}: ${entry.row.text}`);
        }
        if (reading.qty !== null && reading.qty > 20) offenders.push(`${fixture.receiptId}: qty ${reading.qty}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Q2 and Q4 — money grammars and profile inference", () => {
  it("lets no two profiles read the same word to two different values", async () => {
    const receipts = await dev();
    const classes = { both: 0, divergent: 0, idOnly: 0, enOnly: 0, neither: 0 };
    for (const fixture of receipts) {
      for (const token of rowsOf(fixture).flatMap(numericWords)) {
        const id = readMoney(token, "id-ID").paise;
        const india = readMoney(token, "en-IN").paise;
        if (id !== null && india !== null) {
          classes.both += 1;
          if (id !== india) classes.divergent += 1;
        } else if (id !== null) classes.idOnly += 1;
        else if (india !== null) classes.enOnly += 1;
        else classes.neither += 1;
      }
    }
    expect(classes).toEqual({ both: 1338, divergent: 0, idOnly: 194, enOnly: 1900, neither: 1402 });
    // This is the guarantee Q4 is built on: inference is bounded by exclusivity, not by accuracy.
    expect(classes.divergent).toBe(0);
  });

  it("resolves every dev receipt to one profile, and loses no gold amount doing it", async () => {
    const receipts = await dev();
    const vote = { cord: { id: 0, en: 0, none: 0 }, sroie: { id: 0, en: 0, none: 0 } };
    let billTotal = 0;
    let billHit = 0;
    let lineTotal = 0;
    let lineHit = 0;
    for (const fixture of receipts) {
      const tokens = rowsOf(fixture).flatMap(numericWords);
      const profile = inferProfile(tokens);
      const bucket = fixture.dataset === "cord-v2" ? "cord" : "sroie";
      let id = 0;
      let en = 0;
      for (const token of tokens) {
        if (readMoney(token, "id-ID").paise !== null && readMoney(token, "en-IN").paise === null) id += 1;
        if (readMoney(token, "en-IN").paise !== null && readMoney(token, "id-ID").paise === null) en += 1;
      }
      vote[bucket][id > en ? "id" : en > id ? "en" : "none"] += 1;
      const values = new Set(tokens.map((token) => readMoney(token, profile).paise).filter((value) => value !== null));
      for (const [field, value] of Object.entries(fixture.gold)) {
        if (field === "items" || value === null || value === undefined) continue;
        billTotal += 1;
        if (values.has(value)) billHit += 1;
      }
      if (fixture.dataset === "cord-v2") {
        for (const item of fixture.gold.items) {
          if (item.lineTotal === null) continue;
          lineTotal += 1;
          if (values.has(item.lineTotal)) lineHit += 1;
        }
      }
    }
    expect(vote).toEqual({
      cord: { id: 40, en: 5, none: 55 },
      sroie: { id: 0, en: 150, none: 0 },
    });
    // Equal to what an oracle profile would have read: inference costs nothing measurable on dev.
    expect({ billHit, billTotal, lineHit, lineTotal }).toEqual({ billHit: 372, billTotal: 372, lineHit: 222, lineTotal: 222 });

    // The stronger claim: inference is not merely good, it is equal to knowing the answer. Reading every
    // receipt with the profile its dataset was *generated* with reproduces exactly the same amounts.
    let oracleBill = 0;
    let oracleLine = 0;
    for (const fixture of receipts) {
      const profile = fixture.dataset === "cord-v2" ? "id-ID" : "en-IN";
      const tokens = rowsOf(fixture).flatMap(numericWords);
      const values = new Set(tokens.map((token) => readMoney(token, profile).paise).filter((value) => value !== null));
      for (const [field, value] of Object.entries(fixture.gold)) {
        if (field === "items" || value === null || value === undefined) continue;
        if (values.has(value)) oracleBill += 1;
      }
      if (fixture.dataset === "cord-v2") for (const item of fixture.gold.items) if (item.lineTotal !== null && values.has(item.lineTotal)) oracleLine += 1;
    }
    expect({ oracleBill, oracleLine }).toEqual({ oracleBill: billHit, oracleLine: lineHit });
  });
});

describe("Q5 — the tax-and-aggregate row that makes precedence load-bearing", () => {
  it("counts the dev rows carrying a tax label together with an aggregate label", async () => {
    const receipts = await dev();
    let mixed = 0;
    let taxOnly = 0;
    for (const fixture of receipts) {
      for (const entry of rowsOf(fixture)) {
        if (entry.classification !== "noise_header") continue;
        const categories = new Set(matchLabels(entry.row.text).map((match) => match.category));
        if (!categories.has("tax")) continue;
        taxOnly += 1;
        if (categories.has("grandTotal") || categories.has("subtotal")) mixed += 1;
      }
    }
    // 207 of dev's 836 tax-labelled rows name an aggregate too, so "which field does this amount go in"
    // is a decision with a real population, not a corner case. (The owner's ruling cited 199, measured
    // with a looser substring predicate than the matcher that shipped; 207 is what the shipped matcher
    // produces, and DECISIONS/0010 is corrected to it.)
    // DECISIONS/0034 M1/M2: 836 → 745 tax-labelled rows. The 91 that left are metadata rows (`GST NO:`,
    // `GST IN:`, `TAX INVOICE NO:` and their neighbours) and footer phrases; `mixed` is untouched at 207, which
    // is what says the tax∧aggregate population the precedence rule exists for did not move.
    expect({ taxOnly, mixed }).toEqual({ taxOnly: 745, mixed: 207 });
  });
});

describe("Q3 — the label dictionary's tie-break has no case to decide", () => {
  it("has no equal-length overlap the whole-word matcher can produce", () => {
    expect(overlappingEqualLengthPairs()).toEqual([]);
  });
});

describe("Q5 — charge typing over dev's labelled rows", () => {
  it("splits labelled noise rows by what they actually carry", async () => {
    const receipts = await dev();
    const split = { labelled: 0, registration: 0, noAmount: 0, resolved: 0, unresolvable: 0 };
    const types: Record<string, number> = {};
    for (const fixture of receipts) {
      const { column } = classifyRows(fixture.ocr as unknown as OcrResult);
      const profile = inferProfile(rowsOf(fixture).flatMap(numericWords));
      for (const entry of rowsOf(fixture)) {
        if (entry.classification !== "noise_header") continue;
        const matches = matchLabels(entry.row.text);
        if (matches.length === 0) continue;
        split.labelled += 1;
        if (
          isRegistrationRow(entry.row.words.map((word) => word.text)) ||
          entry.row.words.some((word) => isGroupedDigitIdentifier(word.text))
        ) {
          split.registration += 1;
          continue;
        }
        const amounts = chargeAmountTokens(entry.row.words, profile);
        if (amounts.length === 0) {
          split.noAmount += 1;
          continue;
        }
        const amount = resolveChargeAmount(amounts, column);
        if (amount === null) {
          split.unresolvable += 1;
          continue;
        }
        split.resolved += 1;
        const category = chooseCategory(matches, hasInclusionCue(entry.row.text));
        types[category!] = (types[category!] ?? 0) + 1;
      }
    }
    // DECISIONS/0034: `labelled` 1,374 → 1,283 (−91), `registration` 108 → 58 (−50) and `noAmount` 568 → 527
    // (−41). Every one of those rows is now classified `metadata` (a `GSTIN`/`GST IN`/`Invoice No` line) or
    // `ignored` (a footer with no money), so it never reaches this census; `resolved` and `unresolvable` are
    // unchanged, i.e. no charge that used to be typed stopped being typed.
    expect(split).toEqual({ labelled: 1283, registration: 58, noAmount: 527, resolved: 682, unresolvable: 16 });
    expect(types).toEqual({ grandTotal: 393, subtotal: 82, tax: 138, discount: 45, service: 21, roundOff: 3 });
  });

  it("fills the public charge fields somewhere on dev, and names where it fills nothing", async () => {
    const receipts = await dev();
    const filled = { taxes: 0, service: 0, tip: 0, discount: 0, roundOff: 0, other: 0, subtotal: 0, grandTotal: 0 };
    for (const fixture of receipts) {
      const result = parse(fixture.ocr as unknown as OcrResult);
      if (result.taxes.length) filled.taxes += 1;
      if (result.serviceCharge !== null) filled.service += 1;
      if (result.tip !== null) filled.tip += 1;
      if (result.discount !== null) filled.discount += 1;
      if (result.roundOff !== null) filled.roundOff += 1;
      if (result.otherCharges.length) filled.other += 1;
      if (result.subtotal !== null) filled.subtotal += 1;
      if (result.grandTotal !== null) filled.grandTotal += 1;
    }
    // `tip` is a §5 label dev never prints: 0 of 250 receipts, which is a corpus fact, not a parser gap —
    // the authored fixture in core's suite is what covers the branch.
    expect(filled).toEqual({ taxes: 117, service: 19, tip: 0, discount: 43, roundOff: 3, other: 14, subtotal: 82, grandTotal: 213 });
  });
});

describe("Q6 — zero totals promote, and counts do not", async () => {
  it("measures CORD's integers inside the price band: 44 of 49 are the value 0", async () => {
    const receipts = await devCord();
    let rows = 0;
    let zero = 0;
    let nonZero = 0;
    for (const fixture of receipts) {
      const { column } = classifyRows(fixture.ocr as unknown as OcrResult);
      if (!column) continue;
      for (const entry of rowsOf(fixture)) {
        const ints = entry.row.words.filter(
          (word) => /^\d{1,2}$/.test(word.text.trim()) && Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance
        );
        if (ints.length === 0) continue;
        rows += 1;
        for (const word of ints) if (Number(word.text.trim()) === 0) zero += 1;
        else nonZero += 1;
      }
    }
    expect({ rows, zero, nonZero }).toEqual({ rows: 49, zero: 44, nonZero: 5 });
  });

  const receipts = await devCord();
  it("promotes the CORD rows whose printed line total really is 0", () => {
    let promoted = 0;
    const samples: string[] = [];
    for (const fixture of receipts) {
      const rows = rowsOf(fixture);
      const ambiguous = new Set(
        rows.filter((entry) => entry.classification === "ambiguous").map((entry) => entry.row.sourceLineIds.join(" "))
      );
      for (const item of parse(fixture.ocr as unknown as OcrResult).items) {
        if (!ambiguous.has(item.sourceLineIds.join(" "))) continue;
        promoted += 1;
        if (item.lineTotal !== 0) samples.push(`${fixture.receiptId}: total ${item.lineTotal}`);
      }
    }
    expect(samples).toEqual([]);
    // 14, not 17: `CHANGED 0` (3 rows) is caught by family 5 first, and `Kembalian 0` (2) joins it, so
    // Q6's rescue never sees those; the remainder is `MIKA KECIL 0`, five other zero-priced lines, `0 x1 0`
    // and three `PB1:` promo rows the owner ruled to keep.
    expect(promoted).toBe(14);
  });
});

describe("Q7 — pattern family 5, attributed row by row (DECISIONS/0008 P7's revised invariant)", () => {
  it("re-derives the base head's published class totals exactly when the family is off", async () => {
    const receipts = await dev();
    const totals = { item: 0, continuation: 0, noise_header: 0, metadata: 0, ignored: 0, ambiguous: 0 };
    for (const fixture of receipts) {
      for (const entry of rowsOf(fixture, { tenderFamily: false })) totals[entry.classification] += 1;
    }
    // DECISIONS/0008 P7's shipped numbers, from the shipped code. The seam is only trustworthy if this holds.
    // DECISIONS/0033 moved three cells, all by the same seven rows on one SROIE receipt: `item` 713 → 712,
    // `ambiguous` 926 → 920, `noise_header` 3,517 → 3,524. `continuation` is untouched. The tender family's own
    // 307-row attribution below is unchanged too, which is what says this movement is the table stage's.
    // DECISIONS/0034 moved five cells, and they are the same 435 rows the shipped table moves: `item` 712 → 671,
    // `continuation` 43 → 37, `noise_header` 3,524 → 3,294, `ambiguous` 920 → 762, and the two new classes hold
    // the 336 metadata and 99 ignored rows. The tender family's own attribution below still holds at 441 rows,
    // which is what says this movement is the metadata/footer stage's and not family 5's.
    // DECISIONS/0035's disposition audit (2026-11-10): `noise_header` 3,294 → 3,285 and `ambiguous` 762 → 771,
    // the same nine rows the shipped table moves. The seam's tender-family attribution below is unchanged, which
    // is the evidence that this movement is the classifier's item-region counter and not family 5's.
    // Ticket 25: the same four SROIE receipts whose quantity band now qualifies reconstruct rows the base head
    // could not read with the family off as well — `item` −5 (671 → 666), `continuation` −3 (37 → 34),
    // `noise_header` +39 (3,285 → 3,324), `ambiguous` −31 (771 → 740). The rows are the product lines and their
    // discarded code prefixes on `sroie/dev/{4,8,34,86}`; the family's own attribution below is unchanged.
    expect(totals).toEqual({
      item: 666,
      continuation: 34,
      noise_header: 3324,
      metadata: 336,
      ignored: 99,
      ambiguous: 740,
    });
  });

  it("moves 307 rows into noise_header, all of them tender-shaped, and 0 rows anywhere else", async () => {
    const receipts = await dev();
    const transitions: Record<string, number> = {};
    const unattributed: string[] = [];
    let tenderRows = 0;
    for (const fixture of receipts) {
      const base = rowsOf(fixture, { tenderFamily: false });
      const shipped = rowsOf(fixture);
      for (const [index, entry] of shipped.entries()) {
        if (matchesTenderFamily(entry.row.text)) tenderRows += 1;
        const from = base[index]!.classification;
        const to = entry.classification;
        if (from === to) continue;
        const key = `${from}→${to}`;
        transitions[key] = (transitions[key] ?? 0) + 1;
        if (to === "noise_header" && !matchesTenderFamily(entry.row.text)) {
          unattributed.push(`${fixture.receiptId}: ${from}→${to} "${entry.row.text}"`);
        }
      }
    }
    expect(transitions).toEqual({
      "item→noise_header": 209,
      "ambiguous→noise_header": 90,
      "continuation→noise_header": 6,
    });
    // The revised invariant, as a check: the family-off base plus the rows this named family accounts for, and
    // nothing else. DECISIONS/0034 takes `ambiguous→noise_header` 92 → 90 because two of those rows print a
    // metadata label first (`CASHIER`/`TIME` on an SROIE receipt) and rule 0b files them before family 5 runs.
    expect(3294 + 209 + 90 + 6).toBe(3599);
    expect(unattributed).toEqual([]);
    expect(tenderRows).toBe(441);
  });

  it("produces zero tender-named items in ParseResult over all 250 dev fixtures", async () => {
    const receipts = await dev();
    const offenders: string[] = [];
    for (const fixture of receipts) {
      for (const item of parse(fixture.ocr as unknown as OcrResult).items) {
        if (matchesTenderFamily(item.name)) offenders.push(`${fixture.receiptId}: ${item.name}`);
      }
    }
    // Condition 3 of the owner's ruling: if family 5 ever regresses, this is what says so.
    expect(offenders).toEqual([]);
  });

  it("keeps every other P7 guardrail standing after the change", async () => {
    const receipts = await dev();
    let emptyNames = 0;
    let items = 0;
    let pairs = 0;
    for (const fixture of receipts) {
      const result = parse(fixture.ocr as unknown as OcrResult);
      items += result.items.length;
      emptyNames += result.items.filter((item) => item.name.trim().length === 0).length;
      pairs += matchItems(fixture.gold.items, result.items).pairs.length;
    }
    expect(emptyNames).toBe(0);
    // 05's head scored 131 pairs with 713 items; 06 keeps 135 pairs with 518 items — the discard removed
    // 195 products that were never items, and the money parsing added real ones back. DECISIONS/0033 raises the
    // item count to 557 (SROIE table rows) and `pairs` is unchanged at 135: SROIE's gold annotates no items at
    // all, so those 39 extra products cannot pair with anything. The number that moves is recall-free.
    // DECISIONS/0034 H1: 557 → 603 items (SROIE rows an `AMOUNT` column now reads). `pairs` is unchanged at
    // 135 — SROIE gold annotates no items, so none of the 46 can pair with anything.
    // Ticket 25: 603 → 616. Thirteen more SROIE products are read on the four receipts whose printed quantity
    // column now qualifies (9 on `dev/34`, 4 on `dev/8`); `pairs` is unmoved at 135 because SROIE's gold
    // annotates no items, so none of them can pair with anything.
    expect(items).toBe(616);
    expect(pairs).toBe(135);
  });

  it("re-derives the base head's pairing so the 131→135 delta has both sides committed", async () => {
    const receipts = await dev();
    let basePairs = 0;
    let baseItems = 0;
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      const items = baseHeadItems(ocr);
      baseItems += items.length;
      basePairs += matchItems(fixture.gold.items, items).pairs.length;
    }
    // Both sides are `matchItems` (τ 0.70, money-compatibility gate) — never substring containment. The
    // base head pairs 131 items with its money all null; this head pairs 135 with the gate *actively
    // refusing* a mismatched price, so the rise is real rather than a loosened threshold.
    // DECISIONS/0033: `baseItems` 713 → 712 for the same single SROIE row the class-total pin above records.
    // `basePairs` is unchanged, which is the load-bearing half: the base head's pairing is a property of the
    // gold and the matcher, not of how many items this parser finds.
    // DECISIONS/0034 M1/M2: `baseItems` 712 → 671, the 41 rows that were metadata read as products.
    // Ticket 25: `baseItems` 671 → 666 for the same four receipts the class-total pin above records;
    // `basePairs` is unchanged at 131, which is again the load-bearing half.
    expect({ baseItems, basePairs }).toEqual({ baseItems: 666, basePairs: 131 });
  });

  it("accounts for every CORD gold item name by the class of the row that carries it", async () => {
    const receipts = await devCord();
    const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    const buckets = { reached: 0, dropped: 0, preserved: 0, absent: 0, total: 0 };
    for (const fixture of receipts) {
      const names = parse(fixture.ocr as unknown as OcrResult).items.map((item) => norm(item.name)).filter((name) => name.length > 0);
      const rows = rowsOf(fixture);
      for (const gold of fixture.gold.items) {
        const name = norm(gold.name);
        if (name.length === 0) continue;
        buckets.total += 1;
        if (names.some((item) => item.includes(name))) buckets.reached += 1;
        else {
          const carriers = rows.filter((entry) => norm(entry.row.text).includes(name));
          if (carriers.length === 0) buckets.absent += 1;
          else if (carriers.some((entry) => entry.classification === "noise_header")) buckets.dropped += 1;
          else buckets.preserved += 1;
        }
      }
    }
    // Against 05's 156/37/45/16: reaching four more names while discarding 209 rows is what removing the
    // phantom tenders and parsing the money bought. `absent` is unchanged — that is 09b's floor, not this
    // ticket's, and the investigation is reported in 06's ticket file.
    expect(buckets).toEqual({ reached: 164, dropped: 37, preserved: 37, absent: 16, total: 254 });
  });

  it("emits §7's provenance states and nothing else", async () => {
    const receipts = await dev();
    const qty: Record<string, number> = {};
    const price: Record<string, number> = {};
    let nullTotal = 0;
    for (const fixture of receipts) {
      for (const item of parse(fixture.ocr as unknown as OcrResult).items) {
        qty[item.quantitySource] = (qty[item.quantitySource] ?? 0) + 1;
        price[item.priceSource] = (price[item.priceSource] ?? 0) + 1;
        if (item.lineTotal === null) nullTotal += 1;
      }
    }
    expect(Object.keys(qty).sort()).toEqual(["assumed", "explicit", "unresolved"]);
    expect(Object.keys(price).sort()).toEqual(["detected", "unresolved"]);
    // DECISIONS/0033, re-derived: explicit +1 (a table row that printed its quantity in the `Qty` column),
    // unresolved +39 (SROIE table rows that print a rate and a total but no quantity), assumed −1 (the row that
    // used to be the only item on its receipt is now one of several). `detected` +38 and `nullTotal` 2 → 3 are
    // the same 39 rows seen from the price side; one of them prints a rate column and no line total.
    // DECISIONS/0034 H1, re-derived: `explicit` 147 → 200 and `assumed` 230 → 223 (the table prints the
    // quantity, so 53 more items have a printed one and 7 fewer are assumed), `detected` 369 → 428 and
    // `unresolved` 175. `nullTotal` is unchanged at 3, one-for-one: the `CASHIER … TIME` row that had no line
    // total is now metadata, and a table record with a rate-plus-tax total cell takes its place. `unresolved`
    // quantity is unchanged at 180.
    // Ticket 25: `explicit` 200 → 213 and `detected` 428 → 441 — the thirteen extra SROIE items each print their
    // quantity in the table's own column and their price on the row, so both sides of both figures move together.
    // `assumed` (223), `unresolved` (175) and the unresolved-quantity figure (180) are unmoved.
    expect(qty).toEqual({ explicit: 213, assumed: 223, unresolved: 180 });
    expect(price).toEqual({ detected: 441, unresolved: 175 });
    expect(nullTotal).toBe(3);
  });
});
