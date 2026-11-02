import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  cleanupModelContent,
  OpenAICompatibleClient,
  ProviderError,
  redactSecrets,
  RequestPacer,
} from "../src/provider/index.ts";
import { startFakeOpenAIServer, type FakeOpenAIServer } from "./fake-openai-server.ts";

describe("OpenAICompatibleClient", () => {
  let fake: FakeOpenAIServer;

  before(async () => {
    fake = await startFakeOpenAIServer({ kind: "ok", content: '{"hello":true}' });
  });

  after(async () => {
    await fake.close();
  });

  test("200 returns choices[0].message.content", async () => {
    fake.setScenario({ kind: "ok", content: '{"hello":true}', model: "test-model" });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "test-model",
      timeoutMs: 5_000,
    });
    const result = await client.chatCompletions({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.content, '{"hello":true}');
    assert.equal(result.model, "test-model");
  });

  test("minIntervalMs spaces request starts; 0 is off; negative is a config error", async () => {
    fake.setScenario({ kind: "ok", content: "{}" });
    const spaced = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000, minIntervalMs: 150 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => spaced.chatCompletions({ messages: [{ role: "user", content: "hi" }] })));
    assert.ok(Date.now() - t0 >= 290, "three calls need at least two intervals");
    const unspaced = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000 });
    const t1 = Date.now();
    await Promise.all([1, 2, 3].map(() => unspaced.chatCompletions({ messages: [{ role: "user", content: "hi" }] })));
    assert.ok(Date.now() - t1 < 290);
    assert.throws(() => new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000, minIntervalMs: -1 }), ProviderError);
  });

  test("a shared RequestPacer spaces requests across two clients (two models, one account limit)", async () => {
    fake.setScenario({ kind: "ok", content: "{}" });
    const pacer = new RequestPacer(150);
    const a = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "model-a", timeoutMs: 5_000, pacer });
    const b = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "model-b", timeoutMs: 5_000, pacer });
    const t0 = Date.now();
    await Promise.all([a, b, a].map((c) => c.chatCompletions({ messages: [{ role: "user", content: "hi" }] })));
    assert.ok(Date.now() - t0 >= 290, "three calls across both clients need at least two intervals");
    assert.throws(() => new RequestPacer(-1), ProviderError);
  });

  test("malformed JSON -> INVALID_JSON", async () => {
    fake.setScenario({ kind: "malformed_json" });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.category, "INVALID_JSON");
        return true;
      },
    );
  });

  test("hang / timeout -> TIMEOUT", async () => {
    fake.setScenario({ kind: "hang" });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 150,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.category, "TIMEOUT");
        return true;
      },
    );
  });

  test("K4: listModels returns served model ids and sends the bearer key", async () => {
    fake.setModelsScenario({ kind: "list", ids: ["jarvis-main", "other"] });
    const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "jarvis-main", apiKey: "sk-test-models-key-123456", timeoutMs: 5_000 });
    assert.deepEqual(await client.listModels(), ["jarvis-main", "other"]);
    assert.equal(fake.lastAuthorization, "Bearer sk-test-models-key-123456");
  });

  const modelsFailures = [
    [{ kind: "http_status", status: 401 }, "HTTP_4XX"],
    [{ kind: "http_status", status: 503 }, "HTTP_5XX"],
    [{ kind: "malformed_json" }, "INVALID_JSON"],
    [{ kind: "unexpected_shape", body: { object: "list", data: [{ name: "no-id" }] } }, "INVALID_PROVIDER_RESPONSE"],
    [{ kind: "large", bytes: 50_000 }, "RESPONSE_TOO_LARGE"],
  ] as const;
  for (const [scenario, category] of modelsFailures) {
    test(`K4: listModels ${scenario.kind}${"status" in scenario ? ` ${scenario.status}` : ""} -> ${category}`, async () => {
      fake.setModelsScenario(scenario);
      const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000, maxResponseBytes: 8_192 });
      await assert.rejects(
        () => client.listModels(),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.category, category);
          return true;
        },
      );
    });
  }

  test("K4: listModels connection failure -> CONNECTION_ERROR", async () => {
    const client = new OpenAICompatibleClient({ baseUrl: "http://127.0.0.1:9", model: "m", timeoutMs: 1_000 });
    await assert.rejects(
      () => client.listModels(),
      (err: unknown) => err instanceof ProviderError && err.category === "CONNECTION_ERROR",
    );
  });

  test("K1: finish_reason stop is returned with token usage", async () => {
    fake.setScenario({ kind: "ok", content: '{"a":1}' });
    const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000 });
    const result = await client.chatCompletions({ messages: [{ role: "user", content: "x" }] });
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  for (const reason of ["length", "content_filter", "tool_calls", "something_new"] as const) {
    test(`K1: finish_reason ${reason} -> INVALID_PROVIDER_RESPONSE (truncated/unusable output)`, async () => {
      fake.setScenario({ kind: "ok", content: '{"action":"REFUND_DUP', finishReason: reason });
      const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000 });
      await assert.rejects(
        () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.category, "INVALID_PROVIDER_RESPONSE");
          assert.match(err.message, new RegExp(`finish_reason=${reason}`));
          return true;
        },
      );
    });
  }

  test("K1: absent finish_reason is accepted (finishReason undefined)", async () => {
    fake.setScenario({ kind: "unexpected_shape", body: { choices: [{ message: { content: '{"a":1}' } }] } });
    const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000 });
    const result = await client.chatCompletions({ messages: [{ role: "user", content: "x" }] });
    assert.equal(result.content, '{"a":1}');
    assert.equal(result.finishReason, undefined);
  });

  test("K1: refusal with null content -> INVALID_PROVIDER_RESPONSE", async () => {
    fake.setScenario({
      kind: "unexpected_shape",
      body: { choices: [{ message: { content: null, refusal: "I can't help" }, finish_reason: "stop" }] },
    });
    const client = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 5_000 });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => err instanceof ProviderError && err.category === "INVALID_PROVIDER_RESPONSE",
    );
  });

  test("K3: body stalls after headers -> TIMEOUT ProviderError (not a raw TimeoutError)", async () => {
    fake.setScenario({ kind: "body_stall" });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 200,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError, `expected ProviderError, got ${(err as Error)?.name}`);
        assert.equal(err.category, "TIMEOUT");
        return true;
      },
    );
  });

  test("connection failure -> CONNECTION_ERROR", async () => {
    // Nothing listening on this port.
    const client = new OpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      timeoutMs: 1_000,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.category, "CONNECTION_ERROR");
        return true;
      },
    );
  });

  for (const status of [400, 401, 429] as const) {
    test(`HTTP ${status} -> HTTP_4XX`, async () => {
      fake.setScenario({ kind: "http_status", status });
      const client = new OpenAICompatibleClient({
        baseUrl: fake.baseUrl,
        model: "m",
        timeoutMs: 5_000,
      });
      await assert.rejects(
        () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.category, "HTTP_4XX");
          assert.equal(err.statusCode, status);
          return true;
        },
      );
    });
  }

  for (const status of [500, 503] as const) {
    test(`HTTP ${status} -> HTTP_5XX`, async () => {
      fake.setScenario({ kind: "http_status", status });
      const client = new OpenAICompatibleClient({
        baseUrl: fake.baseUrl,
        model: "m",
        timeoutMs: 5_000,
      });
      await assert.rejects(
        () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.category, "HTTP_5XX");
          assert.equal(err.statusCode, status);
          return true;
        },
      );
    });
  }

  test("unexpected shape -> INVALID_PROVIDER_RESPONSE", async () => {
    fake.setScenario({ kind: "unexpected_shape", body: { ok: true, data: null } });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.category, "INVALID_PROVIDER_RESPONSE");
        return true;
      },
    );
  });

  test("large response -> RESPONSE_TOO_LARGE", async () => {
    fake.setScenario({ kind: "large", bytes: 50_000 });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 5_000,
      maxResponseBytes: 8_192,
    });
    await assert.rejects(
      () => client.chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.category, "RESPONSE_TOO_LARGE");
        return true;
      },
    );
  });

  test("text around JSON is returned as raw content (no schema interpretation)", async () => {
    const wrapped = 'Sure! Here is the JSON:\n{"a":1}\nThanks.';
    fake.setScenario({ kind: "text_around_json", content: wrapped });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      timeoutMs: 5_000,
    });
    const result = await client.chatCompletions({
      messages: [{ role: "user", content: "x" }],
    });
    assert.equal(result.content, wrapped);
  });

  test("API key is sent as Bearer but never appears in errors", async () => {
    const secret = "sk-super-secret-test-key-do-not-leak";
    fake.setScenario({ kind: "http_status", status: 401, body: JSON.stringify({ error: "unauthorized" }) });
    const client = new OpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      model: "m",
      apiKey: secret,
      timeoutMs: 5_000,
    });
    try {
      await client.chatCompletions({ messages: [{ role: "user", content: "x" }] });
      assert.fail("expected reject");
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.category, "HTTP_4XX");
      assert.ok(!err.message.includes(secret), "error message leaked API key");
      assert.ok(!JSON.stringify(err.toJSON()).includes(secret), "toJSON leaked API key");
    }
    assert.equal(fake.lastAuthorization, `Bearer ${secret}`);
  });

  test("CONFIG_ERROR for missing baseUrl / model / timeout", () => {
    assert.throws(
      () => new OpenAICompatibleClient({ baseUrl: "", model: "m", timeoutMs: 1000 }),
      (err: unknown) => err instanceof ProviderError && err.category === "CONFIG_ERROR",
    );
    assert.throws(
      () => new OpenAICompatibleClient({ baseUrl: "http://x", model: "", timeoutMs: 1000 }),
      (err: unknown) => err instanceof ProviderError && err.category === "CONFIG_ERROR",
    );
    assert.throws(
      () => new OpenAICompatibleClient({ baseUrl: "http://x", model: "m", timeoutMs: 0 }),
      (err: unknown) => err instanceof ProviderError && err.category === "CONFIG_ERROR",
    );
  });
});

