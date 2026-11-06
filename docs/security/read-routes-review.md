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

## Findings against the reported tickets, on this branch
Argon's six tickets weren't available as a file here, so these use the descriptions given by the owner. Argon hadn't inspected this branch.
| Ticket | Result | Evidence |
|---|---|---|
| CC-01 object-level authorization | **Confirmed for any public use.** No users or ownership exist. Mitigated by keeping history local and closed. No fake session field was added | Finding 1, SEC-1, SEC-2, SEC-10 |
| CC-02 XSS and unsafe content | **Not confirmed.** Recorded text is inserted as text, and links come from fixed patterns | SEC-12, EX-13 |
| CC-03 evidence terminology | **Partly confirmed.** No false signing claim, but "sealed" suggested more than a checksum. Replaced in the UI, and outcome and integrity are now separate. Existing check names and historical records keep their wording | EX-3, EX-9 |
| CC-04 path traversal, resource use | **One gap confirmed and fixed:** the folder check used a prefix test and followed links. Now real paths are compared. History and comparison sizes are bounded | SEC-3, SEC-5, SEC-13 |
| CC-05 zod | **Fixed on this branch,** at 4.6.6. Frozen production keeps 4.6.5, as disclosed | `npm audit` |
| GW-01, GW-02 UX | Checked by automated accessibility, keyboard and viewport tests, not by a person using a screen reader | MC and EX tests |

## Endpoints on this branch
| Route | Who can read | Limit | Data |
|---|---|---|---|
| `/api/history` | Direct local request only, unless explicitly opened | 240 a minute | Run ids and outcomes |
| `/api/runs/:id/summary`, `/verify-evidence`, `/evidence/*` | Anyone holding a run id | 240 a minute, except files | Synthetic store data, model text, screenshots, deployment address |
| `/api/compare` | Anyone holding both ids | 240 a minute | As above |
| `/api/trust`, `/api/health`, `/api/scenarios`, `/api/runs` | Anyone reaching the server | None | Configuration, limits and outcome list. No secrets |

**The history and evidence routes stay local-only until real authentication and owner-scoped access exist.** The static Explorer uses none of them.
