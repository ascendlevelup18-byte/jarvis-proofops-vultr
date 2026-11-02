// Behavioural tests of scripts/tokenfactory-smoke.ps1, executed by PowerShell 7 against a local fake
// OpenAI-compatible server. The key is typed at the hidden prompt through a pseudo-terminal (the
// script never accepts it any other way). Skipped when pwsh or python3 is unavailable; set PWSH to
// a pwsh binary path. Windows PowerShell 5.1 itself cannot run here; scripts.test.ts covers its syntax.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// Opt-in (needs a POSIX pseudo-terminal): PWSH=/path/to/pwsh npm run test:pwsh
const PWSH = process.env.PWSH ?? "";
const SCRIPT = fileURLToPath(new URL("../../../scripts/tokenfactory-smoke.ps1", import.meta.url));
const HELPER = fileURLToPath(new URL("./helpers/pty-run.py", import.meta.url));
const SECRET = "rc-" + "a1b2c3d4".repeat(6); // fake key in the contract shape
const available =
  PWSH !== "" &&
  process.platform !== "win32" &&
  spawnSync(PWSH, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0 &&
  spawnSync("python3", ["--version"]).status === 0;

interface Seen {
  auth: (string | undefined)[];
  chatBody: unknown;
}
type Handler = (req: IncomingMessage, body: string) => { status: number; json?: unknown; raw?: string };

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fake(handler: Handler): Promise<{ base: string; seen: Seen }> {
  const seen: Seen = { auth: [], chatBody: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.auth.push(req.headers.authorization);
      if (req.url === "/v1/chat/completions" && body) seen.chatBody = JSON.parse(body);
      const r = handler(req, body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.raw ?? JSON.stringify(r.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}/v1`, seen };
}

const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer ${SECRET}`;
const models = (ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

/** Standard endpoint; override any route. */
function endpoint(over: { models?: Handler; chat?: Handler } = {}): Handler {
  return (req, body) => {
    if (!authed(req)) return { status: 401, json: { error: { message: "missing or invalid key" } } };
    if (req.url === "/v1/models") return over.models?.(req, body) ?? { status: 200, json: models(["model-a", "model-b"]) };
    if (req.url === "/v1/chat/completions" && req.method === "POST")
      return over.chat?.(req, body) ?? { status: 200, json: { model: "model-a", choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 14, completion_tokens: 1 } } };
    return { status: 404, json: {} };
  };
}

// Async on purpose: the fake server lives in this process, so the event loop must keep running.
function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) =>
    execFile("python3", [HELPER, PWSH, "API key", SECRET, "-File", SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(stdout) as { code: number; output: string }),
    ),
  );
}

function assertNoSecret(output: string) {
  assert.ok(!output.includes(SECRET), "the key must never appear in output");
  assert.ok(!output.includes(SECRET.slice(8, 20)), "no fragment of the key may appear in output");
  assert.ok(!/Bearer\s+\S/.test(output), "no bearer value in output");
}

describe("tokenfactory-smoke.ps1 (PowerShell 7, fake endpoint)", { skip: available ? false : "set PWSH=<pwsh path> (POSIX + python3) to run the PowerShell behaviour tests" }, () => {
  test("happy path: auth required, models listed, one chat call; key masked and never printed", async () => {
    const { base, seen } = await fake(endpoint());
    const r = await run(["-BaseUrl", base, "-Model", "model-a"]);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /1\) \/models without a key[\s\S]*401/);
    assert.match(r.output, /2 model\(s\)[\s\S]*- model-a[\s\S]*- model-b/);
    assert.match(r.output, /ok - \d+ ms - model=model-a - finish_reason=\S* - prompt_tokens=14 - completion_tokens=1/);
    assert.match(r.output, /reply: OK/);
    assert.match(r.output, /API key \(input hidden; not stored\): \*+/, "typed key is echoed only as asterisks");
    assertNoSecret(r.output);
    // Request format: no key on the probe, then exactly the bearer header; OpenAI-style chat body.
    assert.equal(seen.auth[0], undefined);
    assert.ok(seen.auth.slice(1).every((a) => a === `Bearer ${SECRET}`));
    const body = seen.chatBody as { model: string; max_tokens: number; temperature: number; messages: { role: string; content: string }[] };
    assert.equal(body.model, "model-a");
    assert.equal(body.max_tokens, 64);
    assert.equal(body.temperature, 0);
    assert.ok(Array.isArray(body.messages) && body.messages.length === 1 && body.messages[0]?.role === "user");
  });

  test("discovery only (no -Model) makes no chat call", async () => {
    const { base, seen } = await fake(endpoint());
    const r = await run(["-BaseUrl", base]);
    assert.equal(r.code, 0, r.output);
    assert.equal(seen.chatBody, null);
    assertNoSecret(r.output);
  });

  test("rejected key: HTTP 401 at step 2 with a hint, exit 5", async () => {
    const { base } = await fake(() => ({ status: 401, json: { error: { message: `bad key ${SECRET}` } } }));
    const r = await run(["-BaseUrl", base]);
    assert.equal(r.code, 5);
    assert.match(r.output, /FAILED at step 2 \(\/models with key\): HTTP 401/);
    assert.match(r.output, /key was rejected/);
    assertNoSecret(r.output); // even when the server echoes the key in its error body
  });

  test("empty model list: clear message, exit 6", async () => {
    const { base } = await fake(endpoint({ models: () => ({ status: 200, json: models([]) }) }));
    const r = await run(["-BaseUrl", base, "-Model", "model-a"]);
    assert.equal(r.code, 6);
    assert.match(r.output, /No models are served for this key/);
    assertNoSecret(r.output);
  });

  test("invalid model selection (case-sensitive): refused before any chat call", async () => {
    const { base, seen } = await fake(endpoint());
    const r = await run(["-BaseUrl", base, "-Model", "MODEL-A"]);
    assert.equal(r.code, 6);
    assert.match(r.output, /Model 'MODEL-A' is not in the list above/);
    assert.equal(seen.chatBody, null);
  });

  test("malformed model reply: reported, exit 10", async () => {
    const { base } = await fake(endpoint({ chat: () => ({ status: 200, json: { id: "x", object: "chat.completion" } }) }));
    const r = await run(["-BaseUrl", base, "-Model", "model-a"]);
    assert.equal(r.code, 10);
    assert.match(r.output, /malformed reply/);
    assertNoSecret(r.output);
  });

  test("HTTP errors on the chat call: 429 and 500 reported by status only", async () => {
    for (const status of [429, 500]) {
      const { base } = await fake(endpoint({ chat: () => ({ status, json: { error: { message: `upstream ${SECRET}` } } }) }));
      const r = await run(["-BaseUrl", base, "-Model", "model-a"]);
      assert.equal(r.code, status === 429 ? 7 : 9);
      assert.match(r.output, new RegExp(`FAILED at step 4 \\(chat completion\\): HTTP ${status}`));
      if (status === 429) assert.match(r.output, /Rate limited/);
      assertNoSecret(r.output);
    }
  });

  test("connection failure: fails at step 1, before asking for the key", async () => {
    const { base } = await fake(endpoint());
    const port = base.match(/:(\d+)\//)![1];
    servers.at(-1)!.close();
    await new Promise((r) => setTimeout(r, 100));
    const r = await run(["-BaseUrl", `http://127.0.0.1:${port}/v1`]);
    assert.equal(r.code, 4);
    assert.match(r.output, /FAILED at step 1[\s\S]*No HTTP response/);
    assert.doesNotMatch(r.output, /API key \(input hidden/);
  });

  test("base URL validation: plain http to a remote host and missing /v1 are refused", async () => {
    for (const bad of ["http://example.com/v1", "https://example.com/api"]) {
      const r = await run(["-BaseUrl", bad]);
      assert.equal(r.code, 2, bad);
      assert.match(r.output, /BaseUrl must be the OpenAI-compatible root ending in \/v1/);
    }
  });
});
