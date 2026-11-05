# Reuse ledger: what ProofOps inherited from JARVIS ACT III

## Current tree: inherited and new
| Status | Files | Notes |
|---|---|---|
| **Inherited from ACT III, in use** | `apps/api/src/provider/` (4 files), `apps/api/test/openai-compatible-client.test.ts`, `apps/api/test/fake-openai-server.ts` | OpenAI-compatible client, error types, response clean-up, and their test |
| **Inherited scaffold, edited** | `package.json`, `package-lock.json`, `.gitignore`, `.env.example` | Project configuration, since rewritten for ProofOps |
| **New for ProofOps** | `apps/proofops/` (control plane, policy, gateway, worker, signer, storefront, verifier, evidence, UI, tests), `ops/`, `proof/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md` | Written for this project. Git history shows when |
| **In Git history only** | ACT III refund engine, web app, data, results and reference documents | Removed from the tree on 4 Nov 2026, not from history |

**By size at `d14d24c`:** inherited code is 1,256 lines. ProofOps source, UI and worker are about 3,670 lines, tests about 1,580, and operations about 520. Line counts show scale, not value.

**Timing:** kickoff was 3 Nov 16:00 UTC. The first commit containing ProofOps application code is `61784cc`, 16:09 UTC that day. Commit times show when work was committed, not when it was written, and that commit is too large to have been written in nine minutes, so it should not be read as proof of when the code was authored. Before kickoff, 12 commits made the disclosed import, preparation documents and deployment scripts in `ops/`.

ACT III's design and documentation were available while ProofOps was designed, and were kept as reference until 4 Nov. So "new" means newly written code, not that no earlier ideas informed it. **This is not a clean-room implementation. No organizer ruling on this reuse has been confirmed.** Some ProofOps work predates the event's kickoff, so dates in Git history should be read as they stand, without assuming all of it was done during the event.

## At the time of copying

Copied on 2 Nov 2026 from the owner's own repository https://github.com/ascendlevelup18-byte/jarvisACTIII (same author, ASCEND Revolution), using `git archive` so only committed files came across: no `.env`, `.vercel/`, deployment tokens, logs, user data or build output.

- `apps/`, `data/`, `evals/results/`, `package*.json`: ACT III commit `c69ca2c` (tag `championship-release-20261018`).
- `reference/act3/`: ACT III commit `59823d7` (documentation and Supabase patterns, reference only, not built or deployed).

**Everything listed here is pre-existing work.** Later commits must be classified individually: pre-kickoff preparation is not functionality developed during the event. The imported foundation is commit `a6ac809`; the preceding `ac9b087` is an initial repository commit. At audited commit `7dcfe62`, application, dataset and historical evidence files have no Git changes relative to `a6ac809`. New commits so far add preparation, database drafts/local checks and operations tooling, not the ProofOps execution engine. Commit timestamps alone do not establish when functionality was developed or organizer permission. At kickoff the refund-specific parts (case engine, refund policy, AMD evidence, AI Executive Team) are removed or replaced. The generic parts (UI shell, design tokens, validation, policy/audit/verification patterns, test harness) are the intended reuse. The reuse is disclosed and is checked against the organizer's originality rule before any derivative competition functionality is submitted.

