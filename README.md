# JARVIS ProofOps — Execute. Contain. Verify.

Entry for the Vultr: Agent Rush Hackathon 2026 (lablab.ai), Challenge 1 "Blast Radius Zero": a commerce QA agent that plans real browser work with Vultr Serverless Inference, runs it with Playwright inside a gVisor sandbox on a Vultr VM, and lets an independent verifier, not the model, decide what actually happened.

**AI proposes. Policy authorizes. The browser acts inside a restricted boundary. Independent verification decides. Evidence proves it.**

## Try it
Open the [operator console](https://45-63-82-115.sslip.io). The store is synthetic, so no real products, payments or customers are involved.

1. Run **Correct discount**, then **Wrong discount**. Compare the frozen $90 expectation with the observed $95. The model reports success on both, and only the verifier fails the second.
2. Run **Hostile page**. Read the model's first reason in the timeline and the refused requests in the containment panel.
3. Run **Approved checkout**, review the exact cart, and approve one synthetic order. The run then shows the used approval being replayed and refused.
4. Use **Re-check evidence integrity**, and open the run report and logs.

One mission runs at a time. If you see "Another mission is still running", someone else is using the demo, so wait and try again.

![The hostile-page mission: verdict, refused requests and evidence](proof/vultr-live-20261104/ui/04-hostile-page.png)

## Status (production `d14d24c`, tag `release-20261104`)
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

## Security model
| Boundary | What it does |
|---|---|
| Model | Proposes one typed action at a time. It has no browser, no store access and no approval power, and its claims are not the verdict. |
| Policy | Only five typed actions exist. Unknown, off-site, stale or consequential actions are refused before they reach the browser. |
| Sandbox | gVisor `runsc`, no network, read-only root, non-root user, no capabilities, memory, CPU and process caps. It refuses to start without `runsc`. |
| Gateway | The worker's only way out, over a per-run Unix socket. It forwards only to that run's store session. |
| Human approval | Ed25519 signature from a separate process, bound to the run and exact cart, single-use and expiring. The store verifies it itself. |
| Verifier | Compares expectations frozen before the first model call with the page and the store's own records. |
| Evidence | SHA-256 for every file, with the manifest hash anchored in the run registry, outside the bundle. |

**Limitations:**
- The store is synthetic. There is no integration with a real commerce platform.
- Evidence uses checksums, not signatures. Someone with root on the VM could change a bundle and its anchor, and nothing here protects against a compromised host.
- Signer, verifier and control plane are separated by process on one VM, not by machine or user account.
- Testing checks the boundary as configured. It does not prove gVisor itself has no flaws.
- In the recorded live runs the model ignored the hostile page's injection. That is an observation about those runs, not a measured rate, and no model has been seen being stopped by policy. Policy's refusals were shown separately with proposals forced by a test harness on the scripted planner.
- One mission at a time, single instance, no user accounts. Only the browser that started a mission can approve or cancel it.

## Scripted and live modes
| | Local (`npm run proofops:demo`) | Vultr VM, `stub` | Vultr VM, model id |
|---|---|---|---|
| Planner | Scripted | Scripted | Vultr Serverless Inference |
| Browser isolation | None | gVisor | gVisor |
| Needs | Node 24, Chromium | Ubuntu 24.04 VM, Docker, gVisor | The same, plus a Serverless Inference subscription and key |
| Evidence tier | `LOCAL_MODEL_STUB` | `VULTR_GVISOR_SCRIPTED` | `VULTR_GVISOR_LIVE_MODEL` |

The page header shows the mode, and every bundle records its tier. The system never switches between them by itself. The live model is `deepseek-v4.1-flash-1017`, at about $0.001 per mission at catalog prices.

## Public demo controls and data
One active mission, six starts a minute per address, 150 starts per rolling day, and per-mission caps of 12 steps, 14 model calls and 60,000 tokens. Run status and evidence checksums are in SQLite on the VM. Sealed evidence bundles are on disk, keeping the most recent 300. Pending approvals and live streams are in memory, so a restart ends the run and its authority.

## Evidence, releases and rollback
- [proof/release-20261104/EVIDENCE-MAP.md](proof/release-20261104/EVIDENCE-MAP.md) maps each claim to a file or run.
- `release-20261104` tags the production commit `d14d24c`. Commits after it change only documentation and evidence.
- [ops/RECOVERY.md](ops/RECOVERY.md) covers failures, operator commands, the labelled scripted fallback and rollback.

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
