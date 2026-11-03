# Day 1 runbook: first permitted Vultr session

Nothing here runs until the official start, a $200 credit-only balance, and the owner's explicit VM approval.

## 0. Gates (owner)
1. The Billing page shows $200.00 Remaining Credit. No card, PayPal or deposit was requested.
2. The organizers confirm Serverless Inference is covered, or the Billing page shows inference charges drawn from credit after one tiny test.
3. The owner writes "approve VM vhp-4c-8gb-amd sjc".

## 1. Provision (owner, in the Vultr console)
- Deploy → Cloud Compute → **High Performance, AMD** → `vhp-4c-8gb-amd` (4 vCPU, 8 GB) → Silicon Valley → **Ubuntu 24.04 x64**.
- Check the hourly price shown matches $0.066/hr.
- SSH key: tick only **JARVIS-ProofOps-Vultr**.
- Leave **Auto Backups off**, **IPv6 off**, no VPC, no DDoS protection, no extra block storage.
- Hostname: `proofops-1`. Send me the public IPv4.

## 2. Verify the host key before trusting it
1. In the console, open View Console and log in with the emailed root password.
2. Run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` and send me the `SHA256:…` value.
3. On the PC I run:
   - `ssh -i ~/.ssh/proofops_vultr_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=ask root@<ip> true`
   - I accept only if the fingerprint matches. Every later step uses `StrictHostKeyChecking=yes`.

## 3. Bootstrap (Claude)
- `scp ops/vm-bootstrap.sh root@<ip>:/root/`
- `ssh root@<ip> bash /root/vm-bootstrap.sh | tee bootstrap.log`
- **Pass means all of these:** Ubuntu 24.04; Docker running with a `runsc` runtime; `hello-world` runs under runsc; password login off; ufw allows only 22, 80 and 443.

## 4. Chromium under gVisor smoke test (Claude)
- Pin the Node Playwright image tag that matches the project's `playwright` npm version, e.g. `mcr.microsoft.com/playwright:v1.X.Y-noble`. Stack stays Node/TypeScript throughout: no Python.
- Run headless Chromium inside it with:
  ```
  --runtime=runsc --network=none --user pwuser --read-only --tmpfs /tmp:rw,nosuid,size=256m
  --cap-drop=ALL --security-opt no-new-privileges --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 --shm-size=512m
  ```
- Render a `data:` page and save a screenshot to stdout.
- Record: wall time cold and warm, peak memory (`docker stats --no-stream`), and the output of `docker inspect` for runtime, network mode, user, capabilities and environment.
- **Concurrency:** start with **1** worker. Raise to 2 only after measuring that the host keeps at least 1.5 GB free and CPU stays usable with two running.

## 4b. Storefront connection through a Unix socket: must be proven, not assumed
Chromium cannot use a Unix-socket proxy directly, so the path is:
- **Inside the worker:** a ~30-line Node TCP-to-UDS bridge on `127.0.0.1:3128`. Chromium is started with `--proxy-server=http://127.0.0.1:3128`.
- **The socket:** `/run/proofops/<run-id>/gw.sock`, created per run, mode 0600, owned by the worker uid. Only that one directory is bind-mounted into that one worker. runsc needs `--host-uds=open`, which allows connecting to host sockets but not creating them; test it, and narrow it further if runsc allows.
- **On the host:** a Node **restricted HTTP gateway**, not a byte relay.
  - It accepts only absolute-form `http://store.proofops.test/...` requests with methods GET, HEAD and POST.
  - It rejects CONNECT, any `Upgrade` or WebSocket request, any other authority or port, and malformed or oversized requests.
  - It ignores the request's Host header for routing. The upstream is fixed to the storefront at 127.0.0.1:<port>, so a forged authority cannot redirect it.
  - Every allowed and denied request is logged with the run ID.

**Tests on the VM (each recorded):**
- the storefront loads through the bridge
- `fetch('http://example.com')`, a 302 to another host, a WebSocket and a CONNECT are all denied at the gateway
- a raw TCP connect, a DNS lookup and 169.254.169.254 all fail inside the worker because there is no interface
- a second run's socket is not visible from the first worker

If runsc cannot connect to the bind-mounted socket, stop and report. Do not switch the network on to make it work.

## 5. gVisor fallback decision tree
| Result | Action |
|---|---|
| Chromium runs under runsc with its own sandbox | Use it. Best case. |
| Runs under runsc only with `--no-sandbox` | Usable, but it is a **documented tradeoff**: gVisor stays the outer boundary and Chromium's inner sandbox is off. Shown in the README, the UI run details and the video, never left as a hidden default. |
| Fails under systrap | Try `--platform=ptrace` once (slower). Record the timing. |
| Still fails | **Stop.** Report to the owner. The fallback is runc with Docker's default seccomp and Chromium's own sandbox on. It is materially weaker. It needs the owner's written approval, the full boundary test suite rerun, and "runc" shown in the UI, README and video. |

