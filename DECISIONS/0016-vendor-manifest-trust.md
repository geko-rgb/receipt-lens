# DECISIONS/0016 — Vendor model manifests are a starting point; measured values are the source of truth

Date: 2026-11-04 · Ticket 09b. Owner instruction: record the manifest-trust finding as its own decision,
not as a footnote in a ticket report.

## The finding

**PP-OCRv6 vendor manifests — for Tiny and for Small alike — describe two output properties
incorrectly.** Both descriptions are wrong in the direction that produces *plausible garbage instead of an
error*, which is why they are a trust problem rather than a bug report:

| Property | The upstream browser manifest says | The exported graph does |
|---|---|---|
| Detection output shape | `["N",1,"H/4","W/4"]` (downsampled by 4) | **full input resolution** |
| Recognition output | `semantics: "ctc_logits"` | **already softmax** — every row sums to 1.000 |

Source of the claims: `chenmohan/web-sdk-pp-ocrv6` manifest at revision
`fcb55226431520f397cbc93a80119f5cf32f355a`, the same pinned document the asset SHA-256s and
preprocessing values in `scripts/model-manifest.mjs` came from. The hashes and the normalization constants
were accurate; these two structural claims are not, on either tier.

## Evidence, all re-derivable

**Tiny, measured 2026-11-03** (ticket 04, recorded in `assets/models/manifest.json`'s own comments):
probes at 96×160 and 480×640 both returned full-resolution maps, and the first real receipt run gave every
word a confidence of ~0.0003 — the signature of softmax applied to output that was already normalized.

**Small, measured 2026-11-04**, before any accuracy run:

```
node scripts/inspect-ocr-sessions.mjs --dir assets/models/candidate
  detection probes:   [96,160] → [1,1,96,160]     [480,640] → [1,1,480,640]
  recognition output: [1,40,18710], row sums [1, 1, 1] → activation "softmax"
```

Same two contradictions, same export pipeline. Recorded in
`benchmarks/scripts/fetch-candidate-model.mjs`'s `UPSTREAM_PREPROCESSING`, which now carries the measured
values with this evidence in its comments — so re-fetching the candidate tier reproduces the corrected
manifest rather than the advertised one.

## The rule

> **The vendor manifest is a starting point; measured values are the source of truth. Every future model
> tier must run `node scripts/inspect-ocr-sessions.mjs --dir <asset dir>` before any accuracy measurement
> is taken with it.**

Why the ordering matters, stated as the failure mode rather than as hygiene:

- **A wrong activation claim is not loud in the text.** Pre-softmax output pushed through softmax again
  still produces readable words — with confidences around 0.0003, which means every confidence floor in §6
  fires on every item. A tier measured through that trap would look *dramatically* worse than it is, and
  gate G3's tier decision would have been made by an export quirk. (`DECISIONS/0015` C4.)
- **A wrong detection-shape claim changes box coordinates**, which is the parser's whole input (§5's
  geometry contract), and the scaling in `pp-ocrv6/detect.ts` is written to hold either way — so a wrong
  claim silently mis-scales rather than failing.
- Both traps were discovered by measurement, and neither was discoverable by reading the manifest.

The provider's defence, added by ticket 04 and the reason this rule is enforceable rather than aspirational:
channel order, mean/std, DB thresholds, recognition sizing, `dictionaryEntries` and the decoder's
`outputActivation` are read from `assets/models/manifest.json`, and `ctcGreedyDecode` **rejects output
whose rows contradict the declared activation**. So a mismatch between manifest and graph fails at load
instead of shipping — which converts this from a silent-accuracy hazard into a startup error, provided the
manifest is corrected to what was measured rather than the run being left on what was advertised.

## What this record does not decide

- **Which tier ships.** That is `DECISIONS/0015`, gate G3: Tiny remains, owner-confirmed.
- **Whether upstream's hashes are trustworthy.** They were: all three Small assets matched their pinned
  SHA-256 byte-for-byte. The finding is about *structural metadata*, not about provenance or integrity.
- **The dictionary's missing hash.** The vendor publishes no SHA-256 for a plain (non-LFS) dictionary file,
  only its byte count (93,658 B for Small). `fetch-candidate-model.mjs` pins the size, hashes what it
  fetched, and writes that hash into the manifest the provider then verifies on every load — so the gap is
  closed by content addressing at our layer rather than left as an unchecked download.
- **A quantized or lazy-loaded build** (risk R2's contingencies). Any such asset set inherits this rule.
