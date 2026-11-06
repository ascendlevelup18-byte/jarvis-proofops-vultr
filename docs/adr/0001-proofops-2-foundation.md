# ADR 0001: ProofOps 2.0 foundation

**Status:** accepted for local development, 6 Nov 2026. Not deployed. Competition production stays frozen at `d14d24c`.

## Decision
Evolve the existing TypeScript control plane and vanilla UI on an isolated branch, starting from `main` at `d6ebad8` plus the reviewed `review/work-upgrade-patch`. No framework change, no database change, no new runtime dependency.

## What exists
| Concern | Where | Finding |
|---|---|---|
| Execution loop | `runScenario` in `runner.ts` | One long function. It works and is well tested, so it's left alone unless a feature needs it |
| Run records | `store.ts` (SQLite index), bundle on disk | The registry holds status, verdict and anchor. Detail lives in the sealed bundle |
| Events | `events.jsonl`, `policy-decisions.jsonl`, `model-calls.jsonl`, `gateway.jsonl` | Enough to rebuild a finished run without new storage |
| Approval | `approval.ts`, `signer.ts`, store's checkout route | Separate process, single use, bound to run, action and exact cart |
| Verifier | `verifier.ts` | Takes page and store state. Never reads the model's claim |
| Evidence | `evidence.ts` | Unkeyed SHA-256 file checksums and a separately recorded manifest hash |
| UI data | `/api/health`, `/api/scenarios`, `/api/runs`, SSE stream | Live data only. Finished runs had no read model |
| Deployment | `ops/` | Separate from this branch, which must not be deployed |

## Boundaries that stay untouched
`policy.ts`, `approval.ts`, `signer.ts`, `gateway.ts`, `verifier.ts`, `storefront.ts`, `worker.mjs` and `worker-client.ts`. A change to any of them needs its own security review and a VM rerun.

## Choices
- **Read model from evidence, not new tables.** `run-summary.ts` builds a finished run from its sealed files, so history can't disagree with evidence and needs no migration.
- **Keep SQLite.** There's one writer on one host.
- **Keep the vanilla UI.** Nothing here needs a framework, and CSP stays `script-src 'self'`.
- **Three areas:** Run, Evidence, Trust. Each shows only what the backend really provides.
- **History is off behind a proxy by default.** Listing full run ids makes every bundle reachable, so it needs `PROOFOPS_OPEN_HISTORY=1` there.

## Consequences
- Older bundles show only what they recorded, and the UI says what wasn't retained.
- History reads hash files on request. That's fine for one operator and is bounded, but would need caching before heavy use.
- On this branch only: `zod` 4.6.6 and the reviewed UI fixes. Production keeps 4.6.5, as disclosed.

## Rollback
Delete the branch. Nothing here reaches `main`, the tags or production.
