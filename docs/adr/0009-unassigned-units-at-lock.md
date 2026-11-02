# ADR-009: Unassigned units at lock

Status: **locked** (DQ-02 = B, refined accounting; seeded from `PROJECT(1).md` §14; exercised by tickets 12/13).

Locking may proceed with an unassigned unit only after the creator explicitly acknowledges it. The creator absorbs its full unit cost through a visible `AdjustmentLine{reason: "unassigned"}`.

Invariant: no unassigned cost disappears. The adjustment is stored and rendered separately from charge allocations and exact participant shares — it is the only v1 bill-adjustment reason.

v1 simplification: creator and payer must be participants; the creator is the default payer. Non-participant payer/creator settlement is not supported in v1.
