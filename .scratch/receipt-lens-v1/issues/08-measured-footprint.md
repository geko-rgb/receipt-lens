# 08: Footprint measured, not claimed

**What to build:** A reproducible measurement of what this actually costs a user to run — model and dictionary bytes, runtime and WASM, application script, total download and cache size, and cold versus warm latency — published as a table generated from committed results, so the README quotes this deployment instead of folklore.

**Blocked by:** 04 (on-device OCR provider), 07 (validation and findings)

**Status:** ready-for-agent

**Effort:** ~22 h · **Roadmap:** workstream 1E (tasks 1E.1, 1E.2, 1E.4, 1E.5) · **Week:** W8–9 · **Milestone:** M1
**Verify:** regenerate the footprint table from committed results JSON → `git diff --exit-code` clean

- [x] The harness reports every required row: each model asset, the dictionary, runtime/WASM, application script, total download, total cache, cold-start latency and warm latency
- [x] Cold and warm are measured on declared device and browser classes, with the method and sample size documented alongside the numbers
- [x] Results are committed in machine-readable form and the published table is generated from them, never hand-edited
- [x] Every third-party figure quoted anywhere in the docs is re-verified against its current primary source or removed
- [x] A committed check fails if the table drifts from the generated results
