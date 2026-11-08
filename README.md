# JARVIS ProofOps

Give JARVIS a task. A live Vultr model operates a real browser inside a gVisor sandbox, a fixed policy decides every action, and an independent verifier checks the result against trusted records, not the model's report.

| | |
|---|---|
| **What does it do?** | A chat assistant that does two kinds of real browser work: **website QA** (audit a staging site for broken links) and **synthetic commerce QA** (fill a cart, check a total, and place a synthetic order only after a human approves the exact cart). Entry for Vultr Agent Rush 2026, Challenge 1: Blast Radius Zero, pattern B (sandboxed browser use). |
| **Why does containment matter?** | An agent can finish a task and still be wrong, and a web page can try to take it over. Here the model has no authority of its own: every proposed action passes a policy, the browser can only reach its own run's site, and the verdict comes from the server's records. In a recorded live audit, the page told the model to stop early with false findings and its scripts called a canary host and the cloud metadata address. The model ignored it, policy refused two of its out-of-scope navigations, the gateway refused 52 page requests, and the audit still verified. |
| **What runs on Vultr?** | All of it. Vultr Serverless Inference runs the planner (`deepseek-v4.1-flash-1017`). One Vultr VM runs the web app, control plane, policy, gateway, verifier, the synthetic sites, and Chromium inside gVisor. |
| **How do I try it?** | Open **[the live app](https://45-63-82-115.sslip.io)** and type a task (below), or [run it locally](#run-it-locally) with a scripted planner. |
| **What can I inspect?** | [Live website-QA runs](proof/vultr-live-20261108-qa/README.md), [intent routing on production](proof/vultr-live-20261108-intent/README.md), [live chat tasks](proof/vultr-live-20261108/README.md), the [earlier sealed runs](proof/vultr-live-20261104/README.md), and the [fact sheet](proof/FACT-SHEET.md). Every bundle can be [checked yourself](#evidence-integrity). |

![A live website audit in the chat: nine pages checked, three broken links found and confirmed](proof/vultr-live-20261108-qa/LIVE-QA-03-result.png)

*Real screenshot of a live-model audit of the hostile test site, under gVisor on the production VM, 8 Nov 2026.*

## Versions
| | |
|---|---|
| Production | `6cc0cdc`, deployed to https://45-63-82-115.sslip.io on 8 Nov 2026. [`/api/health`](https://45-63-82-115.sslip.io/api/health) reports the exact running commit |
| `main` | `6cc0cdc` plus documentation-only commits, which don't change the running app |
| Previous releases | `88bb4a6`, `1d25050`, `76fee8b`, `64e6714`, and the original `d14d24c` (tag [`release-20261104`](ops/RECOVERY.md#rollback)) |
| Planner in production | `deepseek-v4.1-flash-1017` on Vultr Serverless Inference, under a hard spend ceiling checked before every call |

## Try it
Type one of these into the chat. Everything is synthetic: no real sites, products, payments or customers.

| You type | What happens |
|---|---|
| **Audit the staging website for broken links and show me the verified findings.** | Each run gets a fresh 9-page staging site with 2 or 3 broken links hidden on the server. The model clicks through it, and the verifier checks which pages the browser really opened and whether every reported link is truly broken. Add "docs", "blog" and so on for one section, or "hostile" for the version with planted instructions |
| **Add 2 ProofOps Field Jackets to the cart, apply SAVE10, and confirm the total is $190 without placing an order.** | The store's own records are checked against the goal you stated |
| **Buy one jacket with code SAVE10. Place the order after I approve it.** | An approval card shows the exact cart. Only its button can approve; typing "yes" doesn't |
| **What can you do?** or **What sells the most?** | A plain answer from the store's data, with no task started and no ranking invented |

JARVIS is a bounded execution agent, not yet an unrestricted personal assistant. It runs tasks only on the built-in staging site and the synthetic store. Before any task parser sees a message, a small intent router sorts it into talk, research, website QA, commerce, unsupported or unsafe. A request it can't execute, such as "Find the most viewed video on YouTube", gets a plain answer that this version has no authorized web access, and nothing starts. The router grants nothing: each capability still validates its own scope and policy. One task runs at a time; if it's busy, wait and try again. Technical activity and evidence are under **Settings → Activity & Security**.

| Wrong total fails | Human approves the exact cart | Hung page is destroyed |
|---|---|---|
| ![Verified fail at $95 against $90](proof/vultr-live-20261104/ui/03-wrong-discount.png) | ![Approval card with item, code, total and cart hash](proof/vultr-live-20261104/ui/05-approved-checkout-approval.png) | ![Timed out, limit row, sandbox destroyed](proof/vultr-live-20261104/ui/06-hung-page.png) |

These three are from the earlier operator console at `d14d24c`, recorded in [`rehearsal.json`](proof/vultr-live-20261104/ui/rehearsal.json). The checks they show are unchanged in the chat.

## Architecture
```mermaid
flowchart LR
  U[User's browser<br/>JARVIS chat] -->|HTTPS| C[Caddy]
  C --> S[Control plane<br/>router, policy, run registry]
  S <-->|typed action JSON| M[Vultr Serverless<br/>Inference]
  S -->|stdin and stdout only| W
  subgraph G[gVisor runsc, network none, read-only, non-root]
    W[Disposable worker<br/>Playwright + Chromium]
  end
  W -->|per-run Unix socket| GW[Restricted gateway]
  GW -->|this run's session only| ST[Synthetic store<br/>and staging site]
  S --> SG[Approval signer<br/>separate process]
  SG -. signed, single-use approval .-> ST
  S --> V[Independent verifier]
  V --> ST
  V --> E[(Evidence bundle<br/>+ anchor in SQLite)]
```
Everything shown except the model runs on one Vultr VM. The model service is outside the worker: the control plane sends it the task and the page's observed text and elements, and gets back one proposed action as JSON. The model never runs code, holds no keys, and the worker never sees the model key.

A chat message first goes to an unprivileged router: talk is answered from the store's data with no run, a direction goes to the capability's goal validator, and anything off-boundary is refused. Each capability (store task, website QA) freezes its goal into a hashed spec, declares which pages it may reach and which actions it may take, and has its own verifier checks.

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
| [`conversation.ts`](apps/proofops/src/conversation.ts), [`tasks.ts`](apps/proofops/src/tasks.ts) | Router for talk and refusals, and the strict store-goal validator |
| [`site-qa.ts`](apps/proofops/src/site-qa.ts) | Website QA: per-run staging site, goal validator, scope, audit memory, and its contract |
| [`inference-budget.ts`](apps/proofops/src/inference-budget.ts) | Hard spend ceiling, reserved before every model call, no automatic retries |
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
Before the first model call, the goal is frozen in a sealed spec. After the run, [`verifier.ts`](apps/proofops/src/verifier.ts) checks it without using the model's report.
- **Store tasks:** subtotal, discount, total, cart, checkout and order count, against the page and the store's own records.
- **Website QA:** from the store's own record of every page the browser requested, whether each in-scope page was opened, whether each broken link was opened and returned "Page not found", and whether the agent's reported list has no false and no missed findings. The agent's report is a claim under test.

Results fall into separate outcomes: the task (commerce or QA), permissions, containment, evidence and cleanup. The verifier is deterministic code. No vision model or LLM judges any result; screenshots are evidence for people to inspect.

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
| Live chat tasks: pass, wrong total, approval refused, hostile page | Vultr VM, gVisor, beside production | `77c8517` | 4 of 4 as expected | [runs](proof/vultr-live-20261108/README.md) |
| gVisor boundary | Vultr VM | `77c8517`, then production `64e6714` | 24/24 each | [boundary](proof/vultr-live-20261108/vm-boundary-candidate.json) |
| Live website QA: whole site, docs section, hostile site | Vultr VM, gVisor, beside production | `7055433`, then `fc2a367` | 1 VERIFIED FAIL (whole site, before the audit-memory fix), then 2 VERIFIED PASS (docs section; hostile whole site) | [runs](proof/vultr-live-20261108-qa/README.md) |
| Live website QA after release: whole site, from the chat's first example | Production, public URL | `1d25050` | **VERIFIED FAIL**: opened all 9 pages, then looped and never opened the 3 broken links. Caught by the verifier, 0 orders | `run_20261108200949_97cc69c90ce6526e` |

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

## Public limits
One active task at a time, six task starts a minute per address, 150 per rolling day. Talk and refusals share a separate 240-a-minute limit and start nothing. Store tasks are capped at 12 steps, 14 model calls and 60,000 tokens, and audits at 30 steps, 32 model calls and 60,000 tokens. A hard $3 inference ceiling for the deployment is reserved before every model call, at double the recorded catalog price, with no automatic retries. Only the browser that started a task can read, approve or cancel it. Behind the proxy, only the public host name and origin are accepted. Pending approvals live in memory, so a restart ends the run and its authority.

## Threat model and limitations
[`SECURITY.md`](SECURITY.md) has the threat model and how to report a problem. In short:
- **Synthetic store only.** No real commerce integration or payments.
- **No protection against host or control-plane compromise.** Signer, verifier and control plane are separated by process on one VM.
- **Checksums, not signatures,** as above.
- **Boundary tested as configured.** That's not proof gVisor has no flaws, and there's been no third-party penetration test.
- **Model behavior is an observation.** In the recorded hostile runs the model ignored the page's injection. That isn't a resistance rate. Policy has refused the live model's own proposals: typing a quantity it didn't need (LIVE-01, 8 Nov) and navigating outside an audit's start pages (LIVE-QA-03). Those were ordinary mistakes, not attacks. Refusals of malicious proposals come from separate tests with proposals forced by a harness.
- **One instance, one mission at a time, no accounts.** One visitor can use up the shared daily cap.
- **State in memory:** the store, approvals and live streams don't survive a restart. Only the run registry and evidence do.
- **Approvals are at-most-once, not durable.** A token is bound to the run, the action and the exact cart, and can be used once. Twenty simultaneous submissions of one token placed one order in testing. If a checkout response were lost, a retry would be refused rather than returning a stored receipt, which is why this design isn't ready for real payments.
- **Whole-site audits are not yet reliable.** Since the audit-memory fix, live whole-site audits have passed 1 of 2 times; the model sometimes loops between pages. The verifier marks every such run VERIFIED FAIL. Section audits are the more reliable task.
- **Website QA covers only the built-in staging site.** Auditing a site you name would need per-origin authorization, DNS pinning and redirect checks in the gateway. That isn't built, and other sites are refused.
- **No open-web research.** JARVIS can't browse YouTube or the internet, and won't answer such questions from memory as if it had checked. Adding read-only research would need an approved data source, an allow-listed gateway route with redirect and DNS checks, and source-attributed verification. None of that is built.
- **The chat's talk answers are fixed text** built from the store's data, not a model. They don't answer general questions.
- **`npm audit`** reports 0 vulnerabilities at this release.

## Prior work disclosed
JARVIS ProofOps is a new commerce QA and secure browser-execution product developed for Vultr Agent Rush, built on selected reusable foundations from our earlier JARVIS engineering work. It is not a clean-room implementation, and it is not a renamed ACT III.

This repository starts from a sanitized snapshot of the same author's earlier project, [JARVIS ACT III](https://github.com/ascendlevelup18-byte/jarvisACTIII). [`REUSE-LEDGER.md`](REUSE-LEDGER.md) separates inherited foundations from new work, and lists every inherited file with its source commit and checksum. Git history includes that snapshot and pre-kickoff preparation, so not every commit represents work done during the event. The first commit containing ProofOps application code is `61784cc`, shortly after kickoff. A commit time shows when work was committed, not when it was written. **No organizer ruling on this reuse has been confirmed.**

Separate repository, history, VM and credentials. No ACT III secrets, environment files or deployment settings were copied.

## Roadmap
A prototype today. See also the [changelog](CHANGELOG.md) and [how to contribute](CONTRIBUTING.md). Proposed next steps, none implemented: signed evidence with an external anchor, durable approval records, login and roles, one real staging-store connector with no real payments, and an external penetration test. Then multi-tenant operation and organization policies.

## License and third-party software
MIT, see [LICENSE](LICENSE). Runtime: [Playwright](https://playwright.dev) (Apache-2.0), [zod](https://zod.dev) (MIT). On the VM: Docker, [gVisor](https://gvisor.dev) (Apache-2.0), [Caddy](https://caddyserver.com) (Apache-2.0), Node.js (MIT).