## 6. Inference key and check
1. **Owner:** `powershell -ExecutionPolicy Bypass -File ops\set-inference-key.ps1 -VmHost <ip>`.
2. **Claude:** `sudo -u proofops node ops/inference-smoke.mjs` lists models (a public route: it does **not** prove the key works). Pick a model that supports tool calling, ideally with vision.
3. **Claude:** `sudo -u proofops node ops/inference-smoke.mjs <model-id>` makes one 16-token call.
   - **Pass:** HTTP 200, `responseModel` present, usage recorded.
   - A 401, 403 or 429 is reported as-is.
4. **Owner:** recheck the Billing balance.

## 7. First vertical slice: acceptance
**Run ID and code SHA in every record.**
- **Live model:** the Vultr model returns a typed tool call, e.g. `click(ref, epoch)` on the "Apply coupon" button. The raw response is recorded with the model ID and request ID.
- **Policy:** the policy engine allows it before dispatch. A forced out-of-scope `navigate` in the same run is denied and not dispatched.
- **Worker:** a fresh runsc worker (network none, no env secrets, non-root, read-only, limits) performs the click on the synthetic storefront.
- **Screenshot:** a real PNG is saved, with its SHA-256 in the manifest.
- **Assertion:** the frozen assertion (expected total 9000 cents) is evaluated against the worker's DOM observation and the storefront's server-side cart. The result is PASS or FAIL, never set by the model.
- **Teardown:** `docker ps -a --filter label=proofops.run=<id>` is empty and the proxy socket is removed. The cleanup record is written.
- **Evidence:** `evidence/<run-id>/` contains the manifest, the request, the model response, policy decisions, events, the screenshot, assertions and the cleanup record.

Local runs with a stub model are labelled `LOCAL MODEL STUB` and never count toward this.

## 8. After the first slice
- **Status of Argon's SG-01 to SG-12:** these are test specifications, and each is marked not run, passed or failed with its artifact. Planned tests:
  - direct network escape
  - metadata address
  - unauthorized checkout, endpoint-enforced
  - approval replay
  - changed approval payload
  - timeout and cancel teardown
  - cross-run isolation
  - stale element reference
  - SQLite crash recovery (WAL mode, bounded writes, unfinished runs marked failed at startup)
- **Two kinds of hostile test, always labelled separately:**
  - **Forced malicious tool proposal:** a harness injects the bad call to prove the policy denies it.
  - **Live-model prompt injection:** a hostile page is shown to the real model, and we record whether it actually proposed the bad action.
- **No timing or isolation claims until measured.**

## 9. Exact sequence once the host key is verified (current code)
1. `ssh-keygen -lf` value from the Vultr console equals `SHA256:beVxH5zsv0QGKziyo2zTcRhGnqMfpjrNXUYZpsiaMbg`. Only then add the host to known_hosts.
2. From the PC: `git bundle create proofops.bundle main`; `scp` it and `ops/vm-bootstrap.sh` to the VM.
3. VM: `bash vm-bootstrap.sh`; then `git clone proofops.bundle /opt/proofops/app && chown -R proofops: /opt/proofops`.
4. VM: `sudo -u proofops bash -c 'cd /opt/proofops/app && npm ci && (cd apps/proofops/worker && npm ci)'`; `docker build -t proofops-worker:1.64.1 apps/proofops/worker`.
5. **gVisor gate:** `sudo -u proofops node apps/proofops/src/vm-boundary.ts --out /var/lib/proofops/vm-boundary.json`. All checks must pass (runtime observed by Docker as `runsc`, gVisor in the guest kernel log, network none, no host secrets, gateway refusals). On any failure, stop and keep the report.
6. **Sandboxed missions, still with the scripted planner:** start `node apps/proofops/src/server.ts --sandbox --port 4317` and run `node apps/proofops/src/smoke.ts`. Tier recorded: `LIVE_VULTR_SANDBOX`, planner stub.
7. Owner installs the inference key (`ops/set-inference-key.ps1`), after approving the subscription.
8. `sudo -u proofops node ops/inference-smoke.mjs deepseek-v4.1-flash-1017`: one 16-token call; must return HTTP 200 and a response model.
9. `ops/deploy-app.sh <sha> deepseek-v4.1-flash-1017 vultr:<instance-id> 45-63-82-115.sslip.io`, then run one live-model mission per scenario from the console.
