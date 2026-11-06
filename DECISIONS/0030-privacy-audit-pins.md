# DECISIONS/0030 — The M3 full-workflow privacy audit: what it observes, what it fails on, and what it does not claim (the Tier-3 pins for ticket 18)

Date: 2026-11-06 · Ticket 18 (pins) · **Status: binding for ticket 18's implementation.**

`PROJECT(1).md` §9 M3 fixes the claim — *"receipt images and OCR text are processed locally, and the tested
inference workflow succeeds after the app/model assets are available without an inference service"* — and M3.1–6
fix the shape of the proof: exercise the whole PWA flow, assert no cross-origin request at any point including
first load, assert no request URL/query/header/body carries image bytes or OCR text, handle service workers at
`BrowserContext` level, keep the static scan as a labelled supplement, and hold deliberate sharing outside the
inference claim. §9 does not say what "every request" is measured by, what the deliberate set is, how the canary
is injected, or how CI turns red. Those choices decide whether the audit proves the claim or decorates it, so
they are pinned here before the test is written.

`DECISIONS/0013` is the M1 record (core harness, `serviceWorkers: "block"`, precache → block → infer, no reload).
This record supersedes nothing: M1 stays, and M3 is the stronger form — the shipped PWA, with the worker running.
Where 0013's mechanism decisions still hold they are cited, not restated; where the PWA changes them (W19) that is
said on the same line.

**Six things the brief got wrong, found by reading the tree before writing any code.** They are in the pins below.

- **(A) `.github/workflows/privacy.yml` already exists.** Ticket 09a created it and it has run the M1 suite since.
  Ticket 18 *adds a step*, it does not add a file. P10.
- **(B) The §9 M3.5 static scan already exists, in `scripts/scan-egress.mjs`, already wired into that workflow,
  and already labels itself "supplement, not proof".** The brief asks the Playwright spec to re-grep for the same
  banned primitives. A second implementation of a blocklist is a second blocklist that can drift from the first,
  and the drift would be silent. The audit therefore *invokes* the scanner and asserts its exit code. P8.
- **(C) The README's accuracy and footprint sections are generated between `<!-- accuracy:begin/end -->` and
  `<!-- footprint:begin/end -->` markers, and CI regenerates and `git diff --exit-code`s them**
  (`verify:accuracy-table`, `verify:footprint`). Every Part B/Part D sentence the brief dictates must therefore
  land in `render-accuracy-table.mjs` / `render-footprint-table.mjs`, not in the README by hand. A hand-typed
  claim inside a generated block is deleted by the next regeneration and the repo would ship a README making a
  claim nothing re-derives — the standing rule this ticket is nominally about. P11.
- **(D) The ticket 20 disclosure to "copy verbatim from `packages/core/README.md:295`" is not that line's text.**
  Line 295 reads *"**`arithmetic_item_sum` is not accuracy evidence.** Those criticals are charge and tender rows
  ticket 05 classified as items, so `readCharges` never saw them — a 05/20 classifier gap, not a price bug
  (`DECISIONS/0011`, ticket 20)."* The brief's sentence adds a fact line 295 does not state — that unrecognised
  labels are *dropped rather than preserved as `otherCharges`* — which is ticket 20's actual defect and is
  currently true of `parse/charges.ts:108`. Both are kept: the brief's sentence is the one published, because it
  discloses more, and line 295 stays where it is because the criticals table needs it locally. P11.2.
- **(E) `playwright.config.ts` defaults `serviceWorkers: "block"` (ticket 17 W19).** An M3 audit that inherits that
  default does not observe the worker at all, which is the one channel §9 M3.4 names. The audit runs with workers
  **allowed** — strictly stronger than M1, and 17c's measurement is what makes it affordable: warm bytes are now
  2,700 B, so a worker-driven flow no longer looks like egress. P3.
- **(F) "CI blocks a merge" is only partly in this repository's control.** `main` requires the `unit` status check;
  the `privacy` job is not a required check, and on this plan (`private`, GitHub Free) the branch-protection and
  rulesets APIs both answer `403 — Upgrade to GitHub Pro`, so it cannot be added from the CLI. The workflow fails
  red on every PR either way; making the failure *merge-blocking* is an owner-side repository-settings action,
  recorded as an open item rather than silently assumed done. P10.

---

## P1 — Deployment under test

