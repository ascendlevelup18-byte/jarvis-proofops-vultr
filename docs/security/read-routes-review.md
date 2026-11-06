# Review of the run-history and evidence routes, 6 Nov 2026

**Scope:** `/api/history`, `/api/runs/:id/summary`, `/api/compare`, `/api/trust`, `/api/runs/:id/verify-evidence`, `/api/runs/:id/evidence/*`. Self-review on the local tier, not a penetration test. Tests are in `apps/proofops/e2e/read-access.test.ts` and `apps/proofops/test/run-summary.test.ts`.

**Result: safe for local development with synthetic data, and not ready for public or multi-user use.** There is no authentication and no user model. These routes must not be exposed publicly.

## Findings
| # | Finding | Severity on this branch | Status |
|---|---|---|---|
| 1 | No authentication or user accounts. Anyone with a run id can read that run, so cross-user separation doesn't exist | **Blocks any real data or public use** | Open, by design for now. Needs accounts and per-run ownership first |
| 2 | My first version opened history whenever the server bound to loopback without `TRUST_PROXY`. A proxy set up without that flag, or DNS rebinding, would have exposed every run id | High for a misconfigured deployment | **Fixed:** direct local request, loopback Host and no forwarding header, or an explicit `PROOFOPS_OPEN_HISTORY=1` |
| 3 | `/api/runs` publishes the last 8 hex characters of each id with its time, which reveals 32 of the 64 random bits. **The same behavior is in frozen production** | Low: about 2^32 guesses are still needed, reads have no limit in production, and the data is synthetic | **Fixed on the branch** with a hash. Production stays frozen and is not a P0 |
| 4 | A bundle without a recorded anchor could read as verified, though a rewritten bundle couldn't be detected | Medium | **Fixed:** shows as incomplete evidence |
| 5 | Reads that hash files had no rate limit | Medium if public | **Fixed:** 240 per minute per address, set by `PROOFOPS_READS_PER_MIN` |
| 6 | Anchors for archived runs sit in `ANCHORS.txt` beside the bundles, so anyone who can rewrite the archive can rewrite them | Low locally | Open. Off-host signing is a later, separate milestone |
| 7 | Someone who rewrites files, manifest and anchor together isn't detected | Known limit | Documented by a test. Not fixable with checksums |
| 8 | A file over 4 MB is reported by the summary as not retained, rather than as oversized | Low | Open |

## Checked and sound
- **Actions:** approve, reject and cancel need the UI header and the per-run token. A live run refuses a missing or wrong token with 403.
- **Enumeration:** server ids hold 64 random bits. Malformed ids get a fixed 400 or 404, and unknown ids get the same 404 on every route. Older archived ids hold only 32 random bits, but those bundles are public in this repository.
- **Disclosure:** an approved run's API responses and evidence text files contain no owner token, approval token or server path. Screenshots weren't scanned.
- **Live runs:** not listed in history, and summary and compare answer 409. Partial evidence files of a live run remain readable to anyone holding its id, as in production.
- **Paths:** escape attempts are refused, and archive files are read-only.
- **Cross-origin:** no CORS grant, and security headers are present.

## Not tested
Behavior under `--sandbox` on a VM, real proxy configurations, or abuse at volume.
