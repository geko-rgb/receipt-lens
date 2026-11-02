# Fixture PII scan

Date: 2026-11-02 (revised after the owner's second ruling the same day) ·
Script: `benchmarks/src/scan-pii.ts` (`pnpm scan:pii`) · Scope: all 711 committed receipt
fixtures under `benchmarks/fixtures/dev/` and `benchmarks/fixtures/eval/` (provenance
headers excluded from token scanning), 32,690 word tokens.

This records **how** the fixtures were audited and **what the audit found**. It does not
claim the fixtures are PII-free; it claims the checks below passed, and lists what those
checks cannot see.

## Method

**1. Idempotence (hard gate, CI-blocking).** Re-apply the redaction rules of
`DECISIONS/0005` to the committed text. If any rule fires, the redactor saw that token and
left it — a bug. Positions the generator deliberately spared are excluded, and only
because they were recorded in the fixture; an unexplained spared token fails the build.

Result: **0 tokens re-fired. 0 spared positions** — nothing was kept by exception.

**2. Heuristic sweep (advisory).** Independent, broader shapes, reported and never
auto-redacted. Patterns are token-anchored (`^…$`) and run on word tokens only, never
joined line text: a line like `000000111 1 193.00` reads as a ten-digit run across its
spaces and buries real findings under arithmetic.

| Pattern | Regex |
|---|---|
| email-shaped | `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$` |
| vpa-shaped | `^[A-Za-z0-9._-]+@[A-Za-z]{2,25}$` |
| long-digit-run (10+) | `^\d[\d\s-]{8,}\d$` |
| international-phone | `^\+\d{1,3}[\s-]?\d[\d\s()-]{5,}\d$` |
| masked-card-tail | `^[xX*]{6,}\d{4}$` |

Result: **email, VPA, international-phone and masked-card found nothing.** `long-digit-run`
found 67 tokens, all explained below.

## Redaction volumes after the extended rules

| Split / dataset | Receipts | Redactions | Classes |
|---|---|---|---|
| dev / cord-v2 | 100 | 3 | CUSTOMER 3 |
| dev / sroie | 150 | 1,096 | ADDRESS 393, TAX_REG 152, BUSINESS 179, NAME 118, PHONE 110, ACCOUNT 98, INVOICE_NNN 35, EMAIL 7, CUSTOMER 4 |
| eval / cord-v2 | 100 | 5 | ACCOUNT 3, CUSTOMER 2 |
| eval / sroie | 361 | 2,504 | ADDRESS 891, TAX_REG 376, BUSINESS 419, PHONE 340, ACCOUNT 157, NAME 172, INVOICE_NNN 78, CUSTOMER 49, EMAIL 13, CARD_XXXX 9 |

Before → after the second ruling: **2,733 → 3,608 redactions (+875)**, and receipts whose
business/address annotation could not be located **18 → 6** (word-level anchoring closed
most of them).

## The 67 remaining advisories, with reasons

| Count | Reason it survives |
|---|---|
| 25 | 12-digit runs — below the 13-digit threshold set for `ACCOUNT`, no label beside them |
| 25 | 10-digit runs — below threshold |
| 15 | date-shaped (`##-##-####` etc.) — not PII |
| 2 | 11-digit runs — below threshold |

**Zero tokens with 13 or more digits remain** in dev or eval, which is the class-4
requirement. Of the 67, five are Malaysian *mobile* formats (`016-7867868`,
`011-3194 0284`, `603-9545 1212`) that the local-phone rule does not cover, because its
shape was specified as `##-#### ####`. Reported, not widened.

## Known limitations — reported, not fixed

1. **Unlabelled proprietor names.** Accepted residual by owner ruling: catching a name
   printed alone on the first line needs a label anchor that does not exist, and guessing
   at header text would damage the fixtures the parser is developed against.
2. **Digit runs of 10–12 characters.** The agreed threshold is 13+. Lower runs are mostly
   invoice, transaction and loyalty numbers; widening the threshold would redact ordinary
   identifiers with no evidence they are financial.
3. **Six receipts** still carry header business/address words where the annotation could
   not be matched to the print even at word level. Committed as digests only in the
   provenance header.
4. **Heuristics can only find shapes we thought to look for.** Idempotence proves the
   agreed rules were applied consistently, not that the rule set is complete. That is why
   the advisory sweep is separate, and why its output is read by a human before anything
   is published.

Nothing in this document is a claim of PII clearance beyond the checks above. The repo
stays private until the owner accepts it.
