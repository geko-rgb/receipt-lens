# receipt-lens

**A privacy-first, fully in-browser receipt parser and bill splitter.**

A receipt photo goes in on your device. Items, quantities and charges come out as a reviewable draft.
Participants are assigned at unit granularity, the bill is locked only once nothing is left unanswered, and everyone gets
an exact share with a UPI payment amount — computed locally, shared as an encrypted URL fragment, and
settled manually.

There is no account, no upload, no server, and no third-party endpoint in the request path. OCR,
parsing, validation and the split all run in the browser tab.

```
photo ──▶ on-device OCR ──▶ deterministic parser ──▶ review & edit ──▶ lock ──▶ encrypted link ──▶ UPI
         (PP-OCRv6 Tiny)     (rows, items,          (humans decide      (checks     (held in the
                              charges, totals)        what is a line)     pass)       URL fragment)
```

**Status:** v1, single user, UPI settlement, English receipts. See [Limitations](#limitations).

## The three claims, and how each one is checked

| Claim | Checked by |
|---|---|
| **Local processing.** No image, OCR text, parsed field or share fragment leaves the device. | `pnpm scan:egress` (static, 0 violations), `pnpm test:offline` — inference runs to completion with outbound network blocked and fails on any unexpected request; Playwright covers the service-worker offline reload. |
| **Honest accuracy.** Accuracy is dataset-scoped, states each dataset's labelling limits, and is generated from committed measurement artifacts — never hand-edited. | `pnpm verify:accuracy`, `pnpm verify:accuracy-table`. Tables are rendered into [`packages/core/README.md`](packages/core/README.md). |
| **Measured footprint.** Model bytes, runtime WASM, app script, cold download, warm re-fetch and latency are measured, not estimated. | `pnpm verify:footprint`, `pnpm verify:warm-bytes`. Artifact: `benchmarks/results/footprint.json`. |

A claim with no measurement behind it does not appear in this file.

## What it does

1. **Capture** — take a photo or pick an image. Preprocessing (rotate, crop, deskew, contrast) happens in
   the tab; the OCR model set is downloaded once from the app's own origin and verified by SHA-256 into the
   Cache API.
2. **Parse** — a deterministic pipeline turns OCR lines into rows, then into products, charges and totals.
   Header-anchored columns are used when the receipt prints a header; otherwise columns are reconstructed
   from the numbers themselves, and a value is only published when arithmetic proves the role. Bill metadata
   (bill number, date, steward, sales type) and footer phrases are classified as non-products rather than
   sold as items.
3. **Review** — every field is editable. Rows the parser cannot classify are shown, not dropped: you either
   classify them or acknowledge that you read them (the acknowledgement is recorded, reversible, and travels
   with the bill).
4. **Lock** — a bill locks only when it is answerable: no draft items, charges or unit assignments left open,
   the printed grand total present, a payer chosen, and no unclassified row that nobody has read. Every blocker
   is listed with the rows that caused it, so the way to clear it is visible.
5. **Share** — a locked bill becomes a compact snapshot, DEFLATE-compressed and AES-256-GCM encrypted, with
   the key living in the URL fragment. The fragment is never sent anywhere; the link is a bearer secret.
6. **Settle** — each participant sees their share and a UPI amount. Paid state is stored with the bill; the
   Bills view is your local history.

## Quickstart

Requires Node ≥ 22 and pnpm 12.

```bash
pnpm install
pnpm build          # builds core, pwa (incl. the service worker), benchmarks
```

**Run the app the way it actually works** — the built shell plus the repository's model assets and worker,
served by one loopback origin:

```bash
pnpm build && node -e '
import("./scripts/serve-app.mjs").then(async ({ startServer }) => {
  const server = await startServer({ recordRequests: false });
  console.log("open:", await server.url);
});'
```

Open the printed `http://127.0.0.1:<port>/` and go to **Capture**.

> **Why not `pnpm --filter @receipt-lens/pwa dev`?** The Vite dev server serves the app shell but not
> `/assets/models/*`, so those requests fall through to `index.html` and the app reports *“Models are not on
> this device yet.”* That is expected in dev — the model cache is populated by the built app against the
> server above. Use `dev` for UI work only.

### Tests

```bash
pnpm typecheck       # tsc + svelte-check, 0 errors
pnpm test            # unit + integration (core, pwa, benchmarks)
pnpm test:e2e        # Playwright: shell, offline, storage, real receipts
pnpm test:offline    # the privacy-critical subset: inference with egress blocked
```

`playwright/real-receipts.spec.ts` runs against two local photographs that are deliberately **not**
committed (third-party receipts; see `images/` and `.gitignore`). It skips when they are absent.

### The full gate suite

CI runs these; they are also what to run before trusting a change:

```bash
pnpm verify:accuracy        pnpm verify:accuracy-table   pnpm verify:results
pnpm verify:footprint       pnpm verify:warm-bytes       pnpm verify:privacy-table
pnpm verify:fixtures        pnpm verify:storage-fixtures pnpm verify:icons
pnpm scan:egress            pnpm scan:pii                pnpm check:storage-keys
```

## Repository layout

| Path | What lives there |
|---|---|
| `packages/core` | Framework-free engine: OCR provider (ONNX Runtime Web), the parse pipeline (`src/parse/`), validation, extraction. Its README carries the accuracy and footprint tables. |
| `packages/pwa` | Svelte shell: capture, capture preprocessing, bill editor (transaction-based, undo/redo), persistence and migrations, lock checklist, encrypted share codec, service worker. |
| `benchmarks` | The measurement side: fixture generation from CORD-v2 / SROIE, parser and end-to-end accuracy, footprint and warm-byte measurement, PII scan. Committed artifacts in `benchmarks/results/`. |
| `harness` | A minimal OCR harness — file in, normalized OCR JSON out. Not shipped. |
| `scripts` | Build gates, the app server, model manifest pinning, icon rendering, privacy/egress/storage checks. |
| `docs` | Architecture decisions (`docs/adr/`), the PWA design note, storage and model-asset notes. |
| `DECISIONS/` | Numbered, dated decision records — the reasoning and the measurements behind the numbers in the READMEs. |
| `GLOSSARY.md` | The domain vocabulary (row, item, unit, charge, blocker, snapshot…). |

## Privacy model, concretely

- **No egress.** The app fetches only its own origin: the shell, the model manifest, the model assets and the
  runtime WASM. `scripts/scan-egress.mjs` fails the build on a third-party fetch; the Playwright offline spec
  proves the inference path completes with the network blocked.
- **Storage is local and single-owner.** IndexedDB holds drafts, locked bills, the local ledger and an optional
  creator profile (display name, UPI ID). One Web Storage key, checked by `pnpm check:storage-keys`.
- **Shares are encrypted client-side.** Snapshot → compact JSON → DEFLATE → AES-256-GCM (fresh nonce, HKDF
  over a participant token) → base64url in the fragment. Whole fragment budget is 8 KB; it never silently
  truncates.
- **A share link is a bearer secret, not access control.** Anyone holding it can decode the bill it contains.

## Accuracy and footprint — read the generated tables, not this file

Numbers live where they are regenerated: [`packages/core/README.md`](packages/core/README.md) for accuracy and
footprint, `benchmarks/results/*.json` for the artifacts. Two things to keep in mind when reading them:

- **Dataset-scoped.** The headline is English `grandTotal` on SROIE; CORD-v2 is Indonesian and is published as
  a layout-stress bucket, not as an accuracy claim. Both are pinned snapshots.
- **Ceilings, twice over.** The parser benchmarks use the datasets' own reference OCR, so no OCR error reaches
  them; the end-to-end rows are the ones that include recognition.

## Limitations

- **Review is mandatory by design.** No OCR/parser is trusted blindly: rows that cannot be classified have to
  be reviewed or explicitly acknowledged. Acknowledgement records *that a human read the row*, not that the
  row is correct.
- **Garbled print stays garbled.** Where a receipt is genuinely illegible (`Po8`, `, Wtnin 2gis,`) the value is
  preserved verbatim and left for the human — preprocessing variants were benchmarked and none improved the
  two acceptance photographs.
- **v1 scope:** Indian rupees, held as integer paise (no floats in the money path) and settled over UPI; the
  creator must be a participant; no multi-device sync, no accounts, no server-side anything.

## Contributing

The repo's conventions are enforced rather than documented elsewhere: read the numbered records in
`DECISIONS/` before changing behaviour, keep measurements reproducible (`verify:*` re-derives them), and never
hand-edit a generated table. `GLOSSARY.md` is the shared vocabulary; `docs/adr/` holds the decisions that
predate the numbered records.

## License

MIT — see [LICENSE](LICENSE).