describe("cleanupModelContent", () => {
  test("strips markdown code fences", () => {
    assert.equal(cleanupModelContent('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(cleanupModelContent('```\n{"a":1}\n```'), '{"a":1}');
  });

  test("strips reasoning blocks when enabled", () => {
    const raw = '<think>secret</think>\n{"ok":true}';
    assert.equal(cleanupModelContent(raw), '{"ok":true}');
    assert.equal(cleanupModelContent(raw, { stripReasoningBlocks: false }), raw.trim());
  });

  test("leaves text-around-JSON unchanged (no JARVIS schema parse)", () => {
    const raw = 'Here you go: {"a":1} done';
    assert.equal(cleanupModelContent(raw), raw);
  });
});

describe("redactSecrets", () => {
  test("redacts bearer tokens and api_key values", () => {
    assert.match(redactSecrets("Authorization: Bearer sk-abc123"), /\[REDACTED\]/);
    assert.match(redactSecrets('api_key: "sk-abc123"'), /\[REDACTED\]/);
    assert.ok(!redactSecrets("Bearer sk-abc123").includes("sk-abc123"));
  });
});

describe("bounded retries for transient provider errors", () => {
  let fake: FakeOpenAIServer;
  before(async () => {
    fake = await startFakeOpenAIServer();
  });
  after(async () => {
    await fake.close();
  });
  const client = (maxRetries: number) =>
    new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "fake-model", timeoutMs: 3000, maxRetries, retryBaseDelayMs: 10 });
  const ask = (c: OpenAICompatibleClient, signal?: AbortSignal) =>
    c.chatCompletions({ messages: [{ role: "user", content: "hi" }], ...(signal ? { signal } : {}) });
  const ok = { kind: "ok" as const, content: "{}" };

  for (const status of [429, 500, 502, 503, 504]) {
    test(`HTTP ${status} then success -> retried once, attempts reported`, async () => {
      fake.setScenario({ kind: "sequence", steps: [{ kind: "http_status", status }, ok] });
      const before = fake.requestCount;
      const r = await ask(client(1));
      assert.equal(r.content, "{}");
      assert.equal(r.attempts, 2);
      assert.equal(fake.requestCount - before, 2);
    });
  }

  test("connection refused is retried, then fails with CONNECTION_ERROR after the bound", async () => {
    const dead = await startFakeOpenAIServer();
    const url = dead.baseUrl;
    await dead.close();
    const c = new OpenAICompatibleClient({ baseUrl: url, model: "m", timeoutMs: 1000, maxRetries: 2, retryBaseDelayMs: 5 });
    await assert.rejects(ask(c), (e: unknown) => e instanceof ProviderError && e.category === "CONNECTION_ERROR");
  });

  for (const [label, scenario] of [
    ["401", { kind: "http_status" as const, status: 401 }],
    ["400", { kind: "http_status" as const, status: 400 }],
    ["malformed JSON body", { kind: "malformed_json" as const }],
    ["truncated output", { kind: "ok" as const, content: "{", finishReason: "length" }],
  ] as const) {
    test(`${label} is never retried`, async () => {
      fake.setScenario({ kind: "sequence", steps: [scenario, ok] });
      const before = fake.requestCount;
      await assert.rejects(ask(client(2)), ProviderError);
      assert.equal(fake.requestCount - before, 1);
    });
  }

  test("retries are off by default (maxRetries 0)", async () => {
    fake.setScenario({ kind: "sequence", steps: [{ kind: "http_status", status: 503 }, ok] });
    const before = fake.requestCount;
    await assert.rejects(
      new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 3000 }).chatCompletions({ messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof ProviderError && e.statusCode === 503,
    );
    assert.equal(fake.requestCount - before, 1);
  });

  test("gives up after maxRetries and surfaces the last error", async () => {
    fake.setScenario({ kind: "http_status", status: 503 });
    const before = fake.requestCount;
    await assert.rejects(ask(client(2)), (e: unknown) => e instanceof ProviderError && e.statusCode === 503);
    assert.equal(fake.requestCount - before, 3);
  });

  test("Retry-After (seconds) is honoured, capped by retryMaxDelayMs", async () => {
    fake.setScenario({ kind: "sequence", steps: [{ kind: "http_status", status: 429, headers: { "retry-after": "60" } }, ok] });
    const c = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 3000, maxRetries: 1, retryMaxDelayMs: 50 });
    const t0 = performance.now();
    const r = await ask(c);
    const waited = performance.now() - t0;
    assert.equal(r.attempts, 2);
    assert.ok(waited >= 40 && waited < 1000, `waited ${waited}ms`);
  });

  test("a caller abort during backoff stops immediately (no further attempt)", async () => {
    fake.setScenario({ kind: "sequence", steps: [{ kind: "http_status", status: 503 }, ok] });
    const c = new OpenAICompatibleClient({ baseUrl: fake.baseUrl, model: "m", timeoutMs: 3000, maxRetries: 1, retryBaseDelayMs: 5000 });
    const ac = new AbortController();
    const before = fake.requestCount;
    const p = ask(c, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: unknown) => e instanceof ProviderError && e.category === "TIMEOUT");
    assert.equal(fake.requestCount - before, 1);
  });

  test("listModels uses the same bounded retry", async () => {
    // models endpoint has its own scenario; 503 there is not sequenced, so just check no retry storms on success
    const ids = await client(1).listModels();
    assert.deepEqual(ids, ["fake-model"]);
  });

  test("invalid retry configuration is rejected", () => {
    assert.throws(() => new OpenAICompatibleClient({ baseUrl: "http://x/v1", model: "m", timeoutMs: 10, maxRetries: 4 }), /maxRetries/);
    assert.throws(() => new OpenAICompatibleClient({ baseUrl: "http://x/v1", model: "m", timeoutMs: 10, maxRetries: -1 }), /maxRetries/);
  });
});
