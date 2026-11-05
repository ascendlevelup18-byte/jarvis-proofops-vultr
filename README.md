# JARVIS ProofOps — Execute. Contain. Verify.

Entry for the Vultr: Agent Rush Hackathon 2026 (lablab.ai), Challenge 1 "Blast Radius Zero": a commerce QA agent that plans real browser work with Vultr Serverless Inference, runs it with Playwright inside a gVisor sandbox on a Vultr VM, and lets an independent verifier, not the model, decide what actually happened.

**AI proposes. Policy authorizes. The browser acts inside a restricted boundary. Independent verification decides. Evidence proves it.**

## Judge walkthrough

Open the [operator console](https://45-63-82-115.sslip.io). Run **Correct discount**, then **Wrong discount**. Compare the frozen $90 expectation with the observed $95 and open the evidence integrity check. Run **Hostile page** to inspect network refusals. Use **Approved checkout** to review the exact cart and authorize one synthetic order.

## Status (4 Nov 2026)
| Tier | Status |
|---|---|
| Local, scripted planner, real Chromium (not isolated) | Working: `npm run proofops:release` passes every local gate |
| Vultr VM, gVisor sandbox, real Chromium, **scripted planner** | Working: 24/24 boundary checks and all six missions. See [proof/vultr-20261104](proof/vultr-20261104/README.md) |
| Vultr VM, gVisor sandbox, real Chromium, **live model** | Working: all six missions with `deepseek-v4.1-flash-1017` on Vultr Serverless Inference. See [proof/vultr-live-20261104](proof/vultr-live-20261104/README.md) |
| Public demo | https://45-63-82-115.sslip.io runs the live-model tier, and the header names the model |

Local and scripted results are never presented as live-model evidence. Every evidence bundle records its tier.

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

## Deploy on a VM
Needs Ubuntu 24.04 and SSH to a host key you verified yourself. As root on the VM:
```
git clone https://github.com/ascendlevelup18-byte/jarvis-proofops-vultr /opt/proofops/app
cd /opt/proofops/app
bash ops/vm-bootstrap.sh                                             # Docker, gVisor, Node 24, Caddy, firewall, service users
chown -R proofops: /opt/proofops
bash ops/deploy-app.sh <git-ref> stub <deployment-label> <hostname>  # builds the worker image, starts proofops and Caddy
```
A model id in place of `stub` runs the live planner and needs the inference key installed first with `ops/set-inference-key.ps1`, which reads it from a hidden prompt. The service refuses to start if the key, `runsc` or the worker image is missing. [ops/DAY1-RUNBOOK.md](ops/DAY1-RUNBOOK.md) has the full sequence, including the gVisor boundary probe. [ops/RECOVERY.md](ops/RECOVERY.md) covers failures, the operator commands, the labelled scripted fallback and rollback.

## Architecture

Caddy terminates HTTPS and streams the same-origin API and operator console from one Node service on the Vultr VM. The frontend is static HTML, CSS and JavaScript in `apps/proofops/ui/`. Live run progress uses Server-Sent Events. The browser worker is a separate disposable process in a gVisor container.

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

## Persistence and public demo controls

| Data | Storage and lifecycle |
|---|---|
| Run status, verdict, idempotency and evidence checksum | SQLite in WAL mode at `/var/lib/proofops/data/runs.db` on the VM. A restart marks interrupted runs failed. |
| Evidence and approval audit events | Run bundles at `/var/lib/proofops/evidence/`. Completed bundles are sealed and checked against the checksum stored in SQLite. The public service keeps the most recent 300 bundles. |
| Pending approval, active cart and live stream | Run-scoped memory. Restart ends the run and its authority. The signer binds approvals to a run and cart, and the synthetic storefront enforces single use. |

The public instance allows one active run, six starts per minute per client, and 150 recorded starts per rolling day. The starting browser holds the token needed to approve, reject or cancel. Public history omits full run identifiers and internal paths.

The GitHub release check exercises the local scripted tier on Ubuntu with Chromium. Use the [VM runbook](ops/DAY1-RUNBOOK.md) for sandbox and live-model evidence. The [health endpoint](https://45-63-82-115.sslip.io/api/health) shows the deployed commit, planner and isolation tier without starting a run.

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
