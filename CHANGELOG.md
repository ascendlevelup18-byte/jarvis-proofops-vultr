# Changelog

Dates are 2026. Commits in Git are the complete record.

## Documentation after the release (no application code)
Commits after `d14d24c` on `main` change documentation, evidence, project metadata and `proof/verify-all.mjs`. Production stays on `d14d24c`.
- Committed 124 run logs and `bootstrap.log` that `.gitignore` had excluded, so bundles verify from a clean clone (`35e201d`, tag `evidence-20261105`). Before that commit, a clone showed bundles as TAMPERED because files were absent.
- README rewritten for review, with `SECURITY.md`, fact sheet, this file and an explicit reuse classification.

## release-20261104 (`d14d24c`), 4 Nov: the competition release
First release deployed publicly with the real model.
- Live planner on Vultr Serverless Inference, `deepseek-v4.1-flash-1017`. Limits model reasoning and asks for JSON.
- Evidence check waits for Docker to finish removing a container, after one run reported "teardown not proven".
- Order check reports the frozen expectation (it printed "expected 0, observed 1") and is now `orders.count`.
- A hard stop no longer counts as a blocked attempt.
- UI: labels don't blink out; a slow approval response can't return a finished run to "Running"; screenshot captions change with the picture; the planner is named honestly when scripted.
- Local rate-limit default fixed, as the README quick-start failed on it.
- Added `ops/operator.sh` and `ops/RECOVERY.md`.

## Earlier work
- **4 Nov:** deployed to the Vultr VM under gVisor with a scripted planner; 24-point boundary probe; public HTTPS.
- **3 Nov, after kickoff:** first commit of ProofOps application code (`61784cc`, 16:09 UTC) through hardening sprints. Each defect found has a regression test.
- **2 to 3 Nov, before kickoff:** disclosed import from JARVIS ACT III, preparation documents and deployment scripts. See [REUSE-LEDGER.md](REUSE-LEDGER.md).

## Known open items
See [Known limitations](README.md#threat-model-and-limitations). Held until after submission: UI fixes on `review/work-upgrade-patch`, and the `zod` upgrade.
