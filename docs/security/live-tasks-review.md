# Live Tasks security review

Scope: `POST /api/tasks`, `apps/proofops/src/tasks.ts`, the optional goal in `freezeSpec`, the run loop changes, and how the UI renders typed text. Reviewed on the local tier with a scripted planner. No live model has run a Live Task.

## Boundary files changed
These need a VM rerun of the sandbox gates before any deployment, per ADR 0001.

| File | Change | Why it doesn't widen anything |
|---|---|---|
| `storefront.ts` | Visible quantity field, only when the trusted session API asks for it | The store's server-side limit of 1 to 5 is unchanged, and the public store can't turn the field on |
| `runner.ts` | Adds `quantity` to `fillableInputs` only when the validated goal's quantity is above 1 | `policy.ts` is unchanged, and the model can't influence the scope |
| `verifier.ts` | Adds `checkout.not_reached` for goals that stop at the cart | It only adds a way to fail, and legacy specs have no goal |
| `fixtures.ts` | Optional goal in the frozen spec | Goal is covered by the spec hash, and legacy specs are byte-identical |

`policy.ts`, `approval.ts` and `signer.ts` are unchanged by this feature.

## How it was reviewed
A separate review pass with no part in writing the code attacked it and ran its own probes. It was another Claude session, not an outside human reviewer.

**No safety boundary broke.** Free text, another run's token, a changed cart and a replay were all refused for approval. A no-order goal never dispatched the order click. Cancel and timeout never passed. Worst-case parse time was 0.4 ms at 500 characters. The UI has no unsafe rendering sink.

**The real defect was honesty, and it's fixed.** Requests could be read as their opposite and still earn a verified pass, such as "don't apply SAVE10" applying it, and "confirm the total is not $90" expecting $90.

| Finding | Fix | Test |
|---|---|---|
| Inverted or misread requests | Closed vocabulary, known negation phrases only, otherwise ask | `a request is never read as its opposite` |
| A stop-at-cart goal passed after reaching checkout | `checkout.not_reached` | LT-8b |
| "You declined" could hide a wrong total | Used only when the missing order is the sole failure, and the wording no longer says who declined, because a timeout looks the same | LT-5 |
| Long idempotency keys returned an error | Key shortened before scoping | LT-7b |
| A 20-character code could carry words to the planner | Codes must be up to 8 letters then up to 4 digits | `malicious task text` |

## Accepted limits
- The interpreter refuses some reasonable English, by design. A refusal costs a retype, and a misread costs a false proof.
- The goal is shown when the run starts, not confirmed first. It's always shown before any approval, and no order can happen without one.
- "Apply a discount" with no code named uses SAVE10, the only valid code, and the goal card says so.

## Blockers for public exposure
Live Tasks must stay off public deployment until these are done.
1. **Read access:** the result screen reads summary and evidence routes that are local-only. Public use needs per-run or authenticated access, not open history.
2. **Typed text is retained:** it's stored in `spec.json`, returned to anyone with the run id, and sealed into the hash, so it can't be redacted later. Public use needs a retention policy and a warning not to type personal data.
3. **Request authenticity:** the `x-proofops` header isn't authentication. Forged Origin and Host values pass, so public use needs Origin and Host checks.
4. **Quotas:** refused requests count toward the shared rate limit, and limits aren't per client. Each public run also costs inference.
5. **Live reliability:** no live model run has been done, so a bounded live test has to pass first.
