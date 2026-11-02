# Model asset strategy

**Decision: commit the binaries; fetch-and-hash at build is rejected.**

The three PP-OCRv6 Tiny assets live in `assets/models/` and are committed:

| File | Bytes | Role |
|---|---:|---|
| `PP-OCRv6_tiny_det.onnx` | 1,780,590 | detection model |
| `PP-OCRv6_tiny_rec.onnx` | 4,462,639 | recognition model |
| `PP-OCRv6_tiny_rec.txt` | 34,063 | recognition dictionary |

`assets/models/manifest.json` is generated deterministically by
`node scripts/model-manifest.mjs` — per spec §9 it records the provider
(`PP-OCRv6`) and version (`tiny`), each asset's app-origin URL, byte size and
SHA-256, plus the upstream license note. Re-run it after touching any asset and
commit the result; the footprint check in ticket 08 asserts the table matches the
files. Content-hashed *file names* and the service-worker cache keying (provider
version + manifest hash, verified-activation flow) are PWA work — tickets 10a and 17.

Rationale (spec §9: models must be self-hosted on the app origin, no third-party CDN
at any point; risk R10):

- Fetch-and-hash-at-build makes every clean build depend on upstream vendor URL
  availability and silently accepts whatever bytes the vendor republishes under the
  same path; pinning-by-download-to-repo records exactly what we shipped.
- Total footprint is ~6.3 MB — small enough to commit without repo surgery.
- Same-origin serving is a hard requirement, so the bytes must be ours to serve.
