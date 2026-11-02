# ADR-001: Equal split of bill-level charges

Status: **locked** (seeded from `PROJECT(1).md` §14; provisional until the split engine code exercises it — ticket 02).

Applicable non-included tax, service charge, tip, discount, signed round-off, and other bill-level charges are allocated equally among all participants, including participants with no assigned items. Each allocation is an exact rational amount; no paise or whole-rupee rounding is applied to calculated shares.

Amendment: any charge marked `included: true` is display-only — not split, not added to the total again. The split engine and arithmetic validator both respect the flag.

Trade-off: participants who order less may subsidize those who order more. Proportional charge allocation is out of scope for v1.