The built PWA (`packages/pwa/dist/app`, entry `index.html`), served same-origin by `scripts/serve-app.mjs` — the
shipping server every e2e spec and `scripts/storage-fixtures.mjs` already runs against, and the deployment the
published footprint table describes (`DECISIONS/0028` T1, `DECISIONS/0029` C). Not the §9 M1 harness: an audit of
scaffold bytes is not an audit of what users receive.

`startServer({ recordRequests: true })` is required, and `playwright/app-server.ts`'s facade — which discards
`requests`, `bytes()` and `reset()` — is extended rather than bypassed, so the origin-side witness is available to
this spec and to the next one that needs it. Nothing over 1 MB is committed; there is no receipt image in the repo.

## P2 — The receipt under test

Synthesised in the page from the pinned geometry (`playwright/fixtures/synthetic-receipt.json`, 900×1200,
`bold 56px monospace`, x=60, y=220+160·i) exactly as `capture.spec.ts` and `share.spec.ts` draw it, and handed to
`#file-input` as real PNG bytes. The bytes are hashed with SHA-256 at the moment of handover; that hash is the
image witness and is never a committed artifact.

Two lines matter to the audit and they are chosen for it:

| line | why it is in the receipt |
|---|---|
| `COFFEE 4.50` | becomes an item, so its *name* legitimately appears in parsed bill data |
| `NAAN 60.00` | stays an `ambiguous_row` and is **excluded** at review, so neither its name nor its text may appear anywhere at all |

The image's own hash is `4848c0628cdd0eadf023ecc4c4d56f65c34f6bcffa632068e4c2f5ab040c83a5` for the four-line
receipt published in `benchmarks/results/footprint.json`; this audit's three-line variant has its own hash,
computed at run time from the bytes it hands over. `footprint.json`'s `measurement.image` is cited as the
committed re-derivation of the *method*, not as this run's value.

## P3 — Service workers: allowed, and what "allowed" costs

`test.use({ serviceWorkers: "allow" })`, per W19 and HANDOFF's ticket-17 carry-forward: *"ticket 18 owns the audit
scenario with workers allowed, asserting the worker's own egress."* Blocking would satisfy §9 M3.4's parenthetical
option and void its intent.

The consequence is pinned rather than discovered at review time: **`context.route()` is an enforcement point, not a
trustworthy observation point** for worker-originated traffic. Ticket 17 measured in Chromium that
`page.on("request")` still fires for responses the worker serves, while routed requests go quiet in the route
layer. So the audit does not *depend* on any single browser-side mechanism being complete — see P4.

**Documented limit, stated in the spec header, in the README and in P12:** Playwright's service-worker interception
coverage is browser-dependent and Chromium-specific (§9 M3.4). Everything below is measured on
`chromium` / Desktop Chrome and nothing else.

## P4 — Three witnesses, and which one asserts

| # | witness | what it sees | job |
|---|---|---|---|
| 1 | `context.on("request")` + `context.on("requestfailed")` | every request Playwright observes, in every page and worker of the context | **authoritative**: all P6–P7 assertions run against this list |
| 2 | `context.route("**/*")` + `context.routeWebSocket("**/*")` | what the routing layer is handed | enforcement: same-origin → `continue()`, anything else → record + `abort("blockedbyclient")`; WebSocket upgrades are recorded and `close()`d, because `route` does not intercept them (0013 T3) |
| 3 | the origin's own request log (`recordRequests`) | every request that actually reached the server, including the worker's install precache and the model downloads page timing APIs do not see | independent confirmation that witness 1 is not blind, and the only witness that cannot be affected by Playwright's interception at all |

Witness 1 is the assertion surface. Witness 3 is the check on witness 1: **any path the origin served that does not
appear in witness 1's log fails the audit.** A monitor that is compared against nothing is the vacuous pass P9
exists to rule out.

No request body, header *value*, or URL query is ever written to the CI log — only hashes, counts, and
`method + origin + path`. This is 0013 T3's rule and it is deliberate: the audit proves user data does not leave
the device, and printing it into a build log to do so is self-defeating.

## P4.1 — Requests are classified by scheme: `blob:` and `data:` are recorded, never counted as egress

The capture flow hands the receipt to the page as a `blob:http://127.0.0.1:<port>/<uuid>` object URL (probed at
checkpoint 2). `new URL()` reads that string's inner URL as same-origin `http:` traffic, the browser fires a
request event for it, and no socket is ever opened. Pinned:

