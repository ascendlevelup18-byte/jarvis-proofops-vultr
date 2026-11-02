import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AiConfigError, aiConfigSummary, loadAiConfig, resolveModelTimeouts } from "../src/ai-config.ts";
import { runCase } from "../src/case-engine.ts";
import { SCENARIOS } from "../src/fixtures.ts";
import { OpenAICompatibleClient } from "../src/provider/index.ts";
import { startFakeOpenAIServer } from "./fake-openai-server.ts";
import { makeDeps } from "./helpers.ts";

describe("loadAiConfig", () => {
  test("defaults to fixture with no endpoint required", () => {
    const cfg = loadAiConfig({});
    assert.equal(cfg.mode, "fixture");
    assert.equal(cfg.modelBaseUrl, undefined);
    assert.equal(cfg.modelName, undefined);
    assert.equal(cfg.modelApiKey, undefined);
    assert.equal(cfg.modelTimeoutMs, 30_000);
  });

  test("explicit fixture ignores missing model URL", () => {
    const cfg = loadAiConfig({ JARVIS_AI_MODE: "fixture" });
    assert.equal(cfg.mode, "fixture");
  });

  test("structured output accepts json_schema (default), json_object and off; rejects anything else", () => {
    assert.equal(loadAiConfig({}).structuredOutput, "json_schema");
    assert.equal(loadAiConfig({ JARVIS_MODEL_STRUCTURED_OUTPUT: "json_object" }).structuredOutput, "json_object");
    assert.equal(loadAiConfig({ JARVIS_MODEL_STRUCTURED_OUTPUT: " OFF " }).structuredOutput, "off");
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_STRUCTURED_OUTPUT: "json" }), AiConfigError);
  });

  test("understanding model: defaults to JARVIS_MODEL_NAME; can be set separately with its own structured output", () => {
    const base = { JARVIS_AI_MODE: "vllm", JARVIS_MODEL_BASE_URL: "http://127.0.0.1:1/v1", JARVIS_MODEL_NAME: "DeepSeek-V4-Flash" };
    const one = loadAiConfig({ ...base, JARVIS_MODEL_STRUCTURED_OUTPUT: "json_object" });
    assert.equal(one.understandingModelName, "DeepSeek-V4-Flash");
    assert.equal(one.understandingStructuredOutput, "json_object");
    const two = loadAiConfig({ ...base, JARVIS_UNDERSTANDING_MODEL_NAME: " Gemma-4-31B-IT ", JARVIS_UNDERSTANDING_STRUCTURED_OUTPUT: "off" });
    assert.equal(two.understandingModelName, "Gemma-4-31B-IT");
    assert.equal(two.understandingStructuredOutput, "off");
    assert.equal(two.modelName, "DeepSeek-V4-Flash");
    assert.equal(aiConfigSummary(two).understandingModelName, "Gemma-4-31B-IT");
    assert.throws(() => loadAiConfig({ ...base, JARVIS_UNDERSTANDING_STRUCTURED_OUTPUT: "json" }), AiConfigError);
  });

  test("request spacing: default off, explicit ms accepted, invalid values fail", () => {
    assert.equal(loadAiConfig({}).modelMinIntervalMs, 0);
    assert.equal(loadAiConfig({ JARVIS_MODEL_MIN_INTERVAL_MS: "3100" }).modelMinIntervalMs, 3100);
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_MIN_INTERVAL_MS: "-5" }), AiConfigError);
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_MIN_INTERVAL_MS: "fast" }), AiConfigError);
  });

  test("invalid timeout fails", () => {
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_TIMEOUT_MS: "0" }), AiConfigError);
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_TIMEOUT_MS: "-1" }), AiConfigError);
    assert.throws(() => loadAiConfig({ JARVIS_MODEL_TIMEOUT_MS: "nope" }), AiConfigError);
  });

  test("vllm requires base URL and model name", () => {
    assert.throws(() => loadAiConfig({ JARVIS_AI_MODE: "vllm" }), /JARVIS_MODEL_BASE_URL/);
    assert.throws(
      () => loadAiConfig({ JARVIS_AI_MODE: "vllm", JARVIS_MODEL_BASE_URL: "http://host:8000/v1" }),
      /JARVIS_MODEL_NAME/,
    );
  });

  test("vllm accepts optional API key", () => {
    const cfg = loadAiConfig({
      JARVIS_AI_MODE: "vllm",
      JARVIS_MODEL_BASE_URL: "http://host:8000/v1",
      JARVIS_MODEL_NAME: "my-model",
      JARVIS_MODEL_API_KEY: "sk-test",
      JARVIS_MODEL_TIMEOUT_MS: "15000",
    });
    assert.equal(cfg.mode, "vllm");
    assert.equal(cfg.modelBaseUrl, "http://host:8000/v1");
    assert.equal(cfg.modelName, "my-model");
    assert.equal(cfg.modelApiKey, "sk-test");
    assert.equal(cfg.modelTimeoutMs, 15_000);
  });

  test("summary never includes API key value", () => {
    const cfg = loadAiConfig({
      JARVIS_AI_MODE: "vllm",
      JARVIS_MODEL_BASE_URL: "http://host:8000/v1",
      JARVIS_MODEL_NAME: "my-model",
      JARVIS_MODEL_API_KEY: "sk-super-secret",
    });
    const summary = JSON.stringify(aiConfigSummary(cfg));
    assert.ok(!summary.includes("sk-super-secret"));
    assert.equal(aiConfigSummary(cfg).modelApiKeyConfigured, true);
  });

  test("rejects unknown mode", () => {
    assert.throws(() => loadAiConfig({ JARVIS_AI_MODE: "openai" }), AiConfigError);
  });
});

