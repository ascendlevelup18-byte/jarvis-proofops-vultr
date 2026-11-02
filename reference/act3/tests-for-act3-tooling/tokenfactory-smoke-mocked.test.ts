// Mocked behaviour tests of scripts/tokenfactory-smoke.ps1 that run on Windows (Windows PowerShell 5.1)
// and anywhere pwsh is installed. Read-Host is shadowed by a function in the calling scope, so the
// script's own hidden prompt returns a fake test key as a SecureString; the script itself still has no
// other way to receive a key. Every network call goes to a local fake server.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/tokenfactory-smoke.ps1", import.meta.url));
const SHELL = process.env.PWSH || (process.platform === "win32" ? "powershell.exe" : "pwsh");
const available = spawnSync(SHELL, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0;

// Fake keys only. GOOD matches the contract shape ("rc-" + 48 hex).
const GOOD = "rc-" + "0123456789abcdef".repeat(3);
const BAD_SHAPE = "sk-test-NEVER-PRINT-3f9c2a71";

type Handler = (req: IncomingMessage, body: string) => { status: number; json?: unknown; raw?: string; headers?: Record<string, string>; hang?: boolean };
interface Seen {
  paths: string[];
  auth: (string | undefined)[];
  chatBody: Record<string, unknown> | null;
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fake(handler: Handler): Promise<{ base: string; seen: Seen }> {
  const seen: Seen = { paths: [], auth: [], chatBody: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.paths.push(`${req.method} ${req.url}`);
      seen.auth.push(req.headers.authorization);
      if (req.url === "/v1/chat/completions" && body) seen.chatBody = JSON.parse(body);
      const r = handler(req, body);
      if (r.hang) return; // never answer: exercises the client timeout
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.raw ?? JSON.stringify(r.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}/v1`, seen };
}

const models = (ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
const okChat = { model: "DeepSeek-V4-Flash", choices: [{ message: { role: "assistant", content: "Hello there, nice to meet you." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } };

// Mirrors the observed gateway: /models answers any token, /chat/completions checks it.
function gateway(over: { chat?: Handler; models?: Handler; usage?: Handler } = {}): Handler {
  return (req, body) => {
    const authed = req.headers.authorization === `Bearer ${GOOD}`;
    if (req.url === "/v1/models") {
      if (!req.headers.authorization) return { status: 401, json: { detail: "Login required" } };
      return over.models?.(req, body) ?? { status: 200, json: models(["DeepSeek-V4-Flash", "MiMo-V2.6-Flash"]) };
    }
    if (req.url === "/v1/usage?include_recent=true") return over.usage?.(req, body) ?? (authed ? { status: 200, json: { total: 1 } } : { status: 401, json: {} });
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (over.chat) return over.chat(req, body);
      return authed ? { status: 200, json: okChat, headers: { "x-ratelimit-remaining-requests": "29" } } : { status: 401, json: { error: { message: `Invalid LLMGateway API token ${req.headers.authorization}` } } };
    }
    return { status: 404, json: {} };
  };
}

// The typed key travels to the child via an env var read only by the shadowing Read-Host function.
function run(args: string[], typed: string): Promise<{ code: number; output: string }> {
  // Parameter names stay bare; quoting them would bind them as positional values.
  const quoted = args.map((a) => (/^-[A-Za-z]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`)).join(" ");
  const command =
    "function Read-Host { param([Parameter(Position=0)]$Prompt, [switch]$AsSecureString) " +
    "Write-Host ($Prompt + ': ********'); if (-not $env:SMOKE_TEST_TYPED) { return (New-Object Security.SecureString) }; " +
    "ConvertTo-SecureString $env:SMOKE_TEST_TYPED -AsPlainText -Force }; " +
    `& '${SCRIPT.replace(/'/g, "''")}' ${quoted}; exit $LASTEXITCODE`;
  return new Promise((resolve) =>
    execFile(
      SHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, SMOKE_TEST_TYPED: typed } },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }),
    ),
  );
}

function assertNoSecret(output: string, secret: string) {
  assert.ok(!output.includes(secret), "the key must never appear in output");
  assert.ok(!output.includes(secret.slice(3, 20)), "no fragment of the key may appear in output");
  assert.ok(!/Bearer\s+(?!\[REDACTED\])\S/.test(output), "no bearer value in output");
}

