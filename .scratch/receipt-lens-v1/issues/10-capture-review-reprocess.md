# 10: Capture, review and reprocess a receipt

**What to build:** The first end-to-end PWA path: a creator captures or selects a receipt photo, adjusts it non-destructively, runs on-device OCR, and sees the extracted items and charges as reviewable drafts — with the ability to recrop and re-run while keeping the previous parse until the new one is accepted, and with the photo not stored unless they ask for it.

**Blocked by:** 04 (on-device OCR provider), 06 (items, quantities and charges), 10a (PWA shell and framework decision)

**Status:** ready-for-agent

**Effort:** ~40 h · **Roadmap:** workstream 3B (tasks 3B.1–3B.7) · **Week:** W13–14 · **Milestone:** M3
**Verify:** `pnpm exec playwright test capture` — a run from file-capture through to a populated draft screen

- [ ] Camera capture and ordinary file selection are both available, and denying camera permission falls back to file selection instead of blocking
- [ ] Accepted input formats are limited to what a tested in-app local decoder can handle — HEIC only once such a decoder exists — and no upload-fallback path exists anywhere (roadmap 3B.5)
- [ ] The image can be previewed, rotated, optionally cropped, and optionally deskewed or contrast-adjusted conservatively, without destructive edits to the original
- [ ] Running OCR produces draft items and charges with provenance and findings visible against the rows they concern
- [ ] Recropping and re-running OCR keeps the previous parse available until the new one is accepted, and discarding the new one restores the old
- [ ] The receipt image is not persisted by default — a test proves no image byte reaches any store through the whole flow; the opt-in retention toggle with its delete action is delivered once 14's storage layer exists, and this ticket leaves retention out rather than inventing parallel storage
- [ ] OCR, model-load and unreadable-image failures surface as readable messages, and a word-free image produces the critical zero-items state rather than a silent blank review screen
- [ ] A Playwright run covers capture-from-file through to a populated draft screen
