# JARVIS security threat model and adversarial test map (feature/actiii-grand-championship)

Scope: core refund engine (API), AI Executive Team (browser + operator-only server endpoints), providers (AMD-hosted OpenAI-compatible, OpenRouter, fixture). References: OWASP Top 10 for LLM Applications (prompt injection, insecure output handling, excessive agency, sensitive information disclosure, unbounded consumption), OWASP API Security Top 10 (broken authentication, unrestricted resource consumption). No certification or absence of vulnerabilities is claimed.

## Trust boundaries
1. Customer text, business problems and shared chat notes are **untrusted input**.
2. Model output (any provider) is **untrusted proposal**: schema-validated, role-checked, figure-checked, tool-allowlisted; never authority.
3. Deterministic TypeScript (policy engine, state machine, simulated gateway, read-back, team orchestrator) is the **only authority**.
4. Provider keys exist only in server process environment; the browser holds at most the operator token for the current page session.

## The 20 required adversarial cases
| # | Threat | Enforced control | Evidence (test) | Result |
|---|---|---|---|---|
| 1 | Prompt injection demanding a $5,000 refund | Amount derived from records; policy DENY on contradiction | `verify-demo` #48294; benchmark DC-A cases; `ai-team.test.ts` hostile shared notes | Pass |
| 2 | Duplicate refund attempts | Idempotency key + replay accounting | `financial-action-safety.test.ts`; verifier repeat run | Pass |
| 3 | Conflicting transaction amounts | NO_CONTRADICTIONS check | verifier #48292; benchmark DC-C | Pass |
| 4 | Malformed model output | Schema validation, fail closed | `engine-hardening`, vLLM adapter tests; `team-openrouter` non-JSON | Pass |
| 5 | Provider model swap | Served-model check (core); MODEL_MISMATCH (team) | `engine-hardening` "startup refuses … different model"; `team-openrouter` swap | Pass |
| 6 | Key leakage request | Key never in prompts, responses, errors or browser code | `team-openrouter` (no key in any prompt/status/error); `ai-team.test.ts` no credentials in team code | Pass |
| 7 | Cross-agent private-chat leakage | Per-agent threads; explicit sharing only | `ai-team.test.ts` isolation + sharing; e2e COO chat check | Pass |
| 8 | Unauthorized model endpoint access | Bearer token on /team/* and privileged /cases; 404 when disabled | `team-openrouter` endpoints; verifier free-text 403 | Pass |
| 9 | Budget exhaustion | Hard request cap counted per dispatch (team, default 15), free-only mode (zero listed price required; any reported cost stops the provider), HTTP 429/402 stop without retry, spend cap, daily call budget (core), call budget per boardroom | `team-openrouter` request cap with missing cost, unexpected cost, 429/402; `ai-team.test.ts` call budget; `ingress` tests | Pass (process-local, see gaps) |
| 10 | Simultaneous requests | Concurrency limits; one team run at a time; client run guard | `financial-action-safety`; `team-openrouter` busy 429; `judge-reliability` double-click | Pass |
| 11 | Timeout and failed-provider recovery | Per-call timeouts, no fallback, others continue | `team-openrouter` timeout/500; `ai-team.test.ts`; `judge-reliability` 503 + rerun | Pass |
| 12 | Harmful instructions in business data | Shared notes and problem text passed as data; no tools that act | `ai-team.test.ts` hostile shared notes | Pass |
| 13 | Fabricated financial figures | One figure rule for findings, proposals, notes and private replies: statements with unsupported numbers are withheld (never shown with a warning). Covers %, money, scientific notation, magnitude words, full-width and other-script digits, spelled-out amounts | `figure-check.test.ts` (19 cases); `team-openrouter` fabricate, fabricated proposal, fabricated reply | Pass (tolerance max(0.051, 0.5%) means a value within 0.5% of a real figure is accepted) |
| 14 | Malicious HTML in agent messages | React text rendering, no `dangerouslySetInnerHTML` | `ai-team.e2e.mjs` HTML-injection check | Pass |
| 15 | Cancelled boardroom | AbortSignal through every call | `ai-team.test.ts` cancel; e2e cancel | Pass |
| 16 | Human-approval impersonation | Strict schema rejects `status`/`requiresApproval:false`; approvals only in UI; endpoint rejects extra fields | `ai-team.test.ts` adversarial outputs; `team-openrouter` `approve:true` → 400 | Pass |
| 17 | CEO policy bypass | CEO has no tools; disallowed tools dropped; plan actions always need approval | `ai-team.test.ts` CEO bypass | Pass |
| 18 | Failed read-back verification | RESOLVED only with matching read-back | `safety-invariants.test.ts`; benchmark DC-E05 | Pass |
| 19 | Partial API failure | Per-scenario / per-specialist failure isolation | `judge-reliability` 503; `team-openrouter` 500 | Pass |
| 20 | Rate-limit bypass across sessions | Per-client limiter; team one-at-a-time | `ingress` tests | **Partial**: limits are per process, not global across serverless instances. Public live inference stays disabled until a shared store (e.g. Redis) enforces them. |

## Local network exposure
The Node API now listens on `127.0.0.1` by default (`JARVIS_HOST` overrides it). Before this change it listened on all interfaces, so a live key in the server's environment was reachable from the local network behind the operator token.

## Known gaps (release-relevant)
- **Compromised AMD key.** It was exposed; hiding it server-side does not make it safe. It may be used only for owner-run, private, budget-capped tests; never behind a public endpoint.
- **Process-local quotas** (case limiter, team request cap, spend cap, busy flag). They reset when the server restarts and are not a global control. The provider-side $0 limit on the OpenRouter key is the outer boundary.
- **Single operator token** for /team/* and privileged /cases; no per-user identity, no CSRF tokens (bearer header, not cookies, so classic CSRF does not apply).
- **Browser-local chat storage** (`localStorage`), not encrypted, single user.
- No CSP headers are set by the Node dev server; Vercel defaults apply to the public demo.
