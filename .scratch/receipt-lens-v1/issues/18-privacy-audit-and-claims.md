# 18: Prove the privacy claim, then state it narrowly

**What to build:** A full-workflow browser audit that records every request made from first load through capture, parsing, splitting, locking and sharing, and fails on any cross-origin traffic or any receipt image bytes or OCR text leaving the device — plus README wording that makes only the claim that audit can defend.

**Blocked by:** 15 (shares, UPI and WhatsApp), 16 (fragment share links), 17 (installable offline model cache)

**Status:** ready-for-agent

**Effort:** ~40 h · **Roadmap:** workstream 3G (tasks 3G.1–3G.6) · **Week:** W19–20 · **Milestone:** M3
**Verify:** full-flow audit passes in Playwright; a deliberately injected canary egress makes it fail; `privacy.yml` green in CI

- [ ] The audit drives the complete workflow in Playwright with request interception at the browser-context level, including service-worker-originated traffic, and documents the limits of that interception
- [ ] No request anywhere in the flow, including first load, is cross-origin
- [ ] No receipt-image bytes and no OCR text appear in any request URL, header or body, covering URL-borne exfiltration as well as bodies
- [ ] Deliberate sharing actions are identified in the audit output and excluded from the local-processing claim rather than hidden
- [ ] CI blocks a merge when the workflow produces unexpected egress, and passes with egress blocked once assets are cached
- [ ] A first-party static scan runs as a documented supplement to the runtime audit, not as evidence in its own right
- [ ] README wording is the scoped claim — local inference after assets load, verified against unexpected egress and uploads, sharing separate and free of image and OCR data — with no universal zero-network or security-proof phrasing
