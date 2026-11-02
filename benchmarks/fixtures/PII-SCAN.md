# Fixture PII scan

Date: 2026-11-02 · Script: `benchmarks/src/scan-pii.ts` (`pnpm scan:pii`) · Scope: all
711 committed receipt fixtures under `benchmarks/fixtures/dev/` and
`benchmarks/fixtures/eval/` (provenance headers excluded from token scanning), 32,690
word tokens.

This document records **how** the fixtures were audited and **what the audit found**. It
does not claim the fixtures are PII-free; it claims the specific checks below passed, and
lists what they cannot see.

## Method

**1. Idempotence (hard gate).** Re-apply the redaction rules of `DECISIONS/0005` to the
committed text. If any rule fires, the redactor saw that token and left it — a bug. CI
fails the build on this (`pnpm scan:pii` exits non-zero).

Result: **0 tokens re-fired** across dev and eval.

**2. Heuristic sweep (advisory only).** Independent, broader shapes, reported to the
owner and never auto-redacted — extending the rule list is an owner decision.

| Pattern | Regex (token-anchored) |
|---|---|
| email-shaped | `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$` |
| vpa-shaped | `^[A-Za-z0-9._-]+@[A-Za-z]{2,25}$` |
| long-digit-run (10+) | `^\d[\d\s-]{8,}\d$` |
| international-phone | `^\+\d{1,3}[\s-]?\d[\d\s()-]{5,}\d$` |
| masked-card-tail | `^[xX*]{6,}\d{4}$` |

Heuristics run on **word tokens only**, never joined line text: a line like
`000000111 1 193.00` reads as a ten-digit run across its spaces and would bury real
findings under arithmetic.

Result: email, VPA, international-phone and masked-card heuristics found **nothing**.
`long-digit-run` found **231 tokens**, broken down by context below.

## Redaction volumes actually applied

| Split / dataset | Receipts | Redactions by class | Entities the anchor could not locate |
|---|---|---|---|
| dev / cord-v2 | 100 | CUSTOMER 3 | 0 |
| dev / sroie | 150 | ADDRESS 384, BUSINESS 161, NAME 118, PHONE 99, INVOICE_NNN 35, ACCOUNT 9, EMAIL 7, CUSTOMER 4 | 10 |
| eval / cord-v2 | 100 | CUSTOMER 2 | 0 |
| eval / sroie | 361 | PHONE 317, ADDRESS 881, BUSINESS 388, NAME 172, INVOICE_NNN 78, CUSTOMER 49, ACCOUNT 6, EMAIL 13, CARD_XXXX 9 | 8 |

Unmatched entities are committed as `{class, textLength, words, digest}` only — a header
that lists the business names it failed to redact would be the leak it is reporting.

## The 231 digit runs, by context

| Count | Category | Example shape |
|---|---|---|
| 139 | 13–19 bare digits, no label beside them | `#### ### ### ####` |
| 58 | other digit run, no label | `##########` |
| 16 | local-format phone with no country code and no TEL label beside it | `##-#### ####` |
| 15 | date-shaped (`dd-mm-yyyy` family), not PII | `##-##-####` |
| 3 | digit run after an ID-ish label | `## ############` |

No digit run sat beside a bank label without the ACCOUNT rule already firing, and none
of the four other heuristics found a single token.

## Open items — reported, deliberately not redacted

These are visible in the fixtures and fall outside the agreed rule list. Per
`DECISIONS/0005` I am not extending redaction on my own initiative, because silent
redaction changes scoring:

1. **Personal names that follow no label.** The NAME rule is anchored to
   `CASHIER`/`SALES PERSON`/etc. A proprietor's name printed alone on the first line is
   not caught by any agreed rule and is not caught by idempotence either.
2. **Business tax registration numbers** (`GST ID. NO : <12 digits>`, SST/ROC numbers).
   Business identifiers, not in the keep list, not in the redact list.
3. **16 unlabeled local-format phone numbers.** The PHONE rule requires a TEL/FAX/PHONE
   label or a `+` country code; these have neither.
4. **197 unlabeled digit runs** (139 at PAN length, 58 shorter). Mixed invoice,
   transaction and loyalty-card numbers; one CORD receipt carries a bare 13-digit value.
   PAN-length, but no issuer-prefix evidence, so calling them card numbers would be a
   guess.
5. **10 dev / 8 eval receipts** whose company or address annotation could not be located
   in the token stream (printed text differs from the annotation, e.g. `SDN BND` vs
   `SDN BHD`), so some header business/address words on those receipts survive verbatim.

Items 1–5 are the owner's call. The repo stays private until that decision is recorded.
