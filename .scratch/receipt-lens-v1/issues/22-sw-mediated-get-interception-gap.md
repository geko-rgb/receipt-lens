# 22: Investigate Playwright service-worker-mediated GET interception gap

**What to build:** Determine whether a cross-origin GET issued from a page a service worker controls is never issued by
the browser or is missed by the audit's witnesses, and close the gap if a supported mechanism exists.

**Blocked by:** nothing. **Opened by:** ticket 18, checkpoint 3 (`DECISIONS/0030` P3, P12).

**Status:** ready-for-human

**Effort:** ~8 h · **Roadmap:** post-v1 · **Milestone:** none (post-v1) · **Verify:** an injected cross-origin GET from
a worker-controlled page makes `playwright/privacy.spec.ts`'s cross-origin assertion fail, with the mechanism named.

## The observation

With the real workflow driving (`playwright/privacy.spec.ts`), two canaries were injected from the same page: a
cross-origin `fetch("https://example.com/canary")` and a cross-origin `POST` of `NAAN 60.00` to a loopback port.
Witness 1 (`context.on("request")`) recorded the **POST** and did not record the **GET**. The page was under a
controlling service worker by then, so the GET is the one the worker's own `fetch` handler could mediate.

The audit cannot tell from its log which of two things happened, and this ticket exists rather than the audit claiming
either:

1. the browser never issued the GET (the worker answered it, or the request was blocked before the network), or
2. the browser issued it and witness 1 — and therefore `context.route` — did not see it.

## Why it is not a v1 blocker

The published claim is scoped to what the audit observes (`DECISIONS/0030` P3/P12, README limits), the uncontrolled-page
canary in `privacy.spec.ts` does catch a cross-origin GET, and witness 3 bounds witness 1 for the *application* origin —
it simply cannot bound a foreign one. Ticket 18 published the gap in the README instead of implying coverage it does not
have. This is the same disposition ticket 17 gave `beforeinstallprompt`: a platform limitation documented, scoped and
deferred.

## Options to evaluate

- **CDP `Fetch.enable`** on the page/worker target, which is below Playwright's route layer and therefore plausibly
  sees worker-mediated fetches that `context.route` does not.
- **`page.on("request")` as a fourth witness**, recorded alongside the context log and compared against it — cheap, and
  it would at least tell finding 1 from finding 2.
- **Worker-scope interception** via `Worker.on("request")` / `context.serviceWorkers()` (Playwright 1.4x+), which
  addresses the mechanism directly if the API hands over the worker's own requests.

## Constraints

No sleeps, no test-only hooks in the shipped bundle (`DECISIONS/0023` S1), fail-fast timeouts, and the audit's cost
budget: one workflow run, not one per assertion. A fix must be measured on the same canary before the README limitation
is edited — and the limitation is reopened only when a fix lands.

- [ ] Reproduce the gap with a minimal page: worker registered, then a cross-origin GET and POST from the controlled page
- [ ] Identify which of the two findings above holds, naming the mechanism
- [ ] Evaluate the three options above against the audit's existing cost and timeout budget
- [ ] If a mechanism closes it: implement, extend `privacy.spec.ts`'s canary test, and re-scope the README limitation
- [ ] If none does: record why, and make the README limitation cite this ticket's measurement
