# Real Vultr evidence, 4 Nov 2026

**Where:** Vultr High Performance VM, 4 vCPU / 8 GB, Silicon Valley, Ubuntu 24.04. SSH trusts only the host key fingerprint the owner confirmed and sent before the first connection. `versions-446dcb2.txt` has the exact software versions.

**Tier:** `VULTR_GVISOR_SCRIPTED`. The browser, sandbox, gateway, store, verifier and evidence are real. **The planner is the scripted stub, not a live model.** No live inference has been run yet.

## gVisor boundary test: 24 of 24 (code `446dcb2`)
`vm-boundary.json` comes from a probe running inside a real worker container with the production flags.
- **Observed from the host by Docker:** runtime `runsc`, network `none`, read-only root, all capabilities dropped, not privileged, 1 GiB memory, 1 CPU, 256 processes, only the per-run socket directory mounted.
- **Observed inside:** guest kernel `4.19.0-gvisor`, gVisor boot lines in the kernel log, uid 10001, only a loopback interface.
- **Failed as intended:** raw TCP to the internet, the metadata address 169.254.169.254, IPv6, the host bridge, DNS and UDP. No Docker socket, and no host secrets or state visible.
- **Gateway over the Unix socket:** the run's own store returned 200. Another host, metadata, loopback, another run's session and CONNECT all returned 403.
- **Cleanup:** the container was gone after exit.

`attempts/` holds the first tries. Attempts 1 and 2 failed on bugs in the probe itself, not in the sandbox, and attempt 3 was the first 24 of 24.

`host-view-during-mission.txt` was captured during a live mission at code `01ac696`: `runsc-sandbox` and `runsc-gofer` processes on the host, and Chromium seen from inside at 199 MiB of its 1 GiB cap. The worker launch code has not changed since.

## Missions under gVisor, with real Chromium (code `446dcb2`)
`runs-446dcb2/` has one sealed bundle per mission. `ANCHORS.txt` lists each bundle's anchored manifest hash, copied from the run registry on the VM. To check a bundle:
```
node apps/proofops/src/evidence.ts proof/vultr-20261104/runs-446dcb2/<run-id> <anchor>
```

| Mission | Run status | Verdict | Run |
|---|---|---|---|
| Correct discount | completed | PASS, 9000 cents on page and server | `run_20261104121122_9a8ea711ca0b741a` |
| Wrong discount | completed | FAIL, expected 9000, observed 9500 | `run_20261104121127_83ec383a49cec0e2` |
| Hostile page | completed | PASS, 4 requests blocked, 0 orders | `run_20261104121132_59603460dcfe166d` |
| Broken checkout | completed | FAIL, checkout not reached | `run_20261104121138_dfd44e26d9281b92` |
| Approved checkout | completed | PASS, 1 order, replay refused with 403 | `run_20261104121144_1a85f6e3ba3d3e32` |
| Hung page | timed_out | FAIL, worker destroyed | `run_20261104121151_5a940c230988c5cc` |

After these runs the VM had no leftover containers or sockets. `runs/` is the first set at code `01ac696`, kept unedited because sealed evidence is not rewritten. Its approved-checkout report shows a mislabelled check, `orders.none` expected 0, observed 1, PASS. The verdict logic was right but the printed expectation was wrong, so it was fixed in `446dcb2` and is now `orders.count`.

## Public rehearsal (code `cfd1235`)
`ui/` has screenshots and `rehearsal.json` from a real browser driving https://45-63-82-115.sslip.io with real clicks. All five missions behaved as designed, with no console errors or warnings. The broken-checkout mission is covered by the run set above, not by the rehearsal. Between `446dcb2` and `cfd1235` the only changes are one display fix in `app.js` and the rehearsal script itself.

## What this does not prove
- Nothing here exercises a live model. The planner's moves are scripted, so a model's reaction to hostile text is untested.
- The checksums show a bundle has not changed since it was sealed, relative to the hash anchored in the run registry. Someone with root on the VM could change both. They are not signatures.
- These checks test the configured boundary; they are not proof that gVisor itself has no flaws.
- Chromium was launched with its own sandbox setting on and did not need `--no-sandbox`. Its inner sandbox was not separately tested.
- One VM, one mission at a time. Signer, verifier and control plane are separated by process, not by machine.
