// [CHROMIUM] The chat UI with the server configured as deployed behind a proxy, so history is closed and only the run's
// owner can read it. SCRIPTED planner, no live model, no gVisor: this checks access, not sandbox isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const { chromium } = createRequire(join(ROOT, "apps/proofops/worker/package.json"))("playwright") as any;
let work: string;
let server: ChildProcess;
let base: string;
let browser: any;

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-deployed-"));
  const port = 47100 + Math.floor(Math.random() * 800);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", String(port), "--evidence", join(work, "ev"), "--data", join(work, "db")],
    { cwd: ROOT, env: { ...process.env, PROOFOPS_TRUST_PROXY: "1", PROOFOPS_RUNS_PER_MIN: "120", PROOFOPS_READS_PER_MIN: "5000" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error("no start")), 20_000);
    server.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("control plane on")) { clearTimeout(t); ok(); } });
  });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true });
});

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const denied: string[] = [];
  page.on("response", (r: any) => { if (r.status() === 403) denied.push(r.url()); });
  await page.goto(base);
  await page.waitForSelector("#task-text");
  return { ctx, page, denied };
}
const answer = (page: any) => page.waitForFunction(() => /verified against the store|didn't match|No approval was given|cancelled|time limit|proves nothing|incomplete/i.test(document.querySelector(".chat-answer")?.textContent ?? ""), null, { timeout: 60_000 });

test("DC-1 [CHROMIUM] deployed: the owner's own task streams, shows its result and screenshots, with no access errors", async () => {
  const { ctx, page, denied } = await open();
  await page.fill("#task-text", "Add 2 ProofOps Field Jackets to the cart, apply SAVE10, and confirm the total is $190 without placing an order.");
  await page.keyboard.press("Enter");
  await answer(page);
  assert.match(await page.locator(".chat-answer").last().innerText(), /Done, and verified against the store's records: 2 × ProofOps Field Jacket, code SAVE10, total \$190\.00\. Stopped at the cart, no order placed\./);
  assert.ok((await page.locator("#thumbs img").count()) > 0);
  assert.equal(await page.locator("#thumbs img").first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), true);
  assert.deepEqual(denied, []);
  await ctx.close();
});

test("DC-2 [CHROMIUM] deployed: approval, then reload during approval, then approve, places one order", async () => {
  const { ctx, page, denied } = await open();
  await page.fill("#task-text", "Buy one jacket with code SAVE10. Place the order after I approve it.");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#approval:not([hidden])", { timeout: 60_000 });
  await page.reload();
  await page.waitForSelector("#approval:not([hidden])", { timeout: 20_000 });
  await page.locator("#approve-btn").click();
  await answer(page);
  assert.match(await page.locator(".chat-answer").last().innerText(), /1 synthetic order placed with your approval/);
  assert.deepEqual(denied, []);
  await ctx.close();
});

test("DC-3 [CHROMIUM] deployed: another browser can't read the owner's run, its text or its evidence", async () => {
  const owner = await open();
  await owner.page.fill("#task-text", "Add 3 jackets and stop at the cart, thanks.");
  await owner.page.keyboard.press("Enter");
  await answer(owner.page);
  const runId = await owner.page.locator("#run-id").innerText();
  const stranger = await browser.newContext();
  for (const path of [`/api/runs/${runId}`, `/api/runs/${runId}/summary`, `/api/runs/${runId}/evidence/spec.json`, `/api/runs/${runId}/evidence/screenshots/verify-cart.png`, `/api/tasks/${runId}`, `/api/runs/${runId}/stream`]) {
    const r = await stranger.request.get(base + path);
    assert.equal(r.status(), 403, path);
    assert.equal((await r.text()).includes("thanks"), false);
  }
  // The owner's cookie is scoped to that run and can't approve, reject or cancel anything.
  const cookies = (await owner.ctx.cookies()).filter((c: any) => c.name === "proofops_run");
  assert.deepEqual(cookies.map((c: any) => c.path).sort(), [`/api/runs/${runId}`, `/api/tasks/${runId}`]);
  for (const c of cookies) {
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, "Strict");
    assert.equal(c.secure, true);
    assert.ok(c.expires > Date.now() / 1000 && c.expires <= Date.now() / 1000 + 3_601);
  }
  // A cookie for this run opens nothing for another run.
  const other = (await (await fetch(`${base}/api/runs`)).json()) as any[];
  assert.ok(other.length >= 1);
  const r = await owner.page.request.post(`${base}/api/runs/${runId}/cancel`, { headers: { "content-type": "application/json", "x-proofops": "1" }, data: "{}" });
  assert.equal(r.status(), 403);
  await stranger.close();
  await owner.ctx.close();
});
