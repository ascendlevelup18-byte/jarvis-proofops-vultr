// Minimal authenticated Vultr Serverless Inference check. Run on the VM as the proofops user:
//   sudo -u proofops node ops/inference-smoke.mjs            -> lists models (public route: does NOT prove the key works)
//   sudo -u proofops node ops/inference-smoke.mjs <model-id> -> one tiny chat completion with that model
// The key is read from /etc/proofops/inference.env, never from argv or the shell, and is never printed.
// Output is a sanitized JSON record suitable for the evidence bundle.
import { readFileSync } from "node:fs";

const BASE = "https://api.vultrinference.com/v1";
const ENV_FILE = process.env.PROOFOPS_INFERENCE_ENV_FILE ?? "/etc/proofops/inference.env";
const key = /^PROOFOPS_INFERENCE_API_KEY=(.+)$/m.exec(readFileSync(ENV_FILE, "utf8"))?.[1]?.trim();
if (!key) { console.error(`no PROOFOPS_INFERENCE_API_KEY in ${ENV_FILE}`); process.exit(2); }
const redact = (s) => String(s).replaceAll(key, "[REDACTED]");

async function call(path, body) {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error bodies are reported as text */ }
  return { status: res.status, ms: Math.round(performance.now() - started), json, text: redact(text).slice(0, 500),
           requestId: res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? null };
}

const model = process.argv[2];
const at = new Date().toISOString();
if (!model) {
  const r = await call("/models");
  const ids = (r.json?.data ?? []).map((m) => m.id).sort();
  console.log(JSON.stringify({ check: "models", note: "public listing; HTTP 200 here does not prove authentication", at, httpStatus: r.status, latencyMs: r.ms, count: ids.length, ids,
                               error: r.status === 200 ? null : r.text }, null, 2));
  process.exit(r.status === 200 ? 0 : 1);
}

const r = await call("/chat/completions", {
  model, max_tokens: 64, temperature: 0, reasoning_effort: "minimal", response_format: { type: "json_object" },
  messages: [{ role: "user", content: 'Reply with this JSON object and nothing else: {"status":"PROOFOPS-OK"}' }],
});
const out = {
  check: "chat.completions", at, provider: "Vultr Serverless Inference", baseUrl: BASE,
  requestedModel: model, httpStatus: r.status, latencyMs: r.ms, requestId: r.requestId,
  responseModel: r.json?.model ?? null, responseId: r.json?.id ?? null, usage: r.json?.usage ?? null,
  content: r.json?.choices?.[0]?.message?.content ?? null,
  error: r.status === 200 ? null : r.status === 401 || r.status === 403 ? "authentication failed" : r.status === 429 ? "rate limited or quota" : r.text,
};
console.log(JSON.stringify(out, null, 2));
process.exit(r.status === 200 && out.responseModel ? 0 : 1);
