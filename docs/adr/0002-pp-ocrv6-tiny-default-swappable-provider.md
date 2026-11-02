# ADR-002: PP-OCRv6 Tiny default with swappable provider

Status: **locked default, reversible** (seeded from `PROJECT(1).md` §14; the Tiny-vs-Small comparison is ticket 09b, gate G3).

PP-OCRv6 Tiny is the v1 starting default behind `OcrProvider` and `onnxruntime-web`. Tiny is a starting default, not a proven receipt-accuracy winner: compare Tiny and Small during M1 and retain reversibility. Switching tiers must not change `parse()` or the normalized OCR contract.

The former "~4.3 MB complete OCR pipeline" claim is withdrawn. Publish only measured numbers: detection/recognition models, dictionary, runtime/WASM, app JS, initial download/cache size, cold/warm latency (ticket 08). Vendor benchmark accuracy is not a promise of accuracy on price-critical receipts.
