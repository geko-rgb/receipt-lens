# 02: Exact money and the golden split table

**What to build:** The splitting engine: a complete bill of integer-paise amounts and participants goes in, each participant's exact reduced-rational share plus their whole-paise settlement amount comes out, and the printed ₹664.00 five-participant example reproduces exactly. A participant can be shown "your share is 1/3 of ₹470.00" and separately "pay ₹156.67" without either number being a lie.

**Blocked by:** 01 (walking skeleton)

**Status:** done — branch `ticket/02-exact-money`; two-axis code review + merge pending

**Effort:** ~32 h · **Roadmap:** workstream 3D (tasks 3D.1–3D.4), pulled ahead of parser work · **Week:** W17 slot · **Milestone:** M3
**Verify:** `pnpm -r test` runs the golden-table assertion, the sum-invariance property test and the settlement boundary suite

- [x] Amounts enter as integer paise and shares leave as reduced rationals with string numerator and denominator; no IEEE-754 float and no rounding appears anywhere in calculated shares
- [x] The canonical public charge shape is defined and exported by this ticket as its single owner: separate tax entries, service charge, tip, discount, signed round-off (integer paise) and other charges — deliberately not a discriminated union — and recorded as an ADR; 06 populates this shape and never redefines it
- [x] Applicable non-included bill-level charges are divided exactly and equally across all participants, including participants with nothing ordered
- [x] Charges marked included in prices are display-only and never allocated
- [x] A discount that pushes any share negative is reported as blocking rather than silently redistributed
- [x] A confirmed-unassigned unit adds its full cost to the creator's share through a single labelled adjustment line, rendered apart from charge allocations
- [x] Settlement paise are derived only at the transfer boundary, never inside share calculation
- [x] Largest-remainder allocation is exact: floors first, then one paisa each by descending fractional remainder
- [x] Remainder ties are broken by stable participant id, deterministically
- [x] Settlement paise sum exactly to the confirmed grand total
- [x] The golden table is asserted exactly, covering its three-way shared unit, its explicitly confirmed-unassigned unit, its zero-item participant, and its repeating-decimal shares
- [x] On randomized bills (property tests), exact shares always sum to the confirmed payable total regardless of participant count, unit assignments and charges (roadmap 3D.4, risk R5)
- [x] Rational arithmetic (GCD reduction, comparison, addition, division) has direct unit tests

## Comments

2026-11-02 — TDD at the pre-agreed split-engine seam (§11/§12). Files: `packages/pwa/src/lib/exact-money.ts` (BigInt rationals, reduced, positive denominator), `entities.ts` (§10 PWA-owned types), `splitting.ts` (`computeExactShares` → shares + `hasNegativeShare`; `other` charges with `sign: "unknown"` excluded from arithmetic per business §6.5), `settlement.ts` (`allocateSettlement` largest-remainder, ties by stable id, throws on inconsistent target, never mutates shares), 4 test files / 21 tests. Property tests use a seeded LCG — no new dependency added.

Charge-taxonomy ownership recorded as an amendment note on `docs/adr/0008` (the shape itself was transcribed into core types at ticket 01 — single owner is ADR-008 + `packages/core/src/types.ts`).

Verified: `pnpm -F @receipt-lens/pwa exec vitest run` → 21 passed; `pnpm typecheck` and `pnpm build` exit 0. Golden boundary amounts (8212/24237/8211/870/24870) match §11 line 875 exactly. PR note: this ticket's `Milestone: M3 / Week: W17` label contradicts the owner-directed M1/week-2 ordering; blocker set is authoritative — flagged per reporting rules.
