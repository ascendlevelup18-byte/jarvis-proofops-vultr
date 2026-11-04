# JARVIS ProofOps — Execute. Contain. Verify.

Entry for the Vultr: Agent Rush Hackathon 2026 (lablab.ai), Challenge 1 "Blast Radius Zero": a commerce QA agent that plans real browser work with Vultr Serverless Inference, runs it with Playwright inside a gVisor sandbox on a Vultr VM, and lets an independent verifier, not the model, decide what actually happened.

**AI proposes. Policy authorizes. The browser acts inside a restricted boundary. Independent verification decides. Evidence proves it.**

## Status (3 Nov 2026)
| Tier | Status |
|---|---|
| Local, scripted planner, real Chromium (not isolated) | Working: `npm run proofops:release` passes every local gate |
| Vultr VM with gVisor sandbox | Not yet run (VM exists; deployment waits on SSH host-key verification) |
| Live Vultr Serverless Inference model | Not yet run (integration tested against a local mock only) |

Local results are never presented as Vultr or live-model evidence. Every evidence bundle records its tier.

## Run it locally
Requires Node 24. Install Playwright's Chromium once: `cd apps/proofops/worker && npm ci && npx playwright install chromium`.
```
npm ci
npm run proofops:demo      # operator console on http://127.0.0.1:4317 (scripted planner, no sandbox; labelled as such)
npm run proofops:smoke     # runs all six missions against the running console and checks each outcome
npm run proofops:release   # full local gate: typecheck, tests, smoke, evidence integrity, secret scan, deploy checks
```
Missions: correct discount (PASS), wrong discount (FAIL at $95 vs $90), hostile page (attempts blocked, no order),
broken checkout (FAIL), approved checkout (one signed, single-use approval; replay refused), hung page (times out,
worker destroyed). Evidence bundles land in `evidence-local/<run-id>/`; check one with
`node apps/proofops/src/evidence.ts evidence-local/<run-id> <anchored-manifest-sha256>` (PASS, FAIL, INCOMPLETE or TAMPERED).

## Architecture
- `apps/proofops/src/server.ts`: control plane and operator API (holds the model key; the worker never does).
- `model.ts`: planner. Vultr Serverless Inference through the OpenAI-compatible client, or a labelled scripted stub.
- `policy.ts`: five typed actions, checked before anything reaches the browser.
- `worker/worker.mjs`: disposable Playwright worker; stdin/stdout control; re-checks each element before acting.
- `gateway.ts`: the worker's only way out; forwards to the run's storefront session only, from a fixed upstream.
- `signer.ts`: separate process holding the only checkout-approval key.
- `storefront.ts`: synthetic store; its checkout endpoint verifies approvals itself.
- `verifier.ts`: judges frozen expectations against the page and the store's own records.
- `evidence.ts`: per-run bundle with SHA-256 checksums; the manifest hash is anchored outside the bundle.
- `ops/`: VM bootstrap (Docker, gVisor `runsc`), deploy, systemd, Caddy, and the gVisor boundary probe runbook.

## Prior work disclosed
JARVIS ProofOps is a new commerce QA and secure browser-execution product developed for Vultr Agent Rush, built on selected reusable foundations from our earlier JARVIS engineering work. It is not a clean-room implementation, and it is not a renamed ACT III.

This repository starts from a sanitized snapshot of the same author's earlier project, **JARVIS ACT III** (https://github.com/ascendlevelup18-byte/jarvisACTIII, commit `c69ca2c`). Every inherited file, its source commit and checksum are listed in [REUSE-LEDGER.md](REUSE-LEDGER.md). The disclosed import is commit `a6ac809`, following initial commit `ac9b087`. Later commits include pre-kickoff preparation and must not all be represented as functionality developed during the event. Refund-specific ACT III features have since been removed.

## Separate from JARVIS ACT III
Separate repository, history, VM and credentials. No ACT III secrets, environment files or deployment settings were copied. Run data is kept in SQLite on the ProofOps VM.

## Inherited code in use
Only the OpenAI-compatible client in `apps/api/src/provider/`. See [REUSE-LEDGER.md](REUSE-LEDGER.md).

## Third-party software
Runtime: [Playwright](https://playwright.dev) (Apache-2.0), [zod](https://zod.dev) (MIT). On the VM: Docker, [gVisor](https://gvisor.dev) (Apache-2.0), [Caddy](https://caddyserver.com) (Apache-2.0), Node.js (MIT).

## License
MIT (see [LICENSE](LICENSE)).
