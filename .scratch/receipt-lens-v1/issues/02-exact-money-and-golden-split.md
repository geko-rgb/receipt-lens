# 02: Exact money and the golden split table

**What to build:** The splitting engine: a complete bill of integer-paise amounts and participants goes in, each participant's exact reduced-rational share plus their whole-paise settlement amount comes out, and the printed ₹664.00 five-participant example reproduces exactly. A participant can be shown "your share is 1/3 of ₹470.00" and separately "pay ₹156.67" without either number being a lie.

**Blocked by:** 01 (walking skeleton)

**Status:** ready-for-agent

**Effort:** ~32 h · **Roadmap:** workstream 3D (tasks 3D.1–3D.4), pulled ahead of parser work · **Week:** W17 slot · **Milestone:** M3
**Verify:** `pnpm -r test` runs the golden-table assertion, the sum-invariance property test and the settlement boundary suite

- [ ] Amounts enter as integer paise and shares leave as reduced rationals with string numerator and denominator; no IEEE-754 float and no rounding appears anywhere in calculated shares
- [ ] The canonical public charge shape is defined and exported by this ticket as its single owner: separate tax entries, service charge, tip, discount, signed round-off (integer paise) and other charges — deliberately not a discriminated union — and recorded as an ADR; 06 populates this shape and never redefines it
- [ ] Applicable non-included bill-level charges are divided exactly and equally across all participants, including participants with nothing ordered
- [ ] Charges marked included in prices are display-only and never allocated
- [ ] A discount that pushes any share negative is reported as blocking rather than silently redistributed
- [ ] A confirmed-unassigned unit adds its full cost to the creator's share through a single labelled adjustment line, rendered apart from charge allocations
- [ ] Settlement paise are derived only at the transfer boundary, never inside share calculation
- [ ] Largest-remainder allocation is exact: floors first, then one paisa each by descending fractional remainder
- [ ] Remainder ties are broken by stable participant id, deterministically
- [ ] Settlement paise sum exactly to the confirmed grand total
- [ ] The golden table is asserted exactly, covering its three-way shared unit, its explicitly confirmed-unassigned unit, its zero-item participant, and its repeating-decimal shares
- [ ] On randomized bills (property tests), exact shares always sum to the confirmed payable total regardless of participant count, unit assignments and charges (roadmap 3D.4, risk R5)
- [ ] Rational arithmetic (GCD reduction, comparison, addition, division) has direct unit tests