> **P4.1:** the audit classifies requests by scheme. `http:`/`https:` are **network requests**, subject to every
> assertion (origin, image bytes, OCR text). `blob:`/`data:` are **local object URLs**: recorded in the log for
> completeness, never counted as egress — **and** the image-bytes assertion must still prove that the receipt-image
> bytes read through a `blob:` URL never appear in any `http(s)` request body, URL, header or query. Without this
> distinction the audit either false-positives on the app's own image handling or, worse, silently ignores the
> receipt image entirely.

`about:` joins the local class (a `window.open` with no target lands there). `upi:` is classified as an **intent**,
which P7 already treats as a non-request. Anything else is treated as a network request until P12 says otherwise,
because an unfamiliar scheme is not a synonym for "local" — an unrecognised scheme is exactly where a leak would
hide from a classifier that defaulted to permissive.

## P5 — Content inspection covers headers and URLs, not just bodies

§9 M3.3 names four places: *"URL, query, headers, or body"*. 0013 checked body and URL because a harness POSTs
nothing; a PWA does, and `no-cache` (DECISIONS/0029 P2) puts code into the HTTP cache, so a header-borne leak is
now in scope. For every recorded request the audit checks:

- **URL and query string** — for the OCR line strings of P2, decoded once (`decodeURIComponent`) so
  `%43OFFEE` is not a miss;
- **every header name the browser exposes on `request.headers()`** — the *name* of a matching header is recorded,
  never its value;
- **`postDataBuffer()`** — SHA-256 compared to the receipt image hash (an exact-byte hit is a failure), and the
  same decoded-string containment test as the URL.

The image check is a hash comparison, not a substring search: PNG bytes through a `FormData` boundary are not
contiguous in the body, so the honest claim is *"the image as handed over appears in no body, byte-for-byte, by
hash"* plus *"no body contains a 4 KB window of the image"* (a sliding-window check on the raw buffer, so a
partial-copy leak also fails). Both are cheap and both are stated in the README as what was measured.

## P6 — The workflow the audit drives, in order

One driver, `runFullWorkflow(page)`, executing §9 M3.1's list against the real UI. It is the same recipe
`share.spec.ts` and `settlement.spec.ts` already use, with the editor operations added, because those two files are
the only specs that reach a share link without a `setTimeout` override.

```
profile         /bills    profile-name / profile-upi / profile-save
capture         /capture  setInputFiles(receipt.png) -> draft-review
parse/review              finalize-all -> draft items become units
edit            /bill     draft-price edit, add-line, delete-item + delete-confirm
participants              participant-name / add-participant (creator + 2)
assign        units        unit checkbox per participant
ambiguity                unclassified-row -> exclude-row (this is what makes NAAN's absence meaningful)
assumed         review     review-assumed / review-item until none remain   (HANDOFF: survives finalization)
lock            /bill      lock-button -> lifecycle-state = locked
share                     share-link-row -> share-link-url, read out of the field (the field is the product)
participant   new context  browser.newContext() -> /share#v1.… -> share-view
settle          /bill      settlement-paid -> lifecycle-state = settled
deliberate                whatsapp-link href, upi-link href   (P7: tagged, not silently excluded)
```

Every phase records a `PrivacyLog` slice stamped with the phase name, so a failure says *where* the flow leaked.
The audit runs the flow once and asserts over the accumulated log; six split tests read that one log rather than
each driving their own full flow — the same split-test discipline ticket 13 established, at one quarter of the OCR
cost.

## P6.1 — The driver's preconditions, so a shortened flow fails loudly instead of passing vacuously

A workflow that silently stops early — the lock refused by a blocker nobody noticed, the share phase rendering no
rows, the participant context failing to open — leaves the accumulated log *smaller*, and every assertion below
still passes on it. That is 17b's "convert a judgment into evidence" rule applied to the flow rather than to a
number: the absence of egress is only worth something if the thing that would have produced it actually ran.
Pinned:

> **Driver precondition:** the workflow driver asserts `lifecycle-state === "locked"` and `share-link-row` count
> `> 0` before the log is deemed complete. A flow that silently shortens (lock refused, share phase empty) fails
> loudly instead of passing vacuously.

