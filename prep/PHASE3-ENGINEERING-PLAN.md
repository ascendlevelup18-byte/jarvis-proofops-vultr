# JARVIS ProofOps: canonical engineering plan (Phase 3)

Written 2 Nov 2026, before kickoff. **Design and planning only: no competition-specific code yet.** This is the one backlog. Work's Phase 2 package (D01–D10), Argon's audit and the critique of that audit are inputs to it; none of them overrides the repository, reproducible tests or the official rules.

## 1. Verified baseline (2 Nov, 18:20 UTC)
| Item | Value |
|---|---|
| Repo | `ascendlevelup18-byte/jarvis-proofops-vultr` (private); branch `main`; HEAD `cc90389`, equal to `origin/main`; clean working tree |
| Remotes | Only `origin`, the ProofOps repo above. No remote can push to ACT III. |
| ACT III | Local `jarvis-actiii-preview` at `59823d7`, tag at `c69ca2c`, clean; demo URL HTTP 200; Supabase `bxjveqmdcnhvlzuotode` still `INACTIVE`. Nothing touched. |
| Unit tests (inherited) | API 242 pass / 0 fail; web 155 pass / 0 fail; web typecheck and build OK |
| Disposable DB tests | ACT III 46/46 before and after; ProofOps 55/55 (twice); ACT III fingerprint unchanged; rollback clean |
| ProofOps acceptance (D01–D10) | **None implemented.** No Vultr VM, inference, sandbox or deployment exists yet. |

## 2. Organizer facts (checked 2 Nov on lablab.ai, the event page and the rule book)
- **Kickoff:** 3 Nov, 08:00 PST, which is **16:00 UTC**. A Discord Q&A follows at 17:00 UTC. The "15:00 UTC" in the directive does not match the page.
- **End of submissions:** 8 Nov, 15:00 PST, which is **23:00 UTC**, plus a 5-minute grace period per the rule book.
  - Work's documents say 22:00 UTC. The owner should confirm the time on the form.
  - Our internal freeze stays at **8 Nov, 18:00 UTC**, whichever is right.
- **Rules:** "Submissions must be original and MIT-compliant." Neither the event page nor the rule book has a clause on pre-existing code.
  - **Reuse clearance is still pending** with the organizers. Until then, the reuse ledger and the first commit disclose the inherited code.
- **Track:** Blast Radius Zero. It needs a Vultr VM backend, a web app on Vultr, Vultr Serverless Inference, and an isolated sandbox. The core idea is to plan, dispatch and verify real executed work.

## 3. Inherited code: what works and what we keep
Everything below was inherited from ACT III, is disclosed in `REUSE-LEDGER.md`, and is covered by the 242/155 unit tests.

| Keep and adapt | Why |
|---|---|
| `apps/api/src/provider/openai-compatible-client.ts`, `errors.ts`, `response-cleanup.ts` | Generic OpenAI-compatible client with timeout, retries, pacing, size cap and secret redaction. It points at `https://api.vultrinference.com/v1` unchanged. |
| `apps/api/src/money.ts` | Integer minor-unit money. This is the S1/S1B oracle arithmetic. |
| `apps/api/src/state-machine.ts` pattern | Transition table with guards. It will be rewritten for run states. |
| `apps/api/src/policy-engine.ts`, `limits.ts`, `evidence.ts`, `contracts.ts` (zod) | Patterns for deterministic policy, limits and an evidence chain. They are refund-specific and will be replaced with browser-action equivalents. |
| `apps/web` shell: layout, `ui` components, design tokens, routing, test harness | The UI shell. Tokens will be re-themed to Work's navy, graphite and amber. |

| Remove at kickoff (refund-specific) | |
|---|---|
| `case-engine`, `fixtures`, `demo-store`, `request-understanding`, `intent-cues`, `ai-mode`, `team/`, `ingress`, `serverless`, `gateway` | Also the refund, AMD and stress-lab web pages, plus `data/` and `evals/`. Their tests go too. The ledger records the removal, and the inherited test count will drop. |

