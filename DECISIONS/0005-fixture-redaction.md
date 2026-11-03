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
| Card last-4 | `[CARD_XXXX]` | masked card tails: `X×n` followed by four digits |
| **Personal name** (added) | `[NAME]` | staff and customer personal names after `CASHIER`, `SALES PERSON`, `ATTENDED BY`, `SERVER`, `STAFF`, `KASIR`, `WAITER`, `PIC` — **label kept, value redacted** |
| **Full account number** (added) | `[ACCOUNT]` | runs of 10+ digits near `BANK` / `ACC` / `A/C`. Replaces the earlier "13–19 consecutive digits → card last-4" rule |
| **Customer identity** (added) | `[CUSTOMER]` | `BILL TO` / `CUSTOMER` business and personal identities |

**Mechanism:** one placeholder per redacted *word*, so word count, line membership,
ordering and approximate x-extent survive. Three name tokens become
`[NAME] [NAME] [NAME]`.
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

Over `dev` (CORD valid 100) and `eval` (CORD test 100, SROIE test 361) token streams.
Examples are written as **shapes, not values**: a document that ships in a privacy-first
project's repo must not itself carry a real account number, phone or email. The raw
tokens are re-derivable locally from the pinned snapshot under `raw/` whenever needed.

- SROIE test: personal-name markers in **158 of 361** receipts — printed as
  `CASHIER : <given> <family> <family>`, `SALES PERSON : <given>`, and
  `BILL TO : <customer business words>`. Account-like digit runs in **80** receipts,
  shaped `BANK ACC <bank> ### ### ### ####` — a full account number, not a last-4.
  Phones in **23** (shaped `+60##-#### ####`), emails in **13** (shaped
  `EMAIL:<local>@<domain>`). UPI VPAs: 0. `Mr./Mrs./Haji/Hj.` prefixes: 0.
- CORD valid: 0 hits in every class. CORD test: 1 receipt carrying a bare 13-digit run
  with no label beside it, so the ACCOUNT rule does not fire and it is left for the
  scan to report.

These are why `PERSON_NAME`, `FULL_ACCOUNT_NUMBER` and `CUSTOMER_NAME` joined the list:
under the first version they would have shipped as ordinary "structural" tokens.

## Second ruling (2026-11-02, after the first scan reported five residual classes)

| Class | Ruling | Implementation |
|---|---|---|
| Unlabeled proprietor names on line 1 | **Accepted residual** | Not redacted: no label anchor exists, and guessing at header text to catch a name would damage fixtures the parser needs. Documented in `PII-SCAN.md` as a known limitation. |
| GST/SST/ROC/BRN registration numbers | Redact | New class `TAX_REG` → `[TAX_REG]`. 9–12 digits, or the ROC `digits-letter` form, in a line carrying a tax/registration label. Label-anchored so `TOTAL GST : 6.37` cannot be caught. |
| Unlabeled local-format phones | Redact | `PHONE` extended to `##-#### ####` / `##-### ####` with neither `+` nor a TEL label. Applied inline, so one token printing `T: … \| F: …` yields two placeholders. |
| Unlabeled 13+ digit runs | Redact | `ACCOUNT` extended: any bare run of 13+ digits not already claimed. Only space and dash may separate digits, so date and money punctuation break the run — `25/12/2018 8:13:39 PM` is 14 digits and survives untouched, correctly. |
| Annotation/print mismatch (18 receipts) | Redact | Header anchor is now **word-level**: a distinctive entity word (4+ characters, stop-words excluded) appearing anywhere in a header token anchors it. This is a dataset quirk, not a rule extension — CORD/SROIE annotations routinely differ from the print by a character. 15 `SDN`/`BHD`-class connectives are excluded so they cannot anchor a match alone. |

**Kept-token protection.** Because the 13+ rule can hit an item code or a printed total,
`redactWords` now takes `protectedTokens` — the tokens DECISIONS/0005 keeps verbatim (CORD
item names, quantities, the printed form of a scored monetary value). A protected token a
rule wanted to redact is left alone **and recorded** as a survivor with its class, reason
and position. Survivors are committed as `{class, reason, line, word, tokenLength}`:
positions so the idempotence scan can exclude them, lengths not text, since a survivor is
often the very number the rule wanted to remove. A spared token nobody explained is a
leak, not a judgement call.

After this ruling: **zero** 13+ digit runs remain in the committed fixtures, unmatched
entities fell from 18 receipts to 6, and redaction volume rose from 2,733 to 3,605 tokens.
The remaining advisories are enumerated in `benchmarks/fixtures/PII-SCAN.md`.

## Discipline

- Same input → same output: redaction is a pure function, so the byte-identical fixture
  regeneration check in DECISIONS/0003/0004 still holds.
- Placeholder tokens are stripped before applying label anchors during scan. Any new rule
  that tests adjacency or co-occurrence must strip placeholders first to preserve
  idempotence. The 2018-18 regression test is the template.
- If a rule changes later, the fixture diff shows it. That is the discipline — no
  silent rule drift.
- **If a kept field looks like PII to the implementer, stop and report. Do not extend
  redaction on your own initiative — silent redaction changes scoring.**
- After generation, `pnpm scan:pii` re-runs the pattern set over the committed fixtures
  and the methodology lands in `benchmarks/fixtures/PII-SCAN.md`. Results are reported
  to the owner before fixtures are committed. The repo stays private until the owner
  approves after that audit.