Every phase asserts its own state transition for the same reason: a locked bill, at least one minted link, at
least two participants, a settled bill, a non-empty witness-3 log and a non-empty witness-1 log. A driver step that
cannot reach its postcondition throws where it is, so a red run says *which* phase shortened rather than leaving a
reviewer to work it out from a short table.

## P7 — Deliberate share actions are identified, tagged, and excluded from the local-processing claim — visibly

The §9 M3.6 carve-out is only honest if the audit can be shown to have *seen* the action it excludes. A pinned
registry, not a heuristic:

| tag | what | why it is deliberate |
|---|---|---|
| `whatsapp-intent` | a click on `[data-testid="whatsapp-link"]`, destination `https://wa.me/…` | user-initiated share; the same id the static scan already registers (`scan-egress.mjs` allowlist) |
| `upi-intent` | `upi://pay?…` | a protocol intent, not an HTTP request; recorded as an attempted navigation and never followed |
| `share-link-minted` | the fragment the creator copies | local assembly + local encryption; it is a *value in a field*, not a request, and the audit asserts it produces **zero** origin-side requests |

Three rules follow:

1. A deliberate request is **aborted in CI** and recorded with its tag. The audit does not depend on the internet
   and does not put bill data on somebody else's server to prove a point.
2. A deliberate request **does not fail P6's cross-origin test** — and is printed in the test output as an excluded
   item, with its destination, so a reviewer can see the exclusion happened.
3. A deliberate request is **not** exempt from P5/P2's content checks: the fragment must still carry no image bytes
   and no raw OCR line text. `share.spec.ts` proves the UI does this; the audit proves the *wire* does.
4. **The fragment is scanned as an artifact, not only as a request** (ruled at checkpoint 1, because without this
   the "share links carry no receipt data" claim rests on an aborted request and proves nothing about the payload).
   For every minted link the audit asserts, against the fragment **string read out of the field**:
   - it contains no `data:` or `base64,` marker and no occurrence of the receipt image's SHA-256 hex, in the clear
     or percent-decoded;
   - it contains no OCR line string from P2 (`RECEIPT`, `COFFEE 4.50`, `TOTAL 100.00`, `NAAN 60.00`) — decoded
     through the same `decodeURIComponent` path P5 uses, and additionally after the codec's own
     base64→bytes→DEFLATE→plaintext expansion where that is reachable, so the check is on the *payload*, not only
     on its transport encoding;
   - and, for the WhatsApp text the share action would have carried, the same two exclusions hold, because a
     message body is the one deliberately-transmitted artifact where plaintext bill data actually does travel.

   (a) aborted-in-CI, (b) printed-as-excluded-not-exempt, and (c) this payload scan are the three assertions of
   P6's deliberate-share test; (c) alone is what makes the README's "never the receipt image or raw OCR text"
   sentence a measurement.

   **One word of that list is checked on the wire but not inside the minted payload, and the product is the reason
   rather than convenience.** The bill's default title is the literal word `Receipt` (`mapping.ts`), so every
   minted fragment carries `RECEIPT` as *bill wording* — a participant view shows it as the title — and a payload
   scan for that word would fail on every share link the product can mint. The payload scan therefore looks for
   the three lines that carry a printed amount (`COFFEE 4.50`, `NAAN 60.00`, `TOTAL 100.00`) plus the image
   digest, while `RECEIPT` stays in P5's four-place **wire** scan, where it can never legitimately appear. The
   exclusion is recorded here because an unrecorded exclusion is indistinguishable from a hole; the claim it
   protects — no excluded row, no image, no raw receipt line in a payload — is unchanged, and `share.spec.ts`
   already proves the same payload carries no excluded row word.

Anything else cross-origin is unexpected and fails.

## P8 — The static scan is invoked, not reimplemented

The sixth test runs `pnpm scan:egress` as a child process and asserts exit code 0, and its output is printed
verbatim so the tolerated indirect `fetch(input)` sites and the one allowlisted `whatsapp-intent` justification are
visible in the log. The label is the scanner's own, from its header: **"A SUPPLEMENT to the runtime test, never a
proof (§9 M1/M3.5, DECISIONS/0013 T7)"** — the test name says `supplement, not proof` and the README repeats it.

What it catches that the runtime audit structurally cannot: a code path this flow never reaches. That sentence is
in the spec header too, because "the runtime audit passes" and "there is no other egress in the source" are
different claims and only the first one is what P6 measures.