## 4. What does not exist yet (ProofOps-specific)
- **Infrastructure:** no Vultr VM, no deployment, no public HTTPS.
- **Inference:** no Vultr inference adapter configured, no model verified with `GET /v1/models`, no tool-calling loop.
- **Browser execution:** no browser worker image, no gVisor runtime, no per-run network, no egress proxy, no worker protocol.
- **Demo targets:** no synthetic storefront (normal, wrong-total, hostile, broken modes), no checkout endpoint gate.
- **Approval and verification:** no approval signer or verifier, no frozen assertion spec, no run store.
- **Output:** no evidence bundle writer, no ProofOps UI pages.

## 5. Reconciliation of the inputs
| Topic | Argon audit | Critique / Work | Decision |
|---|---|---|---|
| Control plane separate from browser worker; no secrets in the worker | CC-01 | Agreed | **Accept.** The inference key and any database URL exist only in the control-plane process. The worker environment holds only a run ID. |
| Isolation | gVisor `runsc --platform=systrap`, with hardened runc as an "instant fallback" | gVisor is a candidate, not a guarantee; no silent downgrade | **Accept gVisor as the target, verified on the VM.** A fallback to runc needs a written note, rerun boundary tests and **owner approval**, and the UI and README must name the runtime actually used. |
| Network | Internal Docker bridge plus a CONNECT proxy and iptables | A bridge alone does not stop peer, host, DNS or direct-socket traffic | **Modified design in §7.** Each run gets its own internal network. The browser proxy is not the only defense: direct paths have no route, and the host firewall drops sandbox traffic to the host. Each path has a test. |
| Tools | 7 typed tools with `strict: true` | Add stale-reference rejection and revalidation at execution; nonce wrappers are not a boundary | **Accept, but narrower: 5 tools** (§8). The model cannot author assertions; Argon's `assert_element_text` is dropped. |
| Approval | Detect consequential elements by selector or keyword | Button text is not enough; enforce at the receiving endpoint; bind and consume once | **Accept the critique** (§9). The storefront checkout endpoint verifies a signed, one-time approval itself. |
| Verification | Deterministic verifier plus a hash chain | Hashes do not prove screenshot truth; corroborate with trusted server state | **Accept the critique** (§10). Assertions are frozen before the run, and the verdict uses the storefront's own server-side cart state as well as worker observations. |
| Database | §6.2 SQL plus 6 checks | The SQL is wrong (PUBLIC, inheritance, CREATE); 6 checks are too few | **Reject §6.2.** Our revision 2 migration (55 checks) stays as an optional, reviewed integration. **The MVP uses SQLite on the VM** (§11). |
| Model catalog and prices | Names specific models and prices | Verify the real account | **Verify at kickoff** with `GET /v1/models`. No model ID is hard-coded until it is seen. |
| Scoring weights, "95/100", disqualification claims | Stated as fact | Not on the official page | **Reject.** Use the four official categories without weights. |
| VM sizing | 3 vCPU / 8 GB as the baseline; a 2-VM split later | These are estimates | **Start with one VM** at the smallest size that passes measured cold-start and memory tests. A split is optional and needs owner approval. |
| Concurrency | `asyncio.Semaphore(3)` | Process-local only | **One control-plane process** holds a global admission limit (default 2 browsers) and a queue. Admission state lives in SQLite, so a restart does not forget running containers. |
| Demo scenarios | B-01 to B-12 | S1, S1B, S2, S2B, S3 with D01–D10 | **Use Work's IDs**, plus the directive's checkout approval scenario as S4 (D01/D05). |

