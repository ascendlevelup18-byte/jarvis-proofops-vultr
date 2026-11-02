import { loadAiConfig, aiConfigSummary } from "./ai-config.ts";
import { initializeAi, type AiRuntime, type AiStartupReport, type ModelCallLog } from "./ai-mode.ts";
import { freshWorld } from "./ingress.ts";
import { loadIngressSecurity, LocalInferenceLimiter, type IngressSecurityConfig } from "./limits.ts";
import { createApp } from "./server.ts";
import { loadTeamConfig, OpenRouterTeamProvider } from "./team/openrouter.ts";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid PORT: ${process.env.PORT}`);

// Provider diagnostics for /api/health: counts and the last call, no prompts or keys.
const providerCalls = { ok: 0, failed: 0, last: null as (ModelCallLog & { at: string }) | null };

// fixture: deterministic adapters. vllm: the endpoint must list the model and pass both
// probes before the server listens, and a daily model-call budget must be configured.
// Any failure exits 1; there is no fallback to fixture.
let runtime: AiRuntime;
let startup: AiStartupReport;
let security: IngressSecurityConfig;
try {
  const aiConfig = loadAiConfig();
  security = loadIngressSecurity(process.env, aiConfig.mode);
  console.log("[jarvis] ai config:", JSON.stringify(aiConfigSummary(aiConfig)));
  console.log(
    "[jarvis] ingress:",
    JSON.stringify({ freeText: security.accessToken ? "token required" : "disabled", limits: security.limits, trustProxy: security.trustProxy }),
  );
  const ai = await initializeAi(aiConfig, {
    onCall: (entry) => {
      console.log("[jarvis] model call:", JSON.stringify(entry));
      providerCalls[entry.failureCategory ? "failed" : "ok"]++;
      providerCalls.last = { ...entry, at: new Date().toISOString() };
    },
  });
  runtime = ai.runtime;
  startup = ai.startup;
  console.log("[jarvis] ai startup:", JSON.stringify(startup));
} catch (e) {
  console.error(`[jarvis] startup failed, not serving: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Optional live AI Team (OpenRouter). Needs the operator token and a listed model; any problem exits 1.
// Loopback only unless JARVIS_HOST says otherwise: live keys must not be reachable from the local network.
const host = process.env.JARVIS_HOST?.trim() || "127.0.0.1";
let team: OpenRouterTeamProvider | null = null;
try {
  const teamCfg = loadTeamConfig(process.env);
  if (teamCfg) {
    if (!security.accessToken) throw new Error("the live AI Team requires an operator access token");
    team = new OpenRouterTeamProvider(teamCfg);
    await team.verifyModel();
    console.log("[jarvis] team startup:", JSON.stringify({ provider: "openrouter", model: teamCfg.model, freeOnly: teamCfg.freeOnly, maxRequests: teamCfg.maxRequests, maxOutputTokens: teamCfg.maxOutputTokens, capUsd: teamCfg.maxUsd, key: team.keyInfo, scope: "this process" }));
  }
} catch (e) {
  console.error(`[jarvis] team startup failed, not serving: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const clock = () => new Date();
// Privileged free-text cases share one persistent synthetic world; demo runs get a fresh one each.
const persistent = freshWorld(clock);

createApp(
  {
    aiMode: runtime.mode,
    understanding: runtime.understanding,
    model: runtime.model,
    engineTimeoutMs: runtime.engineTimeoutMs,
    modelCallsPerCase: runtime.modelCallsPerCase,
    accessToken: security.accessToken,
    limiter: new LocalInferenceLimiter(security.limits),
    privilegedWorld: () => persistent,
    clock,
    log: (entry) => console.log("[jarvis] case:", JSON.stringify(entry)),
  },
  {
    trustProxy: security.trustProxy,
    team: { provider: team, accessToken: security.accessToken },
    health: () => ({
      ok: true,
      service: "jarvis",
      deployment: "node-server",
      aiMode: runtime.mode,
      model: startup.model,
      models: runtime.mode === "vllm" ? { understanding: startup.understandingModel, decision: startup.model } : null,
      remoteModel: runtime.mode === "vllm",
      paymentGateway: "simulated",
      data: "synthetic",
      team: team ? { provider: "openrouter", model: team.info.model, access: "operator token" } : { provider: "fixture (browser)" },
      freeText: security.accessToken ? "token required" : "disabled",
      limits: { ...security.limits, scope: "this process", modelCallsReservedPerCase: runtime.modelCallsPerCase },
      provider:
        runtime.mode === "vllm"
          ? {
              endpoint: startup.endpoint,
              model: startup.model,
              understandingModel: startup.understandingModel,
              structuredOutput: startup.structuredOutput,
              understandingStructuredOutput: startup.understandingStructuredOutput,
              maxRetries: startup.maxRetries,
              startupProbes: startup.probes,
              calls: { ok: providerCalls.ok, failed: providerCalls.failed },
              lastCall: providerCalls.last,
            }
          : null,
    }),
  },
).listen(port, host, () => {
  console.log(`[jarvis] listening on ${host}: POST http://${host}:${port}/cases  (${runtime.mode} model, simulated payments, synthetic data)`);
});
