# Failure recovery

Run commands as root on the VM: `bash /opt/proofops/app/ops/operator.sh <command>`. Start with `status`.

**The system fails closed.** It never switches between live and scripted by itself. If the model is unavailable, missions fail and say why. Falling back to the scripted demo is a deliberate operator command, and the page header then says "no live AI".

| Failure | What the system does | What you do | How this was checked |
|---|---|---|---|
| Provider 401 (key rejected) | Mission stops after 3 unusable replies: status `failed`, verdict FAIL, worker destroyed, no fallback | Run `key-check`. If rejected, rotate the key in the Vultr console and reinstall it with `ops/set-inference-key.ps1`, then `restart` | On the VM with a made-up key |
| Provider 429 or 5xx | At most 2 retries per call with backoff, then the same stop after 3 unusable replies | Wait, then try one mission. If it continues, use the scripted fallback and say so | Against a local mock only |
| Model timeout | 30 seconds per attempt, retried within the same limits, inside the mission's wall clock (25 to 180 seconds) | As for 429 | Against a local mock only |
| VM restart | `docker`, `proofops` and `caddy` start at boot. A mission that was running is recorded as `failed` | Run `status`, then one mission | Real reboot on the VM |
| Caddy restart | The public site returns within seconds, and a running mission is not affected | `restart` if it stays down | Real restart on the VM |
| Control plane killed mid-mission | The worker exits when its control channel closes. The restart records the run as `failed`, and its bundle reads INCOMPLETE | `status`, then `clear-workers` if any worker remains | SIGTERM and SIGKILL on the VM |
| gVisor or worker image missing at start | The service refuses to start and never runs without the sandbox | `journalctl -u proofops -n 30 --no-pager`, then rerun `ops/vm-bootstrap.sh` or `ops/deploy-app.sh` | Missing image on the VM. Missing `runsc` by automated test only |
| Docker reports a different runtime for a worker | The run stops before any browser work | As above | Automated test only |
| Key file missing at start | The service refuses to start, with no fallback | Reinstall the key, then `restart` | On the VM |
| Worker or page hangs | Hard stop at the wall clock, worker destroyed, verdict FAIL, shown as a LIMIT row | Nothing | Hung-page mission on the VM |
| Evidence missing or changed | `verify-evidence` reports INCOMPLETE or TAMPERED, never PASS | Don't use that run. Run the mission again | Automated tests with real bundles |
| Daily mission cap reached | New missions answer HTTP 429, and the page says to try again tomorrow. This survives a restart | Wait, since the 24 hours roll forward. Or `set-daily-limit <n>`, which raises the most the demo can spend | On the VM with a cap of 1 |
| One visitor holds the mission slot | Others get "Another mission is still running". An unanswered approval times out after 2 minutes, and a mission ends within 3 minutes at most | Wait, or `restart`, which ends the mission | Automated tests, plus a concurrent start on the public demo |
| Open page after a restart | That page can stay on "Reconnecting…" | Reload the page | Read from the code, not tested |

## Scripted fallback
Use this only if the provider is down during a live demonstration.
```
bash /opt/proofops/app/ops/operator.sh scripted --confirm
```
The header then reads "Model: scripted planner (no live AI)" and new runs are labelled `VULTR_GVISOR_SCRIPTED`. Say so out loud, and don't present those runs as live-model evidence. To go back:
```
bash /opt/proofops/app/ops/operator.sh live
```

## Rollback
Release commits are tagged in the repository, and `git tag` lists them on the PC. The VM has no tags, but it has the commits, because it receives the full history of `main`.
```
bash /opt/proofops/app/ops/operator.sh rollback <sha>
```
To put a commit from the PC on the VM first, bundle it and fetch it as in [DAY1-RUNBOOK.md](DAY1-RUNBOOK.md).

No VM snapshot exists, because snapshots can cost money. If the VM itself is lost, it needs a new VM, `ops/vm-bootstrap.sh`, and a redeploy from Git. Run evidence not yet copied into `proof/` would be lost.