## 6. Architecture (one Vultr VM for the MVP)
```
Judge browser ── HTTPS ──> Caddy (TLS) ──> Control plane (Node 24, uid proofops)
                                            ├─ Vultr Serverless Inference client (key only here)
                                            ├─ Policy engine (deterministic, pre-dispatch)
                                            ├─ Run store (SQLite file, owner proofops, mode 600)
                                            ├─ Worker driver: docker run -i --rm (JSON lines over stdin/stdout)
                                            └─ Evidence writer (bundle per run)
Approval signer (separate process, uid proofops-approver; holds the Ed25519 private key)
Verifier (separate process, uid proofops-verifier; reads storefront trusted state + bundle; signs verdict)
Synthetic storefront (container; holds the approver public key; checkout endpoint enforces approvals)
Per-run network run-<id> (--internal): worker container + storefront alias + deny-and-log egress proxy
```
- **Worker channel:** stdio of `docker run -i`. The worker has **no network path to the control plane, the signer or the verifier**, and the control plane never listens on a sandbox network.
- **Authority split:**
  - The control plane cannot mint approvals; only the signer can.
  - The control plane cannot set PASS; only the verifier signs verdicts.
  - A compromised backend (the risk we flagged before) can still request an approval, but cannot forge the operator's click or the verifier's verdict.
  - Limit: all three run on the same VM, so this is process and user separation, not hardware separation. The README will say so.

## 7. Network boundary, path by path
| Path | Control | How we test it (LOCAL BROWSER and LIVE VULTR SANDBOX tiers) |
|---|---|---|
| Direct sockets to the internet | `--internal` network: no gateway route | Worker runs `fetch()` and a raw TCP connect to a canary host: both fail; the canary's own log shows 0 hits |
| HTTP(S), redirects, subresources, WebSockets | Chromium `--proxy-server` to a deny-and-log proxy. Allowlist by host and port: only the storefront alias. Redirects to other hosts are refused at CONNECT. | Hostile fixture issues a 302 to the canary, an `<img>`, a `fetch()` and a `new WebSocket()` to the canary: the proxy logs each denial, the canary logs 0 hits |
| Service workers | Browser context `serviceWorkers: 'block'`. `page.route` is used only as a secondary log. | Fixture tries to register a service worker: registration fails |
| DNS | Worker started with `--dns 0.0.0.0`; Chromium resolves through the proxy. On an internal network Docker's resolver should not forward external names. **To verify on the VM's Docker version.** | `getent hosts canary.example` inside the worker fails; the canary's DNS log shows nothing |
| UDP / QUIC | `--disable-quic`; no route | UDP send to the canary fails |
| IPv6 | Network created without IPv6; `net.ipv6.conf.all.disable_ipv6=1` in the container | `ip -6 addr` shows nothing global; an IPv6 connect fails |
| Host services | Control plane, signer and verifier bind 127.0.0.1. Host firewall (`INPUT` and `DOCKER-USER`) drops sandbox subnets except storefront and proxy ports. | Worker scans the bridge gateway ports: all closed or dropped |
| Peer containers | One network per run; the storefront and proxy expose only their service ports | Two concurrent runs: each worker cannot reach the other's IP |
| Metadata 169.254.169.254 | No route; proxy denies link-local and private ranges after resolving | Worker request to the metadata IP fails; the proxy logs a denial |

What we will claim: no dispatch and no observed request at these observation points (proxy log, canary log, worker errors). We will not claim proof of zero packets.

## 8. Model tools (strict JSON schema; the only tools exposed)
- **`navigate(path)`:** a relative path on the pinned storefront origin. It rejects schemes, `//`, `..` and encoded variants.
- **`click(ref, epoch)`:** `ref` must come from the latest observation with the same `epoch`. A stale epoch is rejected. The worker re-resolves the element and checks it is still visible and enabled before clicking.
- **`fill(ref, epoch, value)`:** `value` is at most 64 characters. The field must be in the task's fillable set, such as the coupon field.
- **`request_approval(ref, epoch)`:** asks for operator approval of a consequential action. The server builds the payload; the model cannot supply it.
- **`finish(note)`:** ends the agent loop. It **cannot** carry a verdict.

Every tool call is checked by the policy engine **before** it is dispatched. A denied call is recorded as attempted, denied, not dispatched.

Page content reaches the model only as structured observations: URL, a visible-text excerpt and an element list. It is marked as untrusted data. That marking is not treated as a security boundary.

