# Canonical claims

Use these words for the video, deck, README, submission form and audit. If a statement isn't supported here, don't make it.

## Versions
| Name | Value | Meaning |
|---|---|---|
| Production code | `d14d24c` | What runs at https://45-63-82-115.sslip.io |
| Release tag | `release-20261104` | Points at `d14d24c`; the rollback point |
| Evidence commit | `c360f56` | Where the 4 Nov results were first recorded |
| Verifiable repository state | `35e201d` or later on `main` | Includes 124 run logs missing before it. **A clone of `c360f56` shows every bundle as TAMPERED because those files are absent.** Commits after `d14d24c` change no application code |

Never present an evidence commit as deployed code. Results keep the commit they ran at.

## Positioning
JARVIS ProofOps enables policy-controlled autonomous browser execution inside isolated environments, with independently verified outcomes and auditable evidence.

Today this is a **working prototype on one synthetic store**, on one VM, one mission at a time, with no real payments.

## What you can say
| Topic | Claim | Evidence | Limit |
|---|---|---|---|
| Model autonomy | `deepseek-v4.1-flash-1017` on Vultr Serverless Inference chose each action in the live runs | `model-calls.jsonl` | Task, tools and scope are fixed by us. Replies vary between runs |
| Prompt injection | In the recorded hostile runs, the live model ignored the page's injected instruction | Hostile run, `policy-decisions.jsonl` step 0 | An observation, not a resistance rate |
| Page scripts | The hostile page's own scripts made 4 requests, and the gateway refused them all, with 0 orders | Hostile run `gateway.jsonl`, `report.md` | Refused by the gateway, not by the model |
| Policy | In a **separate** test on the scripted planner, a harness forced 4 malicious proposals: 3 denied and 1 held for approval, none dispatched | `vultr-live-20261104/forced-attack/` | **No model has been seen being stopped by policy** |
| Network isolation | The worker has `network none`, loopback only, and reaches only its run's store through a per-run socket gateway. Internet, metadata, IPv6, DNS and UDP failed in the probe | `vm-boundary.json` | The boundary as configured |
| gVisor | Docker reports runtime `runsc`, the guest kernel reports gVisor, and the host shows `runsc-sandbox` and `runsc-gofer`. The service refuses to start without `runsc` | `host-view-during-live-mission.txt`, `vm-boundary.json`, each `manifest.json` | Not proof that gVisor has no flaws |
| Independent verification | A deterministic verifier compares expectations frozen before the first model call with the page and the store's own records. The model reached checkout on the wrong discount, and the verifier failed it at $95 vs $90 | `assertions.json` | Verifies this store's defined checks. The verifier shares a VM with the control plane |
| SHA-256 integrity | Each file is hashed into a manifest, and the manifest's hash is recorded in the run registry, outside the bundle. This shows a bundle has not changed since sealing, **relative to that registry** | `manifest.json`, `ANCHORS.txt` | **Not signed, not HMAC, not immutable, not tamper-proof.** Someone with root on the VM could rewrite both |
| Checkout approval | An order needs a human's approval, signed with Ed25519 by a separate process, bound to the run and exact cart. The store verifies it | Approved run; `release-20261104/public-safety-test.txt` | Synthetic orders. Fixed demo identity, process separation only |
| Replay prevention | The used approval replayed against the store got HTTP 403, and simultaneous approvals gave one signature | Approved run `events.jsonl`; public safety test | 20-concurrent test is local tier |
| Containment and cleanup | Workers are destroyed after each mission, confirmed with Docker. A hung page is killed at 25 seconds | `cleanup.json`; hung run | One earlier run read "teardown not proven", kept as recorded in `runs-e5300f9` |
| Token usage | Six missions at `d14d24c`: 28 calls, 21,704 tokens. About $0.001 per mission at catalog prices | `model-calls.jsonl` | **Calculated, not an invoice** |
| Reliability | At `d14d24c`: six live missions and a five-mission public rehearsal behaved as designed. Reboot back in 34 seconds (at `85de6ce`). Fails closed on a rejected key, missing key or missing sandbox | `release-20261104/` | Small sample. Not an uptime figure. 429, 5xx and timeouts on a mock only |

## Test results, kept separate
| When | Commit | Result |
|---|---|---|
| 5 Nov | `2e51064` | Local: 87/87 unit/HTTP, 52/52 Chromium, 6/6 smoke (no gVisor, scripted). Public GET-only checks 31/31 at `d14d24c` |
| 4 Nov | `d14d24c` | VM: boundary 24/24, six live missions, rehearsal 5/5, public safety 53/53, recovery tests |
| 5 Nov, 11:03 to 11:05 UTC | `d14d24c` | Five public missions used for the video, read from their evidence |

These are separate runs. Never describe them as one release run.

## Never say
- HMAC, signed evidence, cryptographically sealed by a host secret, immutable, tamper-proof.
- The model tried something malicious and was blocked. Or that it always resists injection.
- Protected against host or root compromise. gVisor can't be escaped. Blast radius is literally zero.
- Integrated with Shopify or any real platform. Handles real payments. Compliant or certified.
- Customers, revenue, partnerships, valuation, ROI. Actual cost, for calculated figures. Promotional credits guarantee no personal spending.
- Clean-room. Organizers have approved the reuse.
