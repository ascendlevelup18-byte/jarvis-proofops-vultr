# Real Vultr evidence, 4 Nov 2026

**Where:** Vultr High Performance VM, 4 vCPU / 8 GB, Silicon Valley, Ubuntu 24.04. Host identity was pinned to the fingerprint the owner supplied from the Vultr console before the first connection.

**Tier:** `VULTR_GVISOR_SCRIPTED`. The browser, sandbox, gateway, store, verifier and evidence are real. **The planner is the scripted stub, not a live model.** No live inference has been run yet.

## gVisor boundary test: 24 of 24
`vm-boundary.json` is from a probe running inside a real worker container with the production flags.
- **Observed from the host by Docker:** runtime `runsc`, network `none`, read-only root, all capabilities dropped, not privileged, 1 GiB memory, 1 CPU, 256 processes, only the per-run socket directory mounted.
- **Observed inside:** guest kernel `4.19.0-gvisor`, gVisor boot lines in the kernel log, uid 10001, only a loopback interface.
- **Failed as intended:** raw TCP to the internet, the metadata address 169.254.169.254, IPv6, the host bridge, DNS and UDP. No Docker socket, and no host secrets or state visible.
- **Gateway over the Unix socket:** the run's own store returned 200. Another host, metadata, loopback, another run's session and CONNECT all returned 403.
- **Cleanup:** the container was gone after exit.

`attempts/` holds the two earlier tries that failed on bugs in the probe itself, not in the sandbox. Both bugs are fixed in the commit history.

`host-view-during-mission.txt` is captured during a live mission: `runsc-sandbox` and `runsc-gofer` processes on the host, and Chromium seen from inside at 199 MiB of its 1 GiB cap.

## Missions under gVisor, with real Chromium
`runs/` has one sealed bundle per mission. Check one with `node apps/proofops/src/evidence.ts proof/vultr-20261104/runs/<run-id>`.

| Mission | Run status | Verdict | Run |
|---|---|---|---|
| Correct discount | completed | PASS, $90.00 on page and server | `run_20261104114219_402f090f15793be5` |
| Wrong discount | completed | FAIL, expected $90.00, observed $95.00 | `run_20261104114224_a6850ca007b9fea1` |
| Hostile page | completed | PASS, 4 requests blocked, 0 orders | `run_20261104114229_0c4a417bf4b7fd09` |
| Broken checkout | completed | FAIL, checkout not reached | `run_20261104114235_52238049431230d6` |
| Approved checkout | completed | PASS, 1 order, replay refused with 403 | `run_20261104114240_a92ed23f15a86f4a` |
| Hung page | timed_out | FAIL, worker destroyed | `run_20261104114246_3d467e08b555ff4c` |

## Public rehearsal
`ui/` has screenshots and `rehearsal.json` from a real browser driving https://45-63-82-115.sslip.io with real clicks: 5 of 5 missions as designed, no console errors or warnings.

## What this does not prove
- Nothing here exercises a live model. The planner's moves are scripted, so a model's reaction to hostile text is untested.
- The checksums show a bundle has not changed since it was sealed, relative to the hash anchored in the run registry. Someone with root on the VM could change both. They are not signatures.
- These checks test the configured boundary; they are not proof that gVisor itself has no flaws.
- Chromium was launched with its own sandbox setting on and did not need `--no-sandbox`. Its inner sandbox was not separately tested.
- One VM, one mission at a time. Signer, verifier and control plane are separated by process, not by machine.