## 9. Approval binding (S4, D01, D05)
- **Token contents:** an Ed25519-signed token binding:
  - `operator`, `workspace`, `run_id`
  - `action` (`checkout.submit`)
  - `payload_sha256`: SHA-256 of a canonical cart (SKU, quantity, coupon, total in cents)
  - `expires_at` (at most 120 s)
  - `nonce`
- **Signing:** the signer signs only after the operator clicks Approve in the UI, which shows the exact cart and total.
- **The storefront `POST /checkout/submit` endpoint verifies** the signature, run, payload hash against its own server-side cart, and expiry. It consumes the nonce once. Otherwise it returns 403 and logs the attempt.
- **Tests:** no token; a token for another run; a changed cart after approval; a replayed token; an expired token; a forged signature. All must be rejected by the endpoint itself, including a direct `curl` that bypasses the browser.

## 10. Verification
- **Assertions are frozen before the run.** The operator picks a fixture, and the spec (expected subtotal 10000, discount 1000, total 9000 cents, checkout reached, zero orders) is hashed into the run record before any model call. The model never sees or edits it.
- **The verifier evaluates five separate outcomes:**
  - **commerce assertions:** expected against both the worker-observed DOM total and the storefront's server-side cart
  - **permission checks:** every dispatched action has an allow decision; no unapproved checkout
  - **network containment:** proxy denials, plus 0 canary hits
  - **evidence integrity:** all screenshots and logs present; hashes match the manifest
  - **cleanup:** container gone, network removed
- **The run verdict** is PASS only if every applicable outcome passes. A missing observation gives INCONCLUSIVE, never PASS.
- **S1B:** the storefront shows and stores 9500. Expected is 9000, so the result is FAIL whatever the model says.
- **Limit:** a fully compromised worker could fake a screenshot. The server-side cart cross-check is what limits this.

## 11. Data storage decision
- **MVP:** SQLite (`node:sqlite`, built into Node 24, no new dependency) in `/var/lib/proofops/` on the VM. Only the control plane can read it; it is never mounted into the worker. Tables follow the revision 2 schema (runs, events, evidence, approvals, audit) without the Postgres role layer.
- **Why:** it avoids the shared ACT III project entirely, including auto-pause, shared admin and Supabase-specific unknowns. The event page is satisfied with all infrastructure on Vultr.
- **The shared Supabase `proofops` migration stays optional.** It needs owner approval and the project unpaused, and it is never on the critical path.

## 12. Run limits (one policy file, enforced by the control plane)
| Limit | Default |
|---|---|
| Agent steps | 12 |
| Wall clock per run | 120 s, enforced with `docker kill` on expiry |
| Single browser action | 15 s |
| Inference | at most 14 calls and 60,000 tokens per run; 2 retries on 429 or 5xx only |
| Worker container | 1 CPU, 1024 MB (no swap), 256 pids, read-only root, tmpfs `/tmp` of 256 MB, `--cap-drop ALL`, `no-new-privileges`, non-root uid 10001, `--shm-size 512m` (no `--ipc=host`) |
| Global admission | 2 concurrent runs, then a queue of 10; public demo rate limit per IP |

- **Idempotency:** run creation takes an `Idempotency-Key`. A duplicate returns the same run.
- **Cleanup:** on every terminal state the control plane removes the container and network and records the result. A reaper at startup and every 30 s removes anything labelled `proofops.run` whose run is terminal or past its deadline.

## 13. Test tiers (counts are always reported per tier)
1. **UNIT:** policy, path validation, approval tokens, oracle math, state machine.
2. **LOCAL BROWSER:** real Chromium against the local storefront, no model.
3. **LOCAL MODEL STUB:** a scripted model, labelled as such.
4. **LIVE VULTR MODEL:** real inference calls.
5. **LIVE VULTR SANDBOX:** a real worker on the VM.
6. **PUBLIC DEPLOYMENT:** signed-out HTTPS.

Inherited ACT III unit tests are reported separately until removed.

