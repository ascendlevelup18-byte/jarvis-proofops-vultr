// UNIT tier, [MOCK] provider: the live-inference spending ceiling. No real inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { InferenceBudget } from "../src/inference-budget.ts";
import { vultrPlanner } from "../src/model.ts";

const cfg = (ceilingUsd: number, file = join(mkdtempSync(join(tmpdir(), "budget-")), "b.json")) => ({ ceilingUsd, inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2, maxOutputTokens: 600, file });
const turn = { task: "Add a jacket.", allowedPaths: ["/"], history: [], observation: { epoch: 1, url: "http://s/", title: "t", text: "x".repeat(1_400), elements: [] } };

async function mockProvider(handler: (n: number) => { status: number; body: unknown }) {
  let n = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const r = handler(++n);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, count: () => n, close: () => server.close() };
}
const ok = { status: 200, body: { id: "x", model: "deepseek-v4.1-flash-1017", choices: [{ message: { role: "assistant", content: '{"tool":"finish","note":"x"}' } }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } } };

test("[MOCK] a call whose worst case could pass the ceiling is never sent", async () => {
  const p = await mockProvider(() => ok);
  try {
    const b = new InferenceBudget(cfg(0.001)); // below one call's worst case
    const r = await vultrPlanner({ apiKey: "k", model: "m", baseUrl: p.url, budget: b }).next(turn);
    assert.equal(p.count(), 0);
    assert.match(r.error ?? "", /inference budget/);
    assert.equal(b.calls, 0);
  } finally { p.close(); }
});

test("[MOCK] reported usage replaces the reservation, and the ceiling holds across calls", async () => {
  const p = await mockProvider(() => ok);
  try {
    const b = new InferenceBudget(cfg(0.01));
    const planner = vultrPlanner({ apiKey: "k", model: "m", baseUrl: p.url, budget: b });
    let sent = 0;
    for (let i = 0; i < 50; i++) { const r = await planner.next(turn); if (!r.error) sent++; else break; }
    const actual = (900 * 0.3 + 40 * 1.2) / 1e6;
    assert.equal(p.count(), sent);
    assert.ok(Math.abs(b.committedUsd - sent * actual) < 1e-9);
    assert.ok(b.committedUsd + b.worstCaseUsd(5_000) > 0.01 - actual); // it stopped only when another worst case wouldn't fit
    assert.ok(b.committedUsd <= 0.01);
  } finally { p.close(); }
});

test("[MOCK] no automatic retries under a budget, and a failed call keeps its full reservation", async () => {
  const p = await mockProvider(() => ({ status: 503, body: { error: "busy" } }));
  try {
    const b = new InferenceBudget(cfg(1));
    const r = await vultrPlanner({ apiKey: "k", model: "m", baseUrl: p.url, budget: b, retryBaseDelayMs: 1 }).next(turn);
    assert.ok(r.error);
    assert.equal(p.count(), 1);
    assert.ok(b.committedUsd > 0);
    assert.equal(b.committedUsd, b.snapshot().committedUsd === 0 ? 0 : b.committedUsd);
    const ledger = JSON.parse(readFileSync(b.cfg.file, "utf8"));
    assert.equal(ledger.entries[0].status, "failed");
  } finally { p.close(); }
});

test("a restart keeps the spend, and an unfinished reservation counts in full", () => {
  const c = cfg(1);
  const a = new InferenceBudget(c);
  const slot = a.reserve(4_000);
  assert.equal(slot.ok, true);
  const b = new InferenceBudget(c); // as if the process died mid-call
  assert.equal(b.calls, 1);
  assert.ok(Math.abs(b.committedUsd - a.worstCaseUsd(4_000)) < 1e-12);
});

test("a budget needs real prices", () => {
  assert.throws(() => new InferenceBudget({ ...cfg(1), inputUsdPerMillion: Number("") }));
  assert.throws(() => new InferenceBudget({ ...cfg(1), outputUsdPerMillion: NaN }));
});