describe("K2: resolveModelTimeouts", () => {
  test("fixture keeps the existing 10s engine timeout and uses no client", () => {
    assert.deepEqual(resolveModelTimeouts(loadAiConfig({})), { engineTimeoutMs: 10_000, clientTimeoutMs: null });
  });

  test("vllm: engine uses the configured timeout, client gets a 2s backstop", () => {
    const cfg = loadAiConfig({
      JARVIS_AI_MODE: "vllm",
      JARVIS_MODEL_BASE_URL: "http://host:8000/v1",
      JARVIS_MODEL_NAME: "m",
      JARVIS_MODEL_TIMEOUT_MS: "15000",
    });
    assert.deepEqual(resolveModelTimeouts(cfg), { engineTimeoutMs: 15_000, clientTimeoutMs: 17_000 });
  });

  test("vllm default timeout: 30s engine, 32s client", () => {
    const cfg = loadAiConfig({ JARVIS_AI_MODE: "vllm", JARVIS_MODEL_BASE_URL: "http://host:8000/v1", JARVIS_MODEL_NAME: "m" });
    assert.deepEqual(resolveModelTimeouts(cfg), { engineTimeoutMs: 30_000, clientTimeoutMs: 32_000 });
  });

  test("a hanging real-client model call is classified MODEL_TIMEOUT (engine fires first), not MODEL_ERROR", async () => {
    const fake = await startFakeOpenAIServer({ kind: "hang" });
    try {
      const cfg = loadAiConfig({
        JARVIS_AI_MODE: "vllm",
        JARVIS_MODEL_BASE_URL: fake.baseUrl,
        JARVIS_MODEL_NAME: "m",
        JARVIS_MODEL_TIMEOUT_MS: "150",
      });
      const t = resolveModelTimeouts(cfg);
      const client = new OpenAICompatibleClient({ baseUrl: cfg.modelBaseUrl!, model: cfg.modelName!, timeoutMs: t.clientTimeoutMs! });
      const model = {
        id: "test-real-client",
        propose: async (_input: unknown, signal: AbortSignal) =>
          (await client.chatCompletions({ messages: [{ role: "user", content: "x" }], signal })).content,
      };
      const c = await runCase(SCENARIOS.validDuplicate, makeDeps({ model, modelTimeoutMs: t.engineTimeoutMs }));
      assert.equal(c.state, "FAILED");
      assert.equal(c.reasons[0]?.code, "MODEL_TIMEOUT");
      assert.equal(c.action, null);
    } finally {
      await fake.close();
    }
  });
});