## 14. Backlog (single source; status values follow Work's scorecard)
| ID | Item | Gate | Pri | Status |
|---|---|---|---|---|
| K0 | Kickoff check: confirm start; owner provisions the Vultr account, credit, API key and VM | — | P0 | blocked: kickoff + owner |
| K1 | VM bootstrap: Ubuntu LTS, Docker, gVisor `runsc`, firewall, Caddy, uid split; measure Chromium under runsc | D03, D06 | P0 | not implemented |
| K2 | Inference adapter: list models, pick a tool-capable model, one recorded live call (model ID, request ID, tokens) | D02 | P0 | not implemented |
| K3 | Synthetic storefront: fixture modes normal, wrong-total, hostile, broken; server-side cart; checkout endpoint with approval verification | D03, D04, S4 | P0 | not implemented |
| K4 | Worker image (pinned Playwright and Chromium versions) and stdio protocol with observation epochs | D03 | P0 | not implemented |
| K5 | Per-run network and deny-and-log proxy; canary destination | D06 | P0 | not implemented |
| K6 | Policy engine for the 5 tools; attempted, denied, not-dispatched records | D01, D05 | P0 | not implemented |
| K7 | Run lifecycle: state machine, limits, timeout, cancel, reaper, idempotency, SQLite store | D07, D08 | P0 | not implemented |
| K8 | **Day 1 vertical slice:** live model → typed proposal → policy → worker click → screenshot → frozen assertion → teardown, run ID in logs | Day 1 gate | P0 | not implemented |
| K9 | Approval signer and verifier processes; verdict signature | D01, D04 | P0 | not implemented |
| K10 | Evidence bundle in Work's layout (manifest, request, plan, approval, events, assertions, policy decisions, screenshots, cleanup, report) | D09 | P0 | not implemented |
| K11 | Boundary test suite for every path in §7 (S2B) | D06 | P0 | not implemented |
| K12 | UI: scenario picker, scope and approval, live timeline (SSE with reconnect), screenshots, separate commerce, policy, containment and cleanup panels, report | D10 | P0 | not implemented |
| K13 | Public HTTPS deployment with rate limits; signed-out check | Submission | P0 | not implemented |
| K14 | 5 fresh clean runs plus S1B, S2 and S3, with all outcomes kept | Scorecard | P1 | not implemented |
| K15 | Responsive and keyboard QA; report export | D10 | P1 | not implemented |
| K16 | Remove refund-specific inherited code; update the ledger | Originality | P1 | not implemented |
| K17 | README architecture, setup and limits; make the repo public (owner) | Submission | P0 | not implemented |
| DB-opt | Shared Supabase `proofops` integration | — | Optional | blocked: owner approval |

**Day plan, all times UTC:**
- **3 Nov:** K0 to K2 and K4, then K8 by end of day.
- **4 Nov:** K3, K5, K6 and K7.
- **5 Nov:** K9 to K11.
- **6 Nov:** K12 and K13.
- **7 Nov:** K14 to K16, then a recording session for Work.
- **8 Nov:** K17, a regression run, **freeze at 18:00**, and owner submission well before the close.

## 15. Owner checklist (only what engineering cannot do)
1. **Before 16:00 UTC on 3 Nov:**
   - Confirm the Vultr account has the hackathon credit.
   - Create a Serverless Inference subscription and API key.
   - Do **not** paste the key in chat. I will prompt for it on the VM with a hidden input, or you can put it in `/etc/proofops/env` yourself.
2. **Approve one VM:** region, plan and estimated cost. I will propose the smallest plan that passes the memory test. No billable resource is created without this approval.
3. **Give me an SSH public key** for the VM, or let me generate a dedicated key locally. The private key never leaves your PC.
4. **Hostname:** decide whether to use a free `<ip>.sslip.io` name or your own domain for HTTPS.
5. **Organizer questions:** ask about reuse of your own earlier code, and confirm the deadline time (event page shows 23:00 UTC; our docs say 22:00 UTC).
6. **Release:** at release time, make the repo public yourself.
