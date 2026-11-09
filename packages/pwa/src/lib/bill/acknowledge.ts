import type { UnclassifiedRow } from "@receipt-lens/core";
import type { AcknowledgedRow, WorkingBill } from "./working-bill.js";

/**
 * Ticket 23 — preserving is the parser's job, acknowledging is the human's (DECISIONS/0022 L1, `next.md` issue 6).
 *
 * §5 rule 7 keeps every row no rule could justify as an item, a continuation, a header, a charge or metadata, and
 * the owner's 2026-11-10 ruling refused a "confident discard" rule outright: a rule that throws away an unreadable
 * row is the rule that throws away a missed product line. What that leaves is friction, not a parsing defect — five
 * rows a human dismisses in two seconds each, one checkbox at a time.
 *
 * So the record is a *statement about the reading of the page*, kept beside the parser's output and never derived
 * from it:
 *
 * - per row, with the row's text and the moment of the decision, so a stored bill and an export can show what a
 *   human accepted and when, distinctly from what the parser classified;
 * - not an exclusion (`setUnclassifiedRowExcluded` owns that, and an acknowledgement moves no arithmetic at all);
 * - never inferable — nothing here reads a confidence, a label or a warning code to decide; the only input is the
 *   creator's own act;
 * - refused for a row that carries an amount: a human may not wave through arithmetic they have not resolved, so
 *   the row keeps blocking the lock and the decision is not recorded;
 * - voided, not deleted, when a row starts carrying an amount later (a re-parse or an edit). The stored record stays
 *   in the bill as history; every reader below treats it as no longer in force, and the blocker comes back.
 *
 * The predicates here are the only place those rules are decided, so validation, the lock screen and the share
 * snapshot cannot disagree about what "acknowledged" means.
 */

/**
 * A money-shaped token in a preserved row's text, as the reviewer would read it: an explicit currency marker, a
 * thousands separator, or a decimal part. A bare integer is deliberately *not* an amount — the same distinction
 * `DECISIONS/0037` relies on in the parser ("a count is not money") — so `Wtnin 2gis` and a KOT's trailing `1` stay
 * acknowledgeable while `[ACCOUNT] 25.00` and `TOT QTY: 28 313.50` do not.
 */
const AMOUNT_TOKEN = /(?:₹|\bRs\.?|\bRM\b|MYR)/i;
const MONEY_TOKEN = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$|^\d+\.\d{1,2}$|^\.\d{1,2}$/;

export function rowCarriesAnAmount(text: string): boolean {
  if (AMOUNT_TOKEN.test(text)) return true;
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[([{]+|[)\]},.;:]+$/g, ""))
    .some((token) => token.length > 0 && MONEY_TOKEN.test(token));
}

/** One acknowledgement in force: the stored record, matched to the row it is still about. */
export interface EffectiveAcknowledgement {
  readonly row: UnclassifiedRow;
  readonly acknowledgedAt: string;
}

/**
 * The acknowledgements still in force, in row order (never click order, so a reload is byte-stable — 0011's rule).
 *
 * A stored acknowledgement stops being in force when its row is gone or when the row now carries an amount. It is
 * **not** removed from the bill: the record survives as history, which is what "voided, not deleted" means, and a
 * re-parse that fixes the row does not silently re-acknowledge it either.
 */
export function effectiveAcknowledgements(working: WorkingBill): EffectiveAcknowledgement[] {
  const byId = new Map((working.acknowledgedRows ?? []).map((entry) => [entry.rowId, entry] as const));
  const out: EffectiveAcknowledgement[] = [];
  for (const row of working.unclassifiedRows) {
    const stored = byId.get(row.id);
    if (!stored) continue;
    if (rowCarriesAnAmount(row.text)) continue;
    out.push({ row, acknowledgedAt: stored.acknowledgedAt });
  }
  return out;
}

/** The ids the lock gate may treat as reviewed, so the blocker and the screen cannot disagree. */
export function acknowledgedRowIds(working: WorkingBill): Set<string> {
  return new Set(effectiveAcknowledgements(working).map((entry) => entry.row.id));
}

/**
 * The rows the bulk action may acknowledge: every preserved row that is not already acknowledged and does not carry
 * an amount. Order is the parser's row order, so the resulting state is deterministic.
 */
export function acknowledgeableRows(working: WorkingBill): UnclassifiedRow[] {
  const already = acknowledgedRowIds(working);
  return working.unclassifiedRows.filter((row) => !already.has(row.id) && !rowCarriesAnAmount(row.text));
}

/** Preserved rows whose amount keeps them blocking no matter what a human clicks (ticket 23's refusal edge). */
export function rowsBlockedByAmount(working: WorkingBill): UnclassifiedRow[] {
  return working.unclassifiedRows.filter((row) => rowCarriesAnAmount(row.text));
}

/** The stored record for a row, in force or voided — the history a stored bill still shows. */
export function recordOf(working: WorkingBill, rowId: string): AcknowledgedRow | undefined {
  return (working.acknowledgedRows ?? []).find((entry) => entry.rowId === rowId);
}
