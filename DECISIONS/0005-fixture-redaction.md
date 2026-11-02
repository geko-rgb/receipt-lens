# DECISIONS/0005 — Fixture redaction rules

Date: 2026-11-02 · Owner decision (ticket 03a kickoff; the extended classes were added
the same day after the first scan). Rules are implemented in
`benchmarks/fixtures/redact.ts` and applied by `pnpm generate:fixtures`. **The redacted
output is what enters the repo** — `benchmarks/datasets/raw/` stays git-ignored.

Rationale: "already published as research" reduces the rule's scope, it does not waive
it. If the repo becomes public (it is planned to, and `@receipt-lens` is meant to be a
public npm scope), we become the redistributing party. The credibility cost of a
privacy-first receipt app shipping real card fragments and addresses is not worth the
fidelity gain.

## Kept verbatim — scored or structural, do not touch

- Item names, quantities, prices, line totals (CORD).
- `total` / `grandTotal` annotation (both datasets) — SROIE's only scored field.
- Charge labels (`pajak`, `servis`, `diskon`, `subtotal`, `total`, `jumlah`, GST/CGST/
  SGST/IGST/cess/VAT spellings) — these exercise the §5 label dictionary.
- Structural text and geometry: the fact that a line is the business-name line or the
  address line, its position, and its word count.
- Item names stay verbatim: the §5 dictionary holds Indonesian charge labels, not item
  names, so redacting item names buys no dictionary value and would destroy CORD's
  layout-stress role for tickets 05–07.

## Redacted — non-scored PII

| Class | Placeholder | Matches |
|---|---|---|
| Business/store name | `[BUSINESS]` | business-name line tokens |
| Address | `[ADDRESS]` | address-line tokens |
| Phone | `[PHONE]` | `+62` / `+60` / `+91` numbers and local phone shapes |
| Email | `[EMAIL]` | any `local@domain.tld` |
| UPI ID / VPA | `[UPI]` | handle@psp patterns |
| Invoice / receipt number | `[INVOICE_NNN]` | labelled invoice/receipt ID values |
| Card last-4 | `[CARD_XXXX]` | masked card tails, e.g. `XXXXXXXXXXXX4318` |
| **Personal name** (added) | `[NAME]` | staff and customer personal names after `CASHIER`, `SALES PERSON`, `ATTENDED BY`, `SERVER`, `STAFF`, `KASIR`, `WAITER`, `PIC` — **label kept, value redacted** |
| **Full account number** (added) | `[ACCOUNT]` | runs of 10+ digits near `BANK` / `ACC` / `A/C`. Replaces the earlier "13–19 consecutive digits → card last-4" rule |
| **Customer identity** (added) | `[CUSTOMER]` | `BILL TO` / `CUSTOMER` business and personal identities |

**Mechanism:** one placeholder per redacted *word*, so word count, line membership,
ordering and approximate x-extent survive. `NG CHUAN MIN` → `[NAME] [NAME] [NAME]`.
Character length is not preserved; token count and position are. All-caps inputs stay
all-caps by construction. Redaction never changes a scored field, so scores are
unaffected — that is the point of the keep list above.

## Dropped entirely

SROIE `company`, `date` and `address` entity annotations are removed from the fixtures,
not redacted. SROIE is scored on `total` only (spec §8, DECISIONS/0002), those
annotations are unscored, and a placeholder cannot unambiguously cover a free-text
multi-line address. The fixture retains only the `total` annotation. Recorded the same
way in `benchmarks/fixtures/README.md`.

## What prompted the extension (scan of the pinned snapshot, 2026-11-02)

Over `dev` (CORD valid 100) and `eval` (CORD test 100, SROIE test 361) token streams:

- SROIE test: personal-name markers in **158 of 361** receipts — `CASHIER -> : NG CHUAN
  MIN`, `SALES PERSON : FATIN`, `CASHIER: ANGELA`, `BILL TO : THE PEAK QUARRY WORKS`.
  Account-like digit runs in **80** receipts, best example `BANK ACC AMBANK 888 100 123
  3706` (a full account number, not a last-4). Phones in **23** (`+603-9130 2672`),
  emails in **13** (`EMAIL:NG@OJCGROUP.COM`). UPI VPAs: 0. `Mr./Mrs./Haji/Hj.` prefixes: 0.
- CORD valid: 0 hits in every class. CORD test: 1 receipt carrying `2100252000358`.

These are why `PERSON_NAME`, `FULL_ACCOUNT_NUMBER` and `CUSTOMER_NAME` joined the list:
under the first version they would have shipped as ordinary "structural" tokens.

## Discipline

- Same input → same output: redaction is a pure function, so the byte-identical fixture
  regeneration check in DECISIONS/0003/0004 still holds.
- If a rule changes later, the fixture diff shows it. That is the discipline — no
  silent rule drift.
- **If a kept field looks like PII to the implementer, stop and report. Do not extend
  redaction on your own initiative — silent redaction changes scoring.**
- After generation, `pnpm scan:pii` re-runs the pattern set over the committed fixtures
  and the methodology lands in `benchmarks/fixtures/PII-SCAN.md`. Results are reported
  to the owner before fixtures are committed. The repo stays private until the owner
  approves after that audit.
