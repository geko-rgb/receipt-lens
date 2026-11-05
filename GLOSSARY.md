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
| Measured footprint | The committed browser cost of one deployment: per-asset bytes, initial download, what the cache actually retains, and cold/warm latency, generated from `benchmarks/results/footprint.json`. Not a size claim, not a model-file sum, and not a device estimate — a number outside its generated table is unmeasured by definition. |
| Device class | The declared conditions a footprint or latency number was measured under (machine, browser build, CPU throttle, cache and network mode). A footprint number without a class is not comparable to one with a different class, and an emulated throttle is a proxy, never a phone. |
| Sharing link | URL-fragment snapshot and bearer secret. Fragment is not sent in the initial HTTP request, but anyone with the full link can access its included bill data. No secure expiry/revocation in v1. |
| Zero-item participant | Participant with no assigned items. Still pays equal shares of applicable non-included bill-level charges. |
| App shell | The built document and its emitted scripts, styles, icons, manifest and the ONNX runtime WASM — everything whose identity is its filename. Not the model set: model URLs are stable across provider versions, which is why they need verification and the shell does not. Precached by the service worker on install (`DECISIONS/0027` W2). |
| Model set | One provider version's manifest, detection model, recognition model and dictionary, addressed in the cache as `receipt-lens-models:<providerVersion>:<manifestHash>`. Not "the models" by filename — two versions share the filename, so a filename is never a cache key (§9). |
| Verified activation | The point in a model update where the new set has downloaded, matched its manifest bytes and hash, and produced a non-empty smoke inference, and only then becomes the set readers are served — one pointer write. Not "the download finished": a complete download is not a working model. |
| Model update pending | State shown when a newer model set could not be made ready and an older verified one is still in use. Not an error and not a gate — receipts still read with the retained set. Distinct from *model unavailable*, which means no verified set exists on the device at all. |
| Smoke inference | One OCR run on a deterministic image drawn by the app, required to yield at least one line and one word, used as the gate before a model set activates. Not an accuracy measurement: accuracy is ticket 09b's published result, and coupling activation to it would make the app un-updatable whenever a receipt is hard to read. |