## P9 — The canary, and the rule that makes the audit non-vacuous

Negative control, one split test, injected at run time in the page (0013 T6's reasoning holds: editing shipped
source to prove a monitor works tests a build that never ships). Two injections, because the audit has two
independent detectors and proving only one would leave the other unproven:

| canary | injected | must be caught by |
|---|---|---|
| `canary-cross-origin` | `fetch("https://example.com/canary")` | the cross-origin assertion (P6), via witness 1 |
| `canary-ocr-text` | `fetch("https://127.0.0.1:<other-port>/", {method:"POST", body:"NAAN 60.00"})` to an origin the app never talks to | the cross-origin assertion **and** the OCR-text assertion (P5) |

The test asserts the assertion helper **throws** on a log containing each canary, and then asserts the helper does
**not** throw on the real workflow's log. A canary that the audit misses is a broken audit, and this test is the
one that would notice.

Both canaries are cross-origin by construction, so witness 3 also sees them only when they reach a real socket;
the abort keeps CI hermetic. Canary 2 posts to a port bound by the test itself, which is what makes it a genuine
egress attempt rather than a string in a variable.

## P10 — CI wiring

`pull_request` and `push` to `main`, job id `privacy`, in the file §9 already names. The new step runs after the
existing M1 steps:

```yaml
- name: Full-workflow PWA privacy audit (M3, ticket 18)
  run: pnpm exec playwright test --config playwright/playwright.config.ts privacy.spec.ts
```

Tagging: the spec's tests carry `@offline`, which is what keeps `ci.yml`'s `--grep-invert @offline` from paying for
the same browser OCR a second time. ci.yml's comment — *"The @offline suite has exactly one owner:
.github/workflows/privacy.yml"* — stays true and now covers a second file.

Timeouts: the config's fail-fast defaults stand (`timeout: 30_000`, `expect: 5_000`, `actionTimeout: 5_000`) and
each audit test sets exactly one `test.setTimeout(240_000)`, the `offline.spec.ts:312` precedent, justified by real
PP-OCRv6 Tiny inference rather than by a slow assertion. No sleeps anywhere.

**Open item for the owner (F above):** the `privacy` job must be added to `main`'s required status checks in
repository settings for "blocks merge" to be literal. That action is outside this repository's files and outside
this plan's API access.

**P10 required-check gap, ruled at checkpoint 1 (2026-11-06):** the privacy workflow will run and fail on every PR
with unexpected egress, but the current private-repository plan (GitHub Free) does not permit branch protection
rules that make this check merge-blocking — branch-protection and rulesets APIs return 403 with "Upgrade to GitHub
Pro." Merge-blocking enforcement activates when the repository goes public at v1's npm publish. Until then, the
audit's signal is advisory: the job fails visibly on the PR, but a human must not merge a red PR. Not a v1 blocker;
recorded as a platform limitation with a resolution timeline.

**Measured, because the dashboard route was tried first and the API is the same policy surfaced differently:**
`gh api repos/geko-rgb/receipt-lens/branches/main` answers `protected: false`, and
`…/protection/required_status_checks` answers
`403 — Upgrade to GitHub Pro`. So `main` carries **no** observable branch protection on this plan — which also
means `HANDOFF`'s standing note that the `unit` check is required is not verifiable from here and should be read as
an intention, not a setting. v1 accepts "the workflow fails red on every PR and a human must not merge a red PR";
the README says this plainly rather than implying the gate is mechanical (`DECISIONS/0030` P11.1, published claim).

## P11 — What the README is allowed to say

Every published sentence traces to an artifact or to a job that runs in CI. P11.1–3 are the claim set; P12 is the
limit set. Both go in the generated blocks, per (C).

1. **Local processing (§9 M3).** The scoped form, no universal zero-network and no security-proof phrasing: after
   required app/model assets are available, the *tested inference workflow* works without outbound network access;
   a full-workflow audit passes in CI intercepting every request across capture, edit, lock and share; deliberate
   sharing is separate and user-initiated and carries selected parsed bill data, never the image or raw OCR text.
   P12's limits are cited in the same paragraph by pointer to this record.
