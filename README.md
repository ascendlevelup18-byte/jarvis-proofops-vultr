# JARVIS ProofOps

Policy-controlled autonomous browser execution inside isolated environments, with independently verified outcomes and auditable evidence.

| | |
|---|---|
| **What does it do?** | Runs a commerce QA task with an AI agent in a real browser, limits what the agent can reach, and checks the result without trusting the agent. A working prototype on one synthetic store. Entry for Vultr Agent Rush 2026, Challenge 1: Blast Radius Zero. |
| **Why is it different?** | An agent can finish a task and still be wrong, and a web page can try to take it over. Here the agent's report isn't the verdict, the model has no authority of its own, and every run leaves evidence you can check. In our recorded run the model reached checkout and reported the promo applied on a $95 cart that should have been $90, and the verifier failed it. |
| **What runs on Vultr?** | All of it. Vultr Serverless Inference runs the model (`deepseek-v4.1-flash-1017`), and one Vultr VM runs the control plane, policy, gateway, verifier, the synthetic store, and Chromium inside gVisor. |
| **How do I try it?** | Open **[the live demo](https://45-63-82-115.sslip.io)**, or [run it locally](#run-it-locally) with a scripted planner. |
| **What can I inspect?** | [Fact sheet](proof/FACT-SHEET.md) (what is and isn't claimed), [evidence map](proof/release-20261104/EVIDENCE-MAP.md) (each claim to its file), and [sealed run bundles](proof/vultr-live-20261104/README.md) you can [verify yourself](#evidence-integrity) with one command. |

![The hostile-page mission on the live demo: verified result, four refused requests and the evidence panel](proof/vultr-live-20261104/ui/04-hostile-page.png)

*Real screenshot of the public demo at production commit `d14d24c`, live model. The store is synthetic.*

## Versions
| | |
|---|---|
| Production code | `d14d24c`, tag [`release-20261104`](ops/RECOVERY.md#rollback) |
| Evidence | Complete from `35e201d`, tag `evidence-20261105`. Later commits on `main` change only documentation and evidence |
| Planner in production | `deepseek-v4.1-flash-1017` on Vultr Serverless Inference |

## Try it
The store is synthetic, so no real products, payments or customers are involved.

1. Run **Correct discount**, then **Wrong discount**. Compare the frozen $90 expectation with the observed $95. The model reports reaching checkout both times, and only the verifier fails the second.
2. Run **Hostile page**. Read the model's first reason in the timeline and the refused requests in the containment panel.
3. Run **Approved checkout**, review the exact cart, and approve one synthetic order. The run then replays the used approval, and the store refuses it.
4. Use **Re-check evidence integrity**, then open the run report and logs.

On a laptop, scroll down for **Run mission** and for the verdict when a mission ends. One mission runs at a time. If you see "Another mission is still running", someone else is using the demo, so wait and try again. Each mission uses real tokens, so please don't run them in a loop.

| Wrong total fails | Human approves the exact cart | Hung page is destroyed |
|---|---|---|
| ![Verified fail at $95 against $90](proof/vultr-live-20261104/ui/03-wrong-discount.png) | ![Approval card with item, code, total and cart hash](proof/vultr-live-20261104/ui/05-approved-checkout-approval.png) | ![Timed out, limit row, sandbox destroyed](proof/vultr-live-20261104/ui/06-hung-page.png) |

All from the public rehearsal at `d14d24c`, recorded in [`rehearsal.json`](proof/vultr-live-20261104/ui/rehearsal.json).

## Architecture
```mermaid
flowchart LR
  U[Operator's browser] -->|HTTPS| C[Caddy]
  C --> S[Control plane<br/>policy, run registry]
  S <-->|typed action JSON| M[Vultr Serverless<br/>Inference]
  S -->|stdin and stdout only| W
  subgraph G[gVisor runsc, network none, read-only, non-root]
    W[Disposable worker<br/>Playwright + Chromium]
  end
  W -->|per-run Unix socket| GW[Restricted gateway]
  GW -->|this run's session only| ST[Synthetic store]
  S --> SG[Approval signer<br/>separate process]
  SG -. signed, single-use approval .-> ST
  S --> V[Independent verifier]
  V --> ST
  V --> E[(Evidence bundle<br/>+ anchor in SQLite)]
```
Everything shown except the model runs on one Vultr VM.

| Component | Role |
|---|---|
| [`server.ts`](apps/proofops/src/server.ts) | Control plane and API. Holds the model key, and the worker never does |
| [`model.ts`](apps/proofops/src/model.ts) | Planner: Vultr Serverless Inference, or a labelled scripted stub |
| [`policy.ts`](apps/proofops/src/policy.ts) | Five typed actions, checked before anything reaches the browser |
| [`worker/worker.mjs`](apps/proofops/worker/worker.mjs) | Disposable browser worker that re-checks each element before acting |
| [`gateway.ts`](apps/proofops/src/gateway.ts) | The worker's only way out |
| [`signer.ts`](apps/proofops/src/signer.ts) | Separate process holding the only checkout-approval key |
| [`storefront.ts`](apps/proofops/src/storefront.ts) | Synthetic store whose checkout verifies approvals itself |
| [`verifier.ts`](apps/proofops/src/verifier.ts) | Judges frozen expectations against the page and the store's records |
| [`evidence.ts`](apps/proofops/src/evidence.ts) | Bundles, hashes, and the PASS, FAIL, INCOMPLETE or TAMPERED classifier |

**Technology:** Node.js 24 and TypeScript, Playwright with Chromium, Docker with gVisor `runsc`, Caddy for HTTPS, SQLite for the run registry, zod for validation.

**Vultr services:** one Vultr VM (Ubuntu 24.04, 4 vCPU, 8 GB) runs the backend, sandbox and public site. Vultr Serverless Inference handles all agent model calls, through its OpenAI-compatible API at `https://api.vultrinference.com/v1`.

## gVisor boundary
Each mission starts a new container with `--runtime=runsc --network=none --read-only --cap-drop=ALL --user 10001:10001`, 1 GiB of memory, 1 CPU and 256 processes, an empty environment, and only its per-run socket folder mounted. If Docker reports any other runtime, the run stops, and the service won't start without `runsc`.

A [24-point probe](proof/vultr-live-20261104/vm-boundary.json) runs inside a real worker. It confirms the runtime as seen by Docker and from inside, and that internet, metadata, IPv6, DNS, UDP and the host bridge all fail. It confirms the gateway reaches the run's store and refuses other hosts, metadata, loopback, other sessions and tunnels. The [host view](proof/vultr-live-20261104/host-view-during-live-mission.txt) shows `runsc-sandbox` and `runsc-gofer` during a live mission.

## Approval flow
1. The model asks for approval with `request_approval`. It can't place an order itself, and policy refuses a direct click on the order button.
2. The operator sees the exact item, promo code, total and cart hash. Only the browser that started the mission can answer.
3. A separate signer process issues an Ed25519 approval bound to the run and that cart's hash, single-use and expiring.
4. The store verifies the signature itself and consumes the nonce as it places the order.
5. The run replays the used approval straight to the store, and records the refusal (HTTP 403).

This covers synthetic orders. Sessions, approvals and consumed nonces are held in memory, so a restart ends them. The signer's key is regenerated at each start, and the operator identity is a fixed demo label.

## Independent verifier
Before the first model call, the expected subtotal, discount, total, cart and order count are frozen in a sealed spec. After the run, [`verifier.ts`](apps/proofops/src/verifier.ts) checks them against the page and against the store's own records, without using the model's report. Results fall into five outcomes: commerce, permissions, containment, evidence and cleanup.

## Evidence integrity
Each run produces a bundle with its spec, every model call, every policy decision, gateway log, store state, screenshots, assertions, teardown record and report. Each file gets a SHA-256 hash in `manifest.json`. The manifest's own hash is stored in the run registry, outside the bundle.

**What this establishes:** a bundle has not changed since sealing, relative to the hash in the registry.
**What it does not:** these are checksums, not signatures. Someone with root on the VM could rewrite both a bundle and its anchor. Nothing here is externally anchored.

Verify a bundle from a clone. Anchors are in [`ANCHORS.txt`](proof/vultr-live-20261104/runs-d14d24c/ANCHORS.txt):
```
node apps/proofops/src/evidence.ts proof/vultr-live-20261104/runs-d14d24c/<run-id> <anchor>
```
Or check every committed bundle at once, with Node 24 and no install:
```
git clone https://github.com/ascendlevelup18-byte/jarvis-proofops-vultr
cd jarvis-proofops-vultr
node --no-warnings proof/verify-all.mjs
```
PASS and FAIL are sealed verdicts, so designed FAILs are expected. One historical bundle reads INCOMPLETE ("worker teardown not proven", at `e5300f9`), and it's kept as recorded. On the live demo, use **Re-check evidence integrity**.

## Test results
Each result is at the commit it actually ran on. These are separate runs, not one release run.

| Test | Where | Commit | Result | Record |
|---|---|---|---|---|
| Unit, HTTP, model faults | Local | `1f99dac` | 87/87 | [gate](proof/release-20261105/release-gate.json) |
| Chromium and forced attacks | Local, scripted, no gVisor | `1f99dac` | 52/52 | same |
| Smoke, six missions | Local, scripted, no gVisor | `1f99dac` | 6/6 | same |
| gVisor boundary | Vultr VM | `d14d24c` | 24/24 | [boundary](proof/vultr-live-20261104/vm-boundary.json) |
| Six live-model missions | Vultr VM, gVisor | `d14d24c` | As designed, including 3 designed FAILs | [runs](proof/vultr-live-20261104/runs-d14d24c/smoke-output.txt) |
| Forced malicious proposals | Vultr VM, gVisor, **scripted planner** | `d14d24c` | 4 stopped before dispatch | [run](proof/vultr-live-20261104/forced-attack/) |
| Public rehearsal, real clicks | Public site | `d14d24c` | 5/5 | [rehearsal](proof/vultr-live-20261104/ui/rehearsal.json) |
| Public safety from outside | Public site | `d14d24c` | 53/53 | [output](proof/release-20261104/public-safety-test.txt) |
| Failure recovery | Vultr VM | `d14d24c` | Fails closed | [output](proof/release-20261104/failure-recovery-vm.txt) |

**CI:** no GitHub Actions workflow runs on `main` yet. The gate above is `npm run proofops:release`, run locally. Tiers that need the VM or a key are reported as not run by that command.

## Run it locally
Requires Node 24. This mode uses a **scripted planner and no sandbox**, and the page header says so. It's for trying the flow, not evidence of isolation.
```
npm ci
npm ci --prefix apps/proofops/worker
cd apps/proofops/worker && npx playwright install chromium && cd ../../..
npm run proofops:demo      # console on http://127.0.0.1:4317
npm run proofops:smoke     # in a second terminal: all six missions, checked
npm run proofops:release   # full local gate
```

## Modes
| | Local | Vultr VM, `stub` | Vultr VM, model id |
|---|---|---|---|
| Planner | Scripted | Scripted | Vultr Serverless Inference |
| Browser isolation | None | gVisor | gVisor |
| Needs | Node 24, Chromium | Ubuntu 24.04 VM, Docker, gVisor | The same, plus a Serverless Inference subscription and key |
| Evidence tier | `LOCAL_MODEL_STUB` | `VULTR_GVISOR_SCRIPTED` | `VULTR_GVISOR_LIVE_MODEL` |

The system never switches between them by itself, and every bundle records its tier.

## Deploy on a VM
Needs Ubuntu 24.04 and SSH to a host key you verified yourself. As root on the VM:
```
git clone https://github.com/ascendlevelup18-byte/jarvis-proofops-vultr /opt/proofops/app
cd /opt/proofops/app
bash ops/vm-bootstrap.sh                                             # Docker, gVisor, Node 24, Caddy, firewall, service users
chown -R proofops: /opt/proofops
bash ops/deploy-app.sh <git-ref> stub <deployment-label> <hostname>  # builds the worker image, starts proofops and Caddy
```
A model id in place of `stub` runs the live planner, and needs the key installed first with [`ops/set-inference-key.ps1`](ops/set-inference-key.ps1), which reads it from a hidden prompt. [`ops/DAY1-RUNBOOK.md`](ops/DAY1-RUNBOOK.md) has the full sequence. [`ops/RECOVERY.md`](ops/RECOVERY.md) covers failures, operator commands, the labelled scripted fallback and rollback. These steps ran on our VM, and have not been repeated on a clean one.

## Public demo limits
One active mission, six starts a minute per address, 150 starts per rolling day, and per-mission caps of 12 steps, 14 model calls and 60,000 tokens. Only the browser that started a mission can approve or cancel it. Pending approvals live in memory, so a restart ends the run and its authority.

## Threat model and limitations
[`SECURITY.md`](SECURITY.md) has the threat model and how to report a problem. In short:
- **Synthetic store only.** No real commerce integration or payments.
- **No protection against host or control-plane compromise.** Signer, verifier and control plane are separated by process on one VM.
- **Checksums, not signatures,** as above.
- **Boundary tested as configured.** That's not proof gVisor has no flaws, and there's been no third-party penetration test.
- **Model behavior is an observation.** In the recorded hostile runs the model ignored the page's injection. That isn't a resistance rate. Policy's refusals come from a separate test with proposals forced by a harness. **No model has been seen being stopped by policy.**
- **One instance, one mission at a time, no accounts.** One visitor can use up the shared daily cap.
- **State in memory:** the store, approvals and live streams don't survive a restart. Only the run registry and evidence do.
- **One dependency advisory at `d14d24c`:** `npm audit` reports [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high severity, in `zod` 4.6.5: an oversized input to a collection schema can exhaust memory. ProofOps' only zod schema has no collections and validates model replies, not visitor input. Our [assessment and test](proof/release-20261105/zod-advisory-assessment.md) found it not reachable; that is our own review. The upgrade to 4.6.6 is held with the release freeze.
- **Known UI issues at `d14d24c`:** the integrity button reads "Intact: undefined files" if the check itself returns an error, which hasn't occurred in production. Clicking another mission just after **Run mission** can show the wrong title over the run. An open page stays on "Reconnecting…" after a service restart until reloaded. Fixes are on a review branch, held so the tested release stays frozen.
- **Laptop layout at `d14d24c`:** **Run mission** and the verdict can sit below the fold, so scroll down for both. Recent runs on the page can't be opened; use the [sealed run bundles](proof/vultr-live-20261104/README.md) instead.

## Prior work disclosed
JARVIS ProofOps is a new commerce QA and secure browser-execution product developed for Vultr Agent Rush, built on selected reusable foundations from our earlier JARVIS engineering work. It is not a clean-room implementation, and it is not a renamed ACT III.

This repository starts from a sanitized snapshot of the same author's earlier project, [JARVIS ACT III](https://github.com/ascendlevelup18-byte/jarvisACTIII). [`REUSE-LEDGER.md`](REUSE-LEDGER.md) separates inherited foundations from new work, and lists every inherited file with its source commit and checksum. Git history includes that snapshot and pre-kickoff preparation, so not every commit represents work done during the event. The first commit containing ProofOps application code is `61784cc`, shortly after kickoff. A commit time shows when work was committed, not when it was written. **No organizer ruling on this reuse has been confirmed.**

Separate repository, history, VM and credentials. No ACT III secrets, environment files or deployment settings were copied.

## Roadmap
A prototype today. See also the [changelog](CHANGELOG.md) and [how to contribute](CONTRIBUTING.md). Proposed next steps, none implemented: signed evidence with an external anchor, durable approval records, login and roles, one real staging-store connector with no real payments, and an external penetration test. Then multi-tenant operation and organization policies.

## License and third-party software
MIT, see [LICENSE](LICENSE). Runtime: [Playwright](https://playwright.dev) (Apache-2.0), [zod](https://zod.dev) (MIT). On the VM: Docker, [gVisor](https://gvisor.dev) (Apache-2.0), [Caddy](https://caddyserver.com) (Apache-2.0), Node.js (MIT).
