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
- Pin the Playwright image tag that matches the `playwright` npm version chosen at kickoff, e.g. `mcr.microsoft.com/playwright:v1.X.Y-noble`.
- Run headless Chromium inside it with:
  ```
  --runtime=runsc --network=none --user pwuser --read-only --tmpfs /tmp:rw,nosuid,size=256m
  --cap-drop=ALL --security-opt no-new-privileges --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 --shm-size=512m
  ```
- Render a `data:` page and save a screenshot to stdout.
- Record: wall time cold and warm, peak memory (`docker stats --no-stream`), and the output of `docker inspect` for runtime, network mode, user, capabilities and environment.
- **Concurrency:** measure 2 browsers at once. Allow 2 only if the host keeps at least 1.5 GB free.

## 5. gVisor fallback decision tree
| Result | Action |
|---|---|
| Chromium runs under runsc with its own sandbox | Use it. Best case. |
| Runs under runsc only with `--no-sandbox` | Use it. gVisor is the outer boundary. Disclose the Chromium sandbox as disabled in the README and the UI. |
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
