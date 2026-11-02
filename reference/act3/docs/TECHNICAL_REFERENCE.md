# Technical reference

Request handling, AI modes, deployment and known security limits. Moved here from the earlier README when the proof-first README replaced it (16 Oct 2026); content unchanged except headings.

## How a request is handled

Every entry point (node server, Netlify, Vercel) uses one ingress guard (`apps/api/src/ingress.ts`). It runs **before any model call**:

1. Method, body size (64 KiB), JSON and schema validation.
2. **Request class:**
   - An exact canonical demo is **public**.
   - Anything else is **privileged** and needs `Authorization: Bearer $JARVIS_CASES_TOKEN`. That is a server-side secret, never in the UI bundle, compared in constant time.
   - With no token configured, free text is refused (403).
3. **Cost limits** (429 + `Retry-After`):
   - per-client rate (default 30/min);
   - global concurrency (default 2);
   - daily model-call budget. In vllm mode this is required, and each case reserves 2 calls.
4. The unchanged case engine:
   - understanding (AI) → evidence (deterministic) → proposal (AI);
   - policy authorization and revalidation (deterministic);
   - simulated gateway → read-back verification → terminal state.

The limits are in-process. They are a real global limit for one long-running server, **but only per instance on serverless**. That is why serverless hosts are fixture-only (see below).

## AI modes

| Mode | Adapters | Startup |
|---|---|---|
| `fixture` (default) | Deterministic fixture adapters | No endpoint, no network |
| `vllm` | `VllmRequestUnderstandingAdapter` + `VllmModelAdapter` on one OpenAI-compatible client | `GET /models` must list `JARVIS_MODEL_NAME`, and one synthetic probe per adapter must return schema-valid JSON. Otherwise the process exits 1. **Never falls back to fixture.** |

Live-model environment (server-side only; never in the browser or the repo): `JARVIS_AI_MODE=vllm`, `JARVIS_MODEL_BASE_URL`, `JARVIS_MODEL_NAME` (e.g. `DeepSeek-V4-Flash`), `JARVIS_MODEL_API_KEY`, `JARVIS_DAILY_MODEL_CALL_BUDGET` (required), optional `JARVIS_MODEL_STRUCTURED_OUTPUT` (`json_schema` | `json_object` | `off`), `JARVIS_MODEL_TIMEOUT_MS`, `JARVIS_MODEL_MAX_RETRIES`, `JARVIS_MODEL_MIN_INTERVAL_MS` (pacing), `JARVIS_UNDERSTANDING_MODEL_NAME` (optional second model for understanding). Free text needs `JARVIS_CASES_TOKEN`. The safest way to set the key is `scripts/live-gate.ps1` or `docs/submission/recording/start-live-api.ps1` (hidden prompt). Replies whose provider-reported model differs from the configured one fail closed.

Configuration: `apps/api/.env.example`. Real-model benchmark: `npm run api:bench:vllm -- --run <id>`. It writes `evals/results/duplicate-charge-eval.v1.vllm-<model>-<id>.json` and never touches the fixture results or baselines.

## Deployment

- **Netlify:** `netlify.toml` + `netlify/functions/*`.
- **Vercel:** `vercel.json` + `api/*`, deployed (fixture mode, no environment variables) at https://jarvis-actiii-preview.vercel.app; verified anonymously with `npm run demo:verify -- <url>` (13/13) on 16 Oct 2026.
- Both are thin wrappers over `apps/api/src/serverless.ts`. The public demo is **fixture AI with simulated payments**. Setting `JARVIS_AI_MODE=vllm` alone refuses cases (503); the implementation also has an explicit `JARVIS_SERVERLESS_REAL_MODEL=enabled` opt-in. That opt-in is not evidence of globally enforced quotas or permission to enable public paid inference.
- Real-model inference belongs on a **private long-running host** (`npm run api:start` with `JARVIS_AI_MODE=vllm`).

For public-demo verification, use `npm run demo:verify -- --fixture --evidence <output.json> https://jarvis-actiii-preview.vercel.app`. This checks all four scenarios, fixture adapter attribution, synthetic data, simulated payments, authorization refusals and audit evidence. It makes synthetic demo requests; it does not deploy anything.

## Security limitations (known)

- Rate, concurrency and budget limits are in-memory. They are not global across serverless instances, and the budget resets when the process restarts.
- One shared bearer token. No per-user identity, rotation or audit of token use.
- No TLS termination in the node server; run it behind a TLS proxy and set `JARVIS_TRUST_PROXY=1` only behind a trusted one.
- The payment gateway is simulated. There is no real payment integration.