| Area | Files | Intended use in ProofOps |
|---|---:|---|
| `apps/api` | 53 | API server, zod contracts, provider adapter, policy/audit/verification patterns, tests (refund engine to be removed) |
| `apps/web` | 137 | UI shell, design system, components, browser test harness (refund pages to be removed) |
| `data/cases` | 1 | ACT III synthetic dataset (kept only so inherited tests run; to be removed) |
| `evals/results` | 20 | ACT III evidence (kept only so inherited tests run; to be removed; not ProofOps evidence) |
| `package-lock.json` | 1 | Workspace manifest (renamed to jarvis-proofops-vultr) |
| `package.json` | 1 | Workspace manifest (renamed to jarvis-proofops-vultr) |
| `reference/act3/docs/TECHNICAL_REFERENCE.md` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/docs/cloud` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/docs/competition` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/supabase/functions` | 3 | Reference only: schema, RLS and gateway patterns for the proofops schema |
| `reference/act3/supabase/migrations` | 3 | Reference only: schema, RLS and gateway patterns for the proofops schema |
| `reference/act3/supabase/rollback` | 1 | Reference only: schema, RLS and gateway patterns for the proofops schema |
| `reference/act3/supabase/tests` | 1 | Reference only: schema, RLS and gateway patterns for the proofops schema |
| `reference/act3/tests-for-act3-deploy-targets/cloud-gateway.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-deploy-targets/demo-store.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-deploy-targets/ingress-e2e.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/ai-startup.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/baseline-no-policy.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/benchmark.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/demo-verifier.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/deploy-config.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/scripts.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/tokenfactory-smoke-mocked.test.ts` | 1 | Reference only: architecture and threat-model patterns |
| `reference/act3/tests-for-act3-tooling/vllm-benchmark.test.ts` | 1 | Reference only: architecture and threat-model patterns |

## Files and SHA-256 (first 16 hex) at copy time

- `apps/api/.env.example` 94f63194793cc233
- `apps/api/README.md` 58d17e2f6256c921
- `apps/api/eval/baseline-no-policy.ts` 9edda1a5f0d70ade
- `apps/api/eval/dataset.ts` fbec4e9017559145
- `apps/api/eval/metrics.ts` 6dd2e9cd400d7680
- `apps/api/eval/run-benchmark.ts` ca5e6dcee1e0b27a
- `apps/api/eval/runner.ts` ee6b8bc313b085e6
- `apps/api/eval/vllm-benchmark.ts` cc74ad021c208e1f
- `apps/api/src/ai-config.ts` da32a326cc02e5fb
- `apps/api/src/ai-mode.ts` fd3f3a367a3d210e
- `apps/api/src/case-engine.ts` 896b6a8325b14498
- `apps/api/src/contracts.ts` 7de209cb71d9f4ce
- `apps/api/src/demo-store.ts` 22c3caa28c486962
- `apps/api/src/evidence.ts` a30cdd8e25d9b3bf
- `apps/api/src/fixtures.ts` 8b67d761e401e5ab
- `apps/api/src/gateway.ts` 52fee2293606c6b2
- `apps/api/src/ingress.ts` ca76fdbc2a1a3196
- `apps/api/src/intent-cues.ts` 9193e9bed5177606
- `apps/api/src/limits.ts` b52507ff024efe54
- `apps/api/src/main.ts` b2f427ca7f2c87d0
- `apps/api/src/model-adapter.ts` c3ac08631fb3c672
- `apps/api/src/money.ts` 456db6164a42d99f
- `apps/api/src/policy-engine.ts` 4953642205093591
- `apps/api/src/provider/errors.ts` 3e0403d772e5dcf4
- `apps/api/src/provider/index.ts` 456093e81f796e30
- `apps/api/src/provider/openai-compatible-client.ts` 48f78c45e52747ab
- `apps/api/src/provider/response-cleanup.ts` 066c1103ae8761aa
- `apps/api/src/request-understanding.ts` d7d4ea1a2701d3bc
- `apps/api/src/server.ts` 309c808b7306e05f
- `apps/api/src/serverless.ts` 1b00dc5d545a9939
- `apps/api/src/state-machine.ts` f2724d0350a3b8fb
- `apps/api/src/team/openrouter.ts` 28c2239b75d96b12
- `apps/api/src/team/routes.ts` 6133f24525402545
- `apps/api/test/ai-config.test.ts` 32f4b2098d4b7bff
- `apps/api/test/case-engine.test.ts` 58593632fce456eb
- `apps/api/test/engine-hardening.test.ts` bac4ddcfd6568da1
- `apps/api/test/fake-jarvis-model.ts` e65bafc91a8cab52
- `apps/api/test/fake-openai-server.ts` ff6e13975947004c
- `apps/api/test/financial-action-safety.test.ts` e9112a8e91071b89
- `apps/api/test/helpers.ts` 8872b589df959008
- `apps/api/test/helpers/pty-run.py` c5f6a525899e4b35
- `apps/api/test/ingress.test.ts` b78b0684970282e1
- `apps/api/test/openai-compatible-client.test.ts` 210d707e7953f25c
- `apps/api/test/policy-engine.test.ts` ed0ff99e657dfc5a
- `apps/api/test/review-remediation.test.ts` 3a059b2e52b6179a
- `apps/api/test/safety-invariants.test.ts` 4a31903ffac74c28
- `apps/api/test/server.test.ts` 4028990803ddad8a
- `apps/api/test/serverless-body.test.ts` 2b6b748c733c805d
- `apps/api/test/state-machine.test.ts` 1f85a4258132db1b
- `apps/api/test/team-openrouter.test.ts` d4df7af061a60b3d
- `apps/api/test/tokenfactory-smoke.test.ts` e0110497191545fe
- `apps/api/test/vllm-adapters.test.ts` 653e81d0aa01589e
- `apps/api/tsconfig.json` 4743270af4b16da4
- `apps/web/.gitignore` fe718e7babb14f3c
- `apps/web/.oxlintrc.json` b4d344818a1e1bf4
- `apps/web/README.md` fa8aac78b8be1993
- `apps/web/e2e/ai-team.e2e.mjs` 2c410affc5815426
- `apps/web/e2e/commerce-os.e2e.mjs` 7163d5ca4a7bf2c3
- `apps/web/e2e/judge-mode.e2e.mjs` 055ac98e8c5290f7
- `apps/web/e2e/judge-reliability.e2e.mjs` edc9598be713f643
- `apps/web/e2e/merchant-platform.e2e.mjs` 72a6375d9bc5139a
- `apps/web/e2e/proof-mode.e2e.mjs` 58f3a49d4a1c5216
- `apps/web/index.html` 3532522f287bd3f1
- `apps/web/package-lock.json` 386b21913e4adebd
- `apps/web/package.json` aa68832a8f4cf645
- `apps/web/public/favicon.svg` 61bc9a161de58248
- `apps/web/src/App.tsx` f64bfe68e1c40179
- `apps/web/src/components/assistant/AssistantPanel.tsx` 21af308e0aa29982
- `apps/web/src/components/charts/BarList.tsx` f6a80b4d3166d558
- `apps/web/src/components/charts/ChartCard.tsx` dc16afc9a54fc746
- `apps/web/src/components/charts/DonutChart.tsx` 6b06c90fd0aaf675
- `apps/web/src/components/charts/StackedBarChart.tsx` 96a15c51bd770ed0
- `apps/web/src/components/charts/scale.ts` c7dd4b934bd0fdd5
- `apps/web/src/components/command/DecisionReveal.tsx` 0da8f95447101e8c
- `apps/web/src/components/dashboard/StoreOverview.tsx` a3f65ac4ab160f1b
- `apps/web/src/components/investigation/InvestigationView.tsx` 3ed20e6cf4012b11
- `apps/web/src/components/investigation/WorkflowRail.tsx` 94602677e355e40e
- `apps/web/src/components/judge/MerchantImpact.tsx` 25b87f747a065e80
- `apps/web/src/components/judge/StressLab.tsx` bc019a175047fce8
- `apps/web/src/components/layout/DemoScenariosBar.tsx` 1d1f5d849e650c43
- `apps/web/src/components/layout/GlobalSearch.tsx` 6c56aaa0370d61c2
- `apps/web/src/components/layout/OpsShell.tsx` dcf1ee5572de40e0
- `apps/web/src/components/operations/CommandCenter.tsx` 42f65e178068471a
- `apps/web/src/components/panels/AuditTimelinePanel.tsx` fe2c9d8e97468d97
- `apps/web/src/components/panels/AuthorizationPanel.tsx` ec9570cd11623e13
- `apps/web/src/components/panels/CaseContextPanel.tsx` c787e3389218b85c
- `apps/web/src/components/panels/EscalationPanel.tsx` 5e249ded09511b88
- `apps/web/src/components/panels/EvidencePanel.tsx` 2bacaedf20ed2ab4
- `apps/web/src/components/panels/ExecutionVerificationPanel.tsx` 6bf5c329fbc09286
- `apps/web/src/components/panels/IntentCuesPanel.tsx` fd5442068a14867f
- `apps/web/src/components/panels/ProposalPanel.tsx` 8cb0dd662743e1a2
- `apps/web/src/components/panels/UnderstandingPanel.tsx` 42829aa9da279fe5
- `apps/web/src/components/proof/DecisionExplainer.tsx` 3be455912ac221a5
- `apps/web/src/components/proof/ProofChain.tsx` 638e41ee1b48b36f
- `apps/web/src/components/proof/SafetyShowdown.tsx` 3d8070d78a966225
- `apps/web/src/components/ui/FixtureBenchmarkNotice.tsx` c3dad2022183a94e
- `apps/web/src/components/ui/Icon.tsx` e47d67aef76a09d3
- `apps/web/src/components/ui/Panel.tsx` 409b1622d7e2a743
- `apps/web/src/components/ui/Primitives.tsx` fade49e0cbfa6d98
- `apps/web/src/components/ui/RuntimeChips.tsx` bd12610cff8732d8
- `apps/web/src/components/ui/StateBadge.tsx` d8daaf2b50033ff9
- `apps/web/src/components/ui/styles.ts` 93d4686fd81d4056
- `apps/web/src/components/workspace/MoneyMovementStrip.tsx` 445dd7938e62f246
- `apps/web/src/components/workspace/VerdictBanner.tsx` 423e7c166a8d1cff
- `apps/web/src/fixtures/demo-scenarios.ts` b22e23a2ef86b1e5
- `apps/web/src/index.css` 4978327fe2e2cdd2
- `apps/web/src/lib/analytics.ts` ae6d71c0fbc10563
- `apps/web/src/lib/api.ts` 9b876b0146e0ce3c
- `apps/web/src/lib/assistant-intent.ts` 9262194a89ccb491
- `apps/web/src/lib/automations.ts` cdbb87721892475d
- `apps/web/src/lib/baseline-result.ts` 82073440b238e6e2
- `apps/web/src/lib/bench-metrics.ts` 9f3bf9d3aef01b3f
- `apps/web/src/lib/case-schema.ts` 5f194d92f4b8675e
- `apps/web/src/lib/case-types.ts` 1975a18f5f340735
- `apps/web/src/lib/command-center.ts` 124554c499010ffe
- `apps/web/src/lib/commerce.ts` a7837724f787a320
- `apps/web/src/lib/demo-store.ts` f1fb1c1591337c4f
- `apps/web/src/lib/latest-amd-run.ts` 0e66e2cf69f9022d
- `apps/web/src/lib/merchant-impact.ts` 1a474222f40e70f8
- `apps/web/src/lib/money-lanes.ts` 24a170020173805f
- `apps/web/src/lib/money.ts` e8ea0e121cbed79b
- `apps/web/src/lib/outcome-guards.ts` 0ab9a166da683b1a
- `apps/web/src/lib/proof.ts` 7e597b0982f1f431
- `apps/web/src/lib/recorded-amd-run.ts` bbeaa940f42e9c20
- `apps/web/src/lib/routes.ts` 63477a81bf786883
- `apps/web/src/lib/runtime-truth.ts` 2f501985806bd6f2
- `apps/web/src/lib/sample-analytics.ts` 78fe0ba08517f18d
- `apps/web/src/lib/search.ts` 031c4e49aaafa015
- `apps/web/src/lib/session-store.ts` eb030c16355b272d
- `apps/web/src/lib/store-overview.ts` f20494771c26c72b
- `apps/web/src/lib/stress-lab-data.ts` 9dac8e64b259274d
- `apps/web/src/lib/stress-lab-join.ts` 43d9aa52459a8277
- `apps/web/src/lib/stress-lab.ts` face13c64aff4e36
- `apps/web/src/lib/system-truth.ts` b65eb7c0f07126ad
- `apps/web/src/lib/use-runtime-health.ts` 5660a1e84c47e3b5
- `apps/web/src/lib/verdict.ts` f2441d8f21d66df5
- `apps/web/src/main.tsx` 6e9e5807fcbd48b7
- `apps/web/src/pages/ActivityPage.tsx` d64afd23c133089f
- `apps/web/src/pages/ApprovalsPage.tsx` 59d8520a2ef2c0d5
- `apps/web/src/pages/AutomationsPage.tsx` 517a8b17601a1b88
- `apps/web/src/pages/BenchmarksPage.tsx` 52723f1f4a7c84bd
- `apps/web/src/pages/CasesPage.tsx` 5c2024fba3d84e8f
- `apps/web/src/pages/CommandCenterPage.tsx` 0c3b0a1cbb856a36
- `apps/web/src/pages/CustomersPage.tsx` 02932e0e1245f2d7
- `apps/web/src/pages/DashboardPage.tsx` 2a2b21e3068b64dd
- `apps/web/src/pages/InboxPage.tsx` b54d848152106907
- `apps/web/src/pages/JudgePage.tsx` 91db4e897e2c6a21
- `apps/web/src/pages/OnboardingPage.tsx` 9f8be55b17aababa
- `apps/web/src/pages/OrdersPage.tsx` bd241c6ed8707236
- `apps/web/src/pages/SettingsPage.tsx` 8b30c1ff33a6c64b
- `apps/web/src/pages/StorefrontPage.tsx` fff1d4ecd3946653
- `apps/web/src/pages/SystemPage.tsx` f3bea15788535135
- `apps/web/src/pages/TeamPage.tsx` 588df160f9fea616
- `apps/web/src/pages/command-center.css` cf2b4b76e67a88c1
- `apps/web/src/pages/judge.css` 631f5cf977fe7deb
- `apps/web/src/pages/team.css` 9ec486f171fd1e89
- `apps/web/src/team/agents.ts` dbae535dfa7c958d
- `apps/web/src/team/context.ts` 09b3c077aca8ea9b
- `apps/web/src/team/conversations.ts` f056fd5cbcefce52
- `apps/web/src/team/dataset.ts` d0214f436ae2f9e2
- `apps/web/src/team/figures.ts` 7a138d6a94fd53cf
- `apps/web/src/team/live-client.ts` 0efc2e361e43abf0
- `apps/web/src/team/metrics.ts` c381db52711e57d6
- `apps/web/src/team/mission.ts` 023477154026d0b2
- `apps/web/src/team/orchestrator.ts` 363f88a4a7f31ebe
- `apps/web/src/team/provider.ts` df3eb2dd67a11cb2
- `apps/web/src/team/specialists.ts` dd424ec6d0d4a41a
- `apps/web/test/ai-team.test.ts` 1647e78427ee4229
- `apps/web/test/analytics.test.ts` 6ea9d759a44788a8
- `apps/web/test/benchmark-labels.test.ts` 02912e05a6a26466
- `apps/web/test/command-center.test.ts` 5cb695d06f275187
- `apps/web/test/commerce.test.ts` 192642c1017875a6
- `apps/web/test/dashboard-assistant.test.ts` 7029a90656540fe3
- `apps/web/test/evidence-snapshot-label.test.ts` 0ca7e4e0955e9c06
- `apps/web/test/figure-check.test.ts` ffb9f794b1b0e494
- `apps/web/test/latest-amd-run.test.ts` c89e26ee448de4af
- `apps/web/test/merchant-impact.test.ts` 7aa90835a01adb67
- `apps/web/test/merchant-platform.test.ts` 7b089151f677134a
- `apps/web/test/outcome-guards.test.ts` 668b1f6e2ca1c398
- `apps/web/test/proof-mode.test.ts` e6d04709f793f2a3
- `apps/web/test/proof-step-navigation.test.ts` e550a7a932eeac6b
- `apps/web/test/real-cases.ts` 8fbafea0bfeeb724
- `apps/web/test/recorded-amd-run.test.ts` 0f40e7ce7a490ce2
- `apps/web/test/replay-accounting.test.ts` e21ca9c6861315b5
- `apps/web/test/stress-lab.test.ts` 80bbef2a944bd405
- `apps/web/test/workspace.test.ts` 2aff36e9533c9466
- `apps/web/tsconfig.app.json` 8e5d12ba330e7d86
- `apps/web/tsconfig.json` 770b4140bbb581e2
- `apps/web/tsconfig.node.json` d366cc0827139db3
- `apps/web/vite.config.ts` f2577a2e7bc72076
- `data/cases/duplicate-charge-eval.v1.json` d5a8b4064b81bf8b
- `evals/results/amd-live-001.json` b42cef88d7171f88
- `evals/results/baseline-no-policy.fixture.json` c177c8fa42fc7ed0
- `evals/results/demo-evidence-live-20261014T201902Z.json` ad1e622c5dae9157
- `evals/results/demo-evidence-live-20261017T210008Z.json` 825f31c018335eec
- `evals/results/duplicate-charge-eval.v1.json` b3e86b9140915761
- `evals/results/duplicate-charge-eval.v1.vllm-deepseek-v4-flash-tf-1.json` d31533f0a65c64de
- `evals/results/gemma-live-001.json` a3aae40fe0acd6d5
- `evals/results/hero-evidence-fixture-20261015.json` 575e715366cf2354
- `evals/results/hero-evidence-vercel-prod-20261016.json` 2eaf1baa57a7b35a
- `evals/results/live-gate-20261014T201902Z.json` 389b5cf6a55e19ed
- `evals/results/live-gate-20261015T172017Z.json` 4aef155a0dd89088
- `evals/results/live-gate-20261015T172249Z.json` 97aa97e216fa2ac5
- `evals/results/live-gate-20261015T230049Z.json` 26d62e7daf9d5483
- `evals/results/live-gate-20261017T210008Z.json` e1661c11f6c7afe0
- `evals/results/release-prod-fixture-20261017.json` 3b46d6efe780faa7
- `evals/results/team-live-20261018T053008Z.json` eede1ccb70dffb5d
- `evals/results/team-live-20261018T053156Z.json` 1064b0ae165d2fc2
- `evals/results/team-live-20261018T054026Z.json` ec3ca72db99735c4
- `evals/results/team-live-20261018T054209Z.json` 46b21e5665491abe
- `evals/results/team-live-20261018T055512Z.json` 1de51f8e71e43b3f
- `package-lock.json` d4a21910dabd61b7
- `package.json` 2aa37584eefa9fd0
- `reference/act3/docs/TECHNICAL_REFERENCE.md` 69917c264a6f5393
- `reference/act3/docs/cloud/JARVIS-CLOUD-ARCHITECTURE.md` 2315498452bf6680
- `reference/act3/docs/competition/SECURITY-THREAT-MODEL.md` aab7b16e8202d5da
- `reference/act3/supabase/functions/_shared/gateway.ts` 5a6be61ff89d28fc
- `reference/act3/supabase/functions/_shared/supabase-deps.ts` a1460afeb5e2ff69
- `reference/act3/supabase/functions/jarvis-gateway/index.ts` 445aaadd7ce6d4b8
- `reference/act3/supabase/migrations/20261017200000_jarvis_core.sql` a363f5bb22b1be76
- `reference/act3/supabase/migrations/20261017203000_share_policy_fix.sql` 776bb3bc10a28677
- `reference/act3/supabase/migrations/20261017213000_model_registry_and_case_execution.sql` 9db84b8a9051ffe6
- `reference/act3/supabase/rollback/20261017200000_jarvis_core.down.sql` aff393e395a7c91e
- `reference/act3/supabase/tests/security_test.sql` 082235f8e07fc699
- `reference/act3/tests-for-act3-deploy-targets/cloud-gateway.test.ts` 46f5b54850887dd3
- `reference/act3/tests-for-act3-deploy-targets/demo-store.test.ts` fe553f29749c6e02
- `reference/act3/tests-for-act3-deploy-targets/ingress-e2e.test.ts` 323cbd702e0d6f6f
- `reference/act3/tests-for-act3-tooling/ai-startup.test.ts` 6c2fd7ff5ce86a09
- `reference/act3/tests-for-act3-tooling/baseline-no-policy.test.ts` 90889a7edcfeb22d
- `reference/act3/tests-for-act3-tooling/benchmark.test.ts` 2db1ece0b0252657
- `reference/act3/tests-for-act3-tooling/demo-verifier.test.ts` a73c69920a7eae95
- `reference/act3/tests-for-act3-tooling/deploy-config.test.ts` 945ecabc3931b32c
- `reference/act3/tests-for-act3-tooling/scripts.test.ts` 88edd48ffb603c8c
- `reference/act3/tests-for-act3-tooling/tokenfactory-smoke-mocked.test.ts` 6f9da83fa8316b83
- `reference/act3/tests-for-act3-tooling/vllm-benchmark.test.ts` ae2bb5abbc350068

## Adjustments made while sanitizing (2 Nov 2026, before the first commit)
- Moved 11 ACT III test files that exercise ACT III-only deploy targets and tooling (Vercel/Netlify adapters, AMD live-gate scripts, refund benchmark baselines) from `apps/api/test/` to `reference/act3/tests-for-act3-*/`. Their targets were deliberately not copied, so they cannot run here.
- Removed npm scripts for ACT III-only tooling: `legacy:check`, `demo:verify`, `test:pwsh`, `api:bench*`, `api:baseline`.
- Renamed the package to `jarvis-proofops-vultr`, marked it private and MIT.
- Not copied at all: `api/`, `vercel.json`, `netlify*`, `scripts/`, `legacy-prototype/`, `supabase/config.toml`, deploy scripts, root ACT III status documents, `.vercel/`, any `.env`.

## Removed from the working tree on 4 Nov 2026 (remain in Git history)
ProofOps does not use these inherited parts, so they were removed before public review: the refund engine and the rest of `apps/api`, the ACT III web app `apps/web`, `data/`, `evals/` and `reference/`. Also removed: `prep/`, the pre-kickoff planning documents and the unused shared-database design.

**Inherited code still in use:** only `apps/api/src/provider/` (the OpenAI-compatible client, its error types and response clean-up) and its test with helper (`apps/api/test/openai-compatible-client.test.ts`, `fake-openai-server.ts`), all unchanged from ACT III. Everything under `apps/proofops/` and `ops/` was written for ProofOps; `apps/proofops` was developed during the event, starting from the 3 Nov kickoff, as its commit dates show.
