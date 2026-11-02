# 04: On-device OCR provider

**What to build:** A browser OCR provider that loads PP-OCRv6 detection and recognition models plus the recognition dictionary from assets this app hosts itself, runs them locally on a receipt image, and returns normalized OCR — words with boxes and confidence — behind a swappable provider interface. A minimal harness page turns a dropped image into that JSON so the rest of the pipeline can be developed against real output.

**Blocked by:** 01 (walking skeleton)

**Status:** ready-for-agent

**Effort:** ~30 h · **Roadmap:** workstream 1A (tasks 1A.1–1A.5) · **Week:** W3 · **Milestone:** M1
**Verify:** `pnpm -r test` passes the provider contract tests; the harness page renders an `OcrResult` and prints load/inference time and asset bytes; real-receipt evidence is attached to this ticket

- [ ] The `OcrProvider`/`OcrResult` types from 01's API stubs are finalized here — this ticket may extend but not reshape the contract that 03a already builds fixtures against
- [ ] Detection, recognition and dictionary assets are served from this deployment with content-hashed names and a manifest; no third-party CDN is required at any point
- [ ] The provider sits behind an `OcrProvider` interface that a second, non-PP-OCRv6 implementation can satisfy
- [ ] Output is a normalized `OcrResult`: words, boxes and confidence, in a coordinate space the parser can rely on
- [ ] Operational failures are typed and distinct — unreadable image, model load failure, recognition failure — while a blank or word-free image is a valid zero-word result, not an error
- [ ] Confidence is `null` when the provider has no meaningful score, and never an invented number
- [ ] Provider version plus manifest hash are exposed for later cache invalidation
- [ ] A harness page accepts a file, runs inference and displays the resulting `OcrResult` JSON with no other UI
- [ ] Running a real receipt photo through the harness produces recognizable item text and prices (manually inspected, evidence attached to this ticket) — a pipeline that loads and runs but emits unreadable text (wrong decode, wrong dictionary mapping, wrong channel order) is not done
- [ ] Load time, inference time and asset bytes are printed by the harness
