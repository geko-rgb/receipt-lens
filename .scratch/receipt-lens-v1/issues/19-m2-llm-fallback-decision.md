# 19: M2 — LLM fallback evaluated and decided

**What to build:** The milestone-two gate from spec §16: measure whether a small pretrained model could correct what the deterministic pipeline misses, then write the decision down. This is a non-code deliverable whose output is numbers and a committed recommendation — without this ticket, v1 ships having never actually decided.

**Blocked by:** 08 (measured footprint — the cost ledger reuses its harness), 09b (accuracy reported — the held-out run uses M1's fixtures, protocol and scoring)

**Status:** ready-for-agent

**Effort:** ~58 h · **Roadmap:** Phase 2 (tasks 2.1–2.5) · **Week:** W10–11 · **Milestone:** M2 exit
**Verify:** a decision record is committed citing measured data from the results JSON produced by 08 and 09b, and states the recommendation explicitly: no fallback / defer / adopt (gate G6)

- [ ] A committed taxonomy of the uncertain subset from M1 output: failure types, prevalence, and which are plausibly LLM-fixable, with counts
- [ ] Exactly one candidate small pretrained model (WASM/WebGPU-runnable) is selected, with license, runtime and an integration sketch documented
- [ ] The candidate runs on the identical held-out examples using M1's fixtures, protocol and scoring — no fine-tuning, and the boundary is restated in the record
- [ ] A cost ledger is measured with the footprint harness: download size, cold/warm latency, and browser compatibility limitations
- [ ] The decision record cites accuracy, correction rate, download size, cold/warm latency and compatibility numbers from committed results — no folklore figures
- [ ] The recommendation is explicit and one of: no fallback for v1 (the G6 default), defer, or adopt — with any adoption changing the v1 plan only via owner revision
- [ ] Fine-tuning is explicitly recorded as remaining out of scope