2. **Accuracy.** The generated table is untouched. Two sentences are added under it — ticket 21's
   parser-only-vs-effective-accuracy disclaimer, and ticket 20's charge-label disclosure (D above). Ticket 21's
   sentence says plainly that *v1 publishes no percentage for it*, because the one committed number on that
   question is the 25.1% / 16.5% ambiguous rate ticket 05 published with its own caveat, and `DECISIONS/0014` M7.5
   says a per-gold-class split is not recoverable from any committed artifact.
3. **Footprint.** The generated table already carries the numbers; the added prose is the interpretation: cold
   21,718,277 B, warm 2,700 B (5,499.6× — derived from the two committed figures, not typed as a third one),
   `cacheHeldBytes` 21,459,809 B, cold 1,257 ms / warm 624 ms unthrottled and 3,818 ms / 2,375 ms at 4× CPU, the
   four-line synthetic receipt it was measured on, and the 1-ORT-thread basis (`DECISIONS/0027` W14's required
   sentence, which the generator already emits from `measurement.deployment.threads`).

## P12 — Limits the audit states about itself, in its own header and here

- **Empirical demonstration, not a mathematical proof** (§9's own words). The audit shows the tested flow, on this
  browser, on this deployment, produced no unexpected egress. It cannot show that an untested code path would not.
- **Chromium, and one version of it.** Playwright's service-worker interception coverage is browser-dependent
  (P3); a different engine may hand routes a different set. Witness 3 is why that limitation is bounded rather than
  open-ended: the origin is not a Playwright abstraction.
- **Deliberate sharing is outside the local-processing claim** (P7), and the audit's exclusion list is printed, so
  the exclusion is auditable rather than a `continue()` in a loop.
- **Headers are checked, not logged** (P4/P5) — the audit can say no header matched a receipt signature; it does
  not publish header contents to prove it.
- **`beforeinstallprompt` is half-tested.** The app's offering half is automated against a fabricated event
  (`DECISIONS/0027` W12); the browser's prompting half does not fire in headless Chromium at all (measured: valid
  manifest, controlling worker with a `fetch` handler, secure loopback origin, 20 s poll, online and after an
  offline reload). Manual install verification is a not-yet-run check and the README says so instead of implying
  the install path is proven. **The sentence the README publishes, pinned here so the generator and the record
  cannot drift:** *"The app's install-offering half is automated — a fabricated `beforeinstallprompt` event drives
  the banner. The browser's install-prompt half does not fire in headless Chromium; manual install verification is
  documented as a not-yet-run check."* This audit does not re-run that test; it is named so a reader knows which
  half is automated.
- **Gate G5 is unverified and is published as such.** *"NPCI UPI deep-link parameter limits (`pn`/`tn`/`tr`) are
  unverified against the primary NPCI spec"* — the primary document named in `DECISIONS/0024` (v1.6, 2017)
  publishes no such limits, so the 40/50/35 character constants in the UPI builder are secondary-source-derived.
  Future work: verify against a newer NPCI specification or accept secondary-source authority explicitly
  (`DECISIONS/0024`, `ROADMAP.md` G5). The audit does not test them: P7 records the intent and scans its payload;
  it does not validate a scheme it does not own.
- **The audit does not measure the model-cache integrity story** — that is `DECISIONS/0027` W5's eight steps,
  already pinned by `offline-reload.spec.ts`.

## P13 — What this record does not decide

- **Whether ticket 20 or ticket 21 gets fixed.** Both are `ready-for-human`; both disclosures are published here
  unchanged. P11.2 is wording, not repair.
- **A measured LLM-fallback comparison.** That is `DECISIONS/0031`, which defers it to v2 and says plainly that the
  deferral does not satisfy M2's original exit bar.
- **Whether COOP/COEP isolation headers get added.** They change latency and regenerate the footprint table
  (W20); that is a separate measurement with a separate record.
- **The `privacy` required-check flip** (P10's open item), which is an owner-side settings action.

## Re-derivability

```
pnpm build
pnpm exec playwright test --config playwright/playwright.config.ts privacy.spec.ts   # six tests, workers allowed
pnpm scan:egress                                                                      # the supplement, standalone
pnpm verify:accuracy-table                                                            # P11.2's sentences re-render
pnpm verify:footprint                                                                 # P11.3's numbers re-render
```

The audit's own output is the artifact it cites: a per-phase request table (method, origin, path, body hash or
`null`) and the tagged exclusion list, printed in the test log. Nothing in the README depends on a number that is
not either in a committed results JSON or in a job that runs on the PR.
