# GLOSSARY

Seeded from the living glossary in `PROJECT(1).md` §15. **Provisional:** terms become
load-bearing as the code actually adopts them; drift between this file and the code is a
bug in one of them. Per ADR-005, the original business document's `Item.assigned_to` array
is superseded by `ItemUnit` + `ItemUnitAssignment` — never reintroduce the old shape.

| Term | Definition — what it is and is NOT |
|---|---|
| `OcrResult` | Normalized OCR lines/words with boxes, nullable confidence, image size, provider and version. Not raw provider-specific output. |
| `OcrProvider` | Adapter interface for an OCR engine. Not the engine itself. |
| `parse()` | Deterministic transformation of normalized OCR into structured candidates, warnings and unclassified rows. Does not mutate input. |
| `validate(parseResult)` | Core checks over extraction/parse data only; returns `ParseValidationResult`. It cannot calculate bill-state lock blockers. |
| `validateWorkingBill(workingBill)` | PWA-only checks over the whole mutable bill state; returns `BillValidationResult` and coded blockers for finalization/locking. |
| `priceSource` | Provenance: `detected`, `unresolved`, or `user_confirmed`. Not a confidence score or correctness guarantee. |
| `quantitySource` | Provenance: `explicit`, `assumed`, `unresolved`, or `user_confirmed`. Not just the numeric quantity. |
| Critical finding | High-concern extraction/data contradiction. May set `uncertain` and cap affected item confidence. |
| Minor finding | Warning/diagnostic that does not by itself set `uncertain`; a separate blocker may still prevent an action. |
| `LockBlocker` | Structured, machine-readable reason a bill cannot lock. Not inferred from human-readable warning text. |
| `DraftItem` / draft charge | Import/edit-stage entity that may contain unresolved null values. Not a finalized billing entity. |
| `BillCharge` | Internal normalized charge entity; not the public `ParseResult` schema. |
| `round_off` | Charge carrying its printed signed amount. Not silently dropped or treated as a positive magnitude regardless of sign. |
| `AdjustmentLine` | Visible unassigned-item amount attached to the creator's exact share. Not a rounding bucket or hidden balancing arithmetic. |
| `confirmedUnassigned` | State proving creator explicitly acknowledged a unit as unassigned. Not merely missing assignment rows. |
| `ItemUnit` | One countable unit of an item. `qty` units exist per resolved item. Not a receipt row. |
| `ItemUnitAssignment` | Link between a unit and a participant. Zero assignment rows means unassigned until explicitly acknowledged. |
| `ambiguous_row` | A preserved source line whose classification could not be established. Not an item and not silently discarded. |
| `Row class` | §5's four labels for a clustered row: `item`, `continuation`, `noise_header`, `ambiguous`. Assigned by the parser's own y-band clustering, never copied from a provider `OcrLine`; thresholds pinned in `DECISIONS/0008`. |
| `Price column` | The right-aligned column inferred from amount-word right edges agreeing within 5% of image width. A geometry band that says *a row has a price candidate*; it parses no amount, and an inferred column is not the same as a verified one (see the fallback state). |
| `Item region` | The part of a receipt at and below its first row carrying a price-column entry. §5's "above the first item" is read as this document-position test, not a classification result: a priced row rule 3 refuses for want of a name still ends the region, so rows beneath it are preserved rather than discarded as header noise. |
| Strict score | Dataset-scoped exact match across supported annotated fields. SROIE result is grand-total-only, not whole-receipt itemized accuracy. |
| Field-level F1 | Diagnostic P/R/F1 using deterministic one-to-one item matching. |
| Local inference | Receipt image/text processing runs on-device after required assets are available. Not a claim that app loading or intentional sharing makes no requests. |
| Sharing link | URL-fragment snapshot and bearer secret. Fragment is not sent in the initial HTTP request, but anyone with the full link can access its included bill data. No secure expiry/revocation in v1. |
| Zero-item participant | Participant with no assigned items. Still pays equal shares of applicable non-included bill-level charges. |
