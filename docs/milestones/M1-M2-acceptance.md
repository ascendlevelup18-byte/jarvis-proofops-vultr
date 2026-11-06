# Milestones 1 and 2: acceptance

**Local** means run on the owner's PC with the scripted planner and no gVisor. Nothing here has run on Vultr or with a live model.

## Milestone 1: foundation
- [x] Isolated copy with push disabled, branch `feature/proofops-2-platform`, base `d6ebad8`
- [x] `main` and tags unchanged
- [x] Baseline on merged `8e1d353` (Local): typecheck clean, 87/87, 52/52, 6/6, 4 VM checks not run
- [x] Security boundary files unchanged from the release, checked with `git diff d14d24c`
- [x] No model, production or paid call made

## Milestone 2: Mission Control
- [x] Verdict visible at completion, with distinct outcome classes. Evidence failure never reads as Intact
- [x] Finished runs reopen from sealed evidence, with missing fields stated
- [x] Read-only comparison of two finished runs
- [x] Run mission above the fold at common sizes
- [x] Chromium checks at 375, 768, 1366 and 1440 px wide, with keyboard, reduced motion and console-error checks
- [ ] Manual review with a screen reader
- [ ] VM boundary and live-model tiers, which need an approved separate environment
