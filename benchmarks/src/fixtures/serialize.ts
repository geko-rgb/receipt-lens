import { createHash } from "node:crypto";
import type { DatasetProvenance, LabeledReceipt } from "../datasets/types.js";
import type { Redaction, UnmatchedEntity } from "./redact.js";

export interface FixtureFile {
  readonly provenance: DatasetProvenance;
  readonly receipts: readonly LabeledReceipt[];
  readonly redactionCounts: Readonly<Partial<Record<string, number>>>;
  readonly unmatchedEntities: readonly UnmatchedEntity[];
}

/**
 * Explicit field order, 2-space indent, LF, trailing newline.
 *
 * JSON.stringify preserves insertion order rather than sorting, so writing every
 * object through this function — instead of serializing whatever a map happened to
 * build — is what makes `generate:fixtures` byte-identical on the same snapshot. The
 * alternative (sorted keys) is equally deterministic but unreadable in review.
 */
function canonicalReceipt(
  receipt: LabeledReceipt
): { receiptId: string; dataset: string; split: string; unreadableAnnotations: unknown; ocr: unknown; gold: unknown } {
  return {
    receiptId: receipt.receiptId,
    dataset: receipt.dataset,
    split: receipt.split,
    unreadableAnnotations: receipt.unreadableAnnotations.map((annotation) => ({
      category: annotation.category,
      text: annotation.text,
    })),
    ocr: {
      imageSize: { width: receipt.ocr.imageSize.width, height: receipt.ocr.imageSize.height },
      provider: receipt.ocr.provider,
      version: receipt.ocr.version,
      lines: receipt.ocr.lines.map((line) => ({
        id: line.id,
        text: line.text,
        box: canonicalBox(line.box),
        confidence: line.confidence,
        words: line.words.map((word) => ({ text: word.text, box: canonicalBox(word.box), confidence: word.confidence })),
      })),
    },
    gold: {
      grandTotal: receipt.gold.grandTotal,
      subtotal: receipt.gold.subtotal,
      serviceCharge: receipt.gold.serviceCharge,
      tip: receipt.gold.tip,
      discount: receipt.gold.discount,
      roundOff: receipt.gold.roundOff,
      taxTotal: receipt.gold.taxTotal,
      items: receipt.gold.items.map((item) => ({
        name: item.name,
        qty: item.qty,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
    },
  };
}

function canonicalBox(box: { x: number; y: number; width: number; height: number }): unknown {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function canonicalProvenance(provenance: DatasetProvenance): unknown {
  return {
    dataset: provenance.dataset,
    split: provenance.split,
    sourceSplit: provenance.sourceSplit,
    snapshotHash: provenance.snapshotHash,
    source: provenance.source,
    license: provenance.license,
    referenceOcrSource: provenance.referenceOcrSource,
    receipts: provenance.receipts,
    fieldsLabeled: [...provenance.fieldsLabeled],
    fieldsExcluded: [...provenance.fieldsExcluded],
    exclusionReason: provenance.exclusionReason,
  };
}

export function serializeFixtureFile(file: FixtureFile): string {
  return (
    JSON.stringify(
      {
        provenance: canonicalProvenance(file.provenance),
        redactionCounts: sortedRedactionCounts(file.redactionCounts),
        // An entity the header anchor could not locate still has to be reported — but
        // by shape and digest only, because its text is precisely what we keep out of
        // the repo (DECISIONS/0005).
        unmatchedEntities: file.unmatchedEntities
          .map((entity) => ({
            class: entity.class,
            textLength: entity.text.length,
            words: entity.text.split(/\s+/).filter((token) => token !== "").length,
            digest: createHash("sha256").update(entity.text).digest("hex").slice(0, 12),
          }))
          .sort((left, right) => `${left.class}${left.digest}`.localeCompare(`${right.class}${right.digest}`)),
      },
      null,
      2
    ) + "\n"
  );
}

function sortedRedactionCounts(counts: FixtureFile["redactionCounts"]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

/**
 * One file per receipt keeps every committed object under the 1 MB limit in
 * docs/storage.md and makes a fixture diff reviewable one receipt at a time.
 */
export function serializeReceiptFile(
  receipt: LabeledReceipt,
  redactions: readonly Redaction[]
): string {
  const canonical = canonicalReceipt(receipt);
  return (
    JSON.stringify(
      {
        receiptId: canonical.receiptId,
        dataset: canonical.dataset,
        split: canonical.split,
        unreadableAnnotations: canonical.unreadableAnnotations,
        // The redaction log travels with the receipt it describes, so the PII audit can
        // read what was changed — but only the *shape* of the removed text. Recording
        // `before` verbatim would commit the very data the rule exists to remove.
        redactions: redactions.map((redaction) => ({
          class: redaction.class,
          line: redaction.line,
          word: redaction.word,
          beforeLength: redaction.before.length,
          after: redaction.after,
        })),
        ocr: canonical.ocr,
        gold: canonical.gold,
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * DECISIONS/0004: tuning happens against dev and is never prompted by an eval failure.
 * That only holds if the two cannot share a receipt, so the writer refuses to emit a
 * fixture set that overlaps.
 */
export function assertSplitsDisjoint(devIds: readonly string[], evalIds: readonly string[]): void {
  const overlap = devIds.filter((id) => evalIds.includes(id));
  if (overlap.length > 0) {
    throw new Error(`dev/eval overlap in fixtures (${overlap.slice(0, 3).join(", ")}): a tuned split is a leaked split`);
  }
}

export type RedactionTotals = Partial<Record<Redaction["class"], number>>;

export function tallyRedactions(redactions: readonly Redaction[]): RedactionTotals {
  const totals: RedactionTotals = {};
  for (const redaction of redactions) {
    totals[redaction.class] = (totals[redaction.class] ?? 0) + 1;
  }
  return totals;
}