describe("tokenfactory-smoke.ps1 (mocked Read-Host, fake gateway)", { skip: available ? false : `${SHELL} not available` }, () => {
  test("happy path: format check, models, usage, one 'Say hello' chat call; exit 0", async () => {
    const { base, seen } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], GOOD);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Key format check passed\./);
    assert.doesNotMatch(r.output, /length|5[01]\b/i, "no key length is reported");
    assert.match(r.output, /HTTP 200 in \d+ ms/);
    assert.match(r.output, /header x-ratelimit-remaining-requests: 29/i);
    assert.match(r.output, /2 model\(s\)[\s\S]*- DeepSeek-V4-Flash/);
    assert.match(r.output, /3\) \/usage[\s\S]*200/);
    assert.match(r.output, /ok - \d+ ms - model=DeepSeek-V4-Flash - finish_reason=stop - prompt_tokens=12 - completion_tokens=8/);
    assert.match(r.output, /reply: Hello there/);
    assertNoSecret(r.output, GOOD);
    assert.equal(seen.auth[0], undefined, "the probe carries no key");
    assert.ok(seen.auth.slice(1).every((a) => a === `Bearer ${GOOD}`));
    assert.deepEqual(seen.chatBody?.messages, [{ role: "user", content: "Say hello in one sentence." }]);
    assert.equal(seen.chatBody?.max_tokens, 64);
    assert.equal(seen.chatBody?.model, "DeepSeek-V4-Flash");
  });

  test("bad base URL: exit 2 before any request", async () => {
    const r = await run(["-BaseUrl", "http://example.com/v1"], GOOD);
    assert.equal(r.code, 2, r.output);
    assert.match(r.output, /BaseUrl must be the OpenAI-compatible root/);
  });

  test("wrong key shape: exit 3, nothing authenticated is sent, key never echoed", async () => {
    const { base, seen } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], BAD_SHAPE);
    assert.equal(r.code, 3, r.output);
    assert.match(r.output, /key check 'matches documented key format': FAIL/);
    assert.match(r.output, /Key format check FAILED\. Nothing was sent with the key/);
    assert.deepEqual(seen.paths, ["GET /v1/models"], "only the unauthenticated probe ran");
    assertNoSecret(r.output, BAD_SHAPE);
    assert.doesNotMatch(r.output, /\b28\b/, "no key length is reported");
  });

  test("one character short, or a non-hex character: exit 3", async () => {
    for (const bad of [GOOD.slice(0, -1), GOOD.slice(0, -1) + "g"]) {
      const { base, seen } = await fake(gateway());
      const r = await run(["-BaseUrl", base], bad);
      assert.equal(r.code, 3, r.output);
      assert.equal(seen.paths.length, 1);
    }
  });

  test("no key (empty input): exit 3 with nothing sent", async () => {
    const { base, seen } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], "");
    assert.equal(r.code, 3, r.output);
    assert.match(r.output, /key check 'not empty': FAIL/);
    assert.equal(seen.paths.length, 1);
  });

  test("surrounding whitespace fails the check instead of being sent", async () => {
    const { base, seen } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], ` ${GOOD} `);
    assert.equal(r.code, 3, r.output);
    assert.match(r.output, /key check 'no surrounding whitespace': FAIL/);
    assert.equal(seen.paths.length, 1);
    assertNoSecret(r.output, GOOD);
  });

  test("connection failure: exit 4 before the key is asked for", async () => {
    const { base } = await fake(gateway());
    const port = base.match(/:(\d+)\//)![1];
    servers.at(-1)!.close();
    await new Promise((r) => setTimeout(r, 100));
    const r = await run(["-BaseUrl", `http://127.0.0.1:${port}/v1`], GOOD);
    assert.equal(r.code, 4, r.output);
    assert.doesNotMatch(r.output, /API key \(input hidden/);
  });

  test("well-formed but rejected key: /models 200 yet chat 401 -> exit 5, server text redacted", async () => {
    const other = "rc-" + "f".repeat(48);
    const { base } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], other);
    assert.equal(r.code, 5, r.output);
    assert.match(r.output, /2 model\(s\)/, "models listed even for a rejected key");
    assert.match(r.output, /FAILED at step 4 \(chat completion\): HTTP 401/);
    assert.match(r.output, /server said: .*Invalid LLMGateway API token/);
    assertNoSecret(r.output, other);
  });

  test("model not served: exit 6 with no chat call", async () => {
    const { base, seen } = await fake(gateway());
    const r = await run(["-BaseUrl", base, "-Model", "deepseek-v4-flash"], GOOD);
    assert.equal(r.code, 6, r.output);
    assert.equal(seen.chatBody, null);
  });

  test("empty model list: exit 6", async () => {
    const { base } = await fake(gateway({ models: () => ({ status: 200, json: models([]) }) }));
    const r = await run(["-BaseUrl", base], GOOD);
    assert.equal(r.code, 6, r.output);
  });

  test("HTTP 429 -> 7, 404 -> 8, 500 -> 9 on the chat call", async () => {
    for (const [status, code] of [[429, 7], [404, 8], [500, 9]] as const) {
      const { base } = await fake(gateway({ chat: () => ({ status, json: { error: { message: `upstream Bearer ${GOOD}` } } }) }));
      const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], GOOD);
      assert.equal(r.code, code, `${status}: ${r.output}`);
      assertNoSecret(r.output, GOOD);
    }
  });

  test("chat 503 -> exit 9; timeout -> exit 4; both after a valid key", async () => {
    const unavailable = await fake(gateway({ chat: () => ({ status: 503, json: { error: { message: "busy" } } }) }));
    const r1 = await run(["-BaseUrl", unavailable.base, "-Model", "DeepSeek-V4-Flash"], GOOD);
    assert.equal(r1.code, 9, r1.output);
    assert.match(r1.output, /FAILED at step 4 \(chat completion\): HTTP 503/);
    const hanging = await fake(gateway({ chat: () => ({ status: 200, hang: true }) }));
    const r2 = await run(["-BaseUrl", hanging.base, "-Model", "DeepSeek-V4-Flash", "-ChatTimeoutSec", "2"], GOOD);
    assert.equal(r2.code, 4, r2.output);
    assert.match(r2.output, /No HTTP response \(DNS, proxy, TLS or timeout\)/);
  });

  test("chat 200 with empty content is malformed: exit 10", async () => {
    const { base } = await fake(gateway({ chat: () => ({ status: 200, json: { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] } }) }));
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], GOOD);
    assert.equal(r.code, 10, r.output);
  });

  test("malformed chat reply: exit 10", async () => {
    const { base } = await fake(gateway({ chat: () => ({ status: 200, json: { id: "x" } }) }));
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], GOOD);
    assert.equal(r.code, 10, r.output);
  });

  test("usage endpoint failure is informational only", async () => {
    const { base } = await fake(gateway({ usage: () => ({ status: 404, json: {} }) }));
    const r = await run(["-BaseUrl", base, "-Model", "DeepSeek-V4-Flash"], GOOD);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /HTTP 404.*\(not fatal\)/);
  });
});
