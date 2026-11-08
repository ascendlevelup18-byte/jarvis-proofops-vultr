// [CHROMIUM] tier: the operator console in a real browser against a real local control plane, with the scripted
// planner and no model calls. Archived runs are the real sealed bundles from this repository.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(join(ROOT, "apps/proofops/worker/package.json"));
// eslint-disable-next-line: Playwright lives in the worker package, so its types are not visible from here.
type Page = any;
const { chromium } = require("playwright") as any;
const axeSource = readFileSync(createRequire(join(ROOT, "package.json")).resolve("axe-core/axe.min.js"), "utf8");
const LIVE = join(ROOT, "proof/vultr-live-20261104/runs-d14d24c");
const WRONG = "run_20261104154518_b6a586f4a0ec403d";
const CORRECT = "run_20261104154509_8ec3eec5addfeed1";
const HOSTILE = "run_20261104154528_3813baadf6d05b88";
const APPROVED = "run_20261104154548_76b178711861224f";

let work: string;
let server: ChildProcess;
let base: string;
let browser: any;

function startServer(port: number, args: string[], env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["apps/proofops/src/server.ts", "--port", String(port), "--evidence", join(work, `ev-${port}`), "--data", join(work, `db-${port}`), ...args], { cwd: ROOT, env: { ...process.env, PROOFOPS_RUNS_PER_MIN: "120", PROOFOPS_READS_PER_MIN: "5000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("server did not start")), 20_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("control plane on")) { clearTimeout(t); ok(child); } });
    child.once("exit", (c) => { clearTimeout(t); fail(new Error(`server exited ${c}`)); });
  });
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-mc-"));
  // Archive copy with one bundle deliberately changed after sealing, beside untouched ones.
  const arch = join(work, "archive");
  for (const id of [WRONG, CORRECT, HOSTILE, APPROVED]) cpSync(join(LIVE, id), join(arch, id), { recursive: true });
  cpSync(join(LIVE, "ANCHORS.txt"), join(arch, "ANCHORS.txt"));
  writeFileSync(join(arch, HOSTILE, "report.md"), "edited after sealing");
  const port = 43100 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = await startServer(port, ["--archive", arch]);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true });
});

async function open(width: number, height: number, path = "/", opts: Record<string, unknown> = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(base + path);
  await page.waitForFunction(() => !(document.getElementById("run-btn") as HTMLButtonElement).disabled || location.hash.length > 1);
  return { ctx, page, errors };
}
const inViewport = (page: Page, selector: string) => page.locator(selector).evaluate((n: Element) => {
  const r = n.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
});
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// The guided missions sit below the task box and start collapsed on a phone.
const openMissions = async (page: Page) => { await page.locator("#settings-open").click(); await page.locator("#activity summary").first().click(); if (!(await page.locator("#missions-box").evaluate((d: HTMLDetailsElement) => d.open))) await page.locator("#missions-box summary").click(); };
const pick = async (page: Page, title: string) => { await openMissions(page); await page.locator(".scenario", { hasText: title }).click(); };
const finished = (page: Page) => page.waitForSelector("#outcome:not([hidden]) .outcome-link", { timeout: 60_000 });

for (const [w, h] of [[375, 667], [375, 812], [768, 1024], [1280, 720], [1366, 768], [1440, 900]] as const) {
  test(`MC-1 [CHROMIUM] Run task is above the fold and Run mission is reachable at ${w}x${h}, with no sideways scrolling`, async () => {
    const { ctx, page, errors } = await open(w, h);
    assert.equal(await inViewport(page, "#task-run"), true);
    await openMissions(page);
    await page.locator("#run-btn").scrollIntoViewIfNeeded();
    assert.equal(await inViewport(page, "#run-btn"), true);
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

for (const [w, h] of [[375, 812], [768, 1024], [1366, 768], [1440, 900]] as const) {
  test(`MC-2 [CHROMIUM] the verdict is on screen as soon as a mission ends at ${w}x${h}`, async () => {
    const { ctx, page, errors } = await open(w, h);
    await pick(page, "Wrong discount");
    await page.locator("#run-btn").click();
    await finished(page);
    await page.waitForTimeout(700); // smooth scroll settles
    assert.equal(await inViewport(page, "#outcome .outcome-label"), true);
    assert.equal(await page.locator("#outcome").getAttribute("data-outcome"), "designed_negative");
    assert.match(await page.locator("#outcome").textContent() ?? "", /failed as intended[\s\S]*\$90\.00[\s\S]*\$95\.00/i);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outcome");
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("MC-3 [CHROMIUM] a healthy run says verified success, and labels the scripted planner honestly", async () => {
  const { ctx, page } = await open(1366, 768);
  await pick(page, "Correct discount");
  await page.locator("#run-btn").click();
  await finished(page);
  const text = await page.locator("#outcome").textContent() ?? "";
  assert.match(text, /Verified success/);
  assert.match(text, /Scripted planner, no live AI/);
  assert.match(text, /Local, no sandbox/);
  assert.doesNotMatch(await page.locator("#env").innerText(), /gVisor \(runsc\)|Vultr Serverless/);
  await ctx.close();
});

test("MC-4 [CHROMIUM] approval is still bound to the exact cart, and the outcome shows after it", async () => {
  const { ctx, page } = await open(1366, 768);
  await pick(page, "Approved checkout");
  await page.locator("#run-btn").click();
  await page.waitForSelector("#approval:not([hidden])", { timeout: 60_000 });
  assert.equal(await page.locator("#outcome").isHidden(), true); // no verdict while a decision is pending
  assert.match(await page.locator("#approval-cart").innerText(), /DEMO-001[\s\S]*\$90\.00/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "approval-h");
  await page.locator("#approve-btn").click();
  await finished(page);
  assert.match(await page.locator("#outcome").textContent() ?? "", /Verified success/);
  await ctx.close();
});

test("MC-5 [CHROMIUM] a sealed live run reopens with what it recorded, and labels the real model", async () => {
  const { ctx, page, errors } = await open(1440, 900, `/#evidence/${WRONG}`);
  await page.waitForSelector("#evidence-detail .outcome");
  const text = await page.locator("#evidence-detail").innerText();
  assert.match(text, /Wrong discount/);
  assert.match(text, /failed as intended/);
  assert.match(text, /Live model: deepseek-v4\.1-flash-1017 on Vultr/);
  assert.match(text, /gVisor on Vultr/);
  assert.match(text, /\$90\.00/);
  assert.match(text, /\$95\.00/);
  assert.match(text, /checksums, not signatures/);
  assert.equal(await page.locator("#evidence-detail .gallery img").first().evaluate((i: HTMLImageElement) => new Promise((r) => { if (i.complete) r(i.naturalWidth > 0); else { i.onload = () => r(true); i.onerror = () => r(false); i.scrollIntoView(); } })), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("MC-6 [CHROMIUM] approval details and the refused replay show on the reopened run", async () => {
  const { ctx, page } = await open(1440, 900, `/#evidence/${APPROVED}`);
  await page.waitForSelector("#evidence-detail .outcome");
  const text = await page.locator("#evidence-detail").innerText();
  assert.match(text, /Approved by the operator/);
  assert.match(text, /HTTP 403, refused/);
  await ctx.close();
});

test("MC-7 [CHROMIUM] changed evidence shows as an integrity failure and never as Intact", async () => {
  const { ctx, page } = await open(1440, 900, `/#evidence/${HOSTILE}`);
  await page.waitForSelector("#evidence-detail .outcome");
  const text = await page.locator("#evidence-detail").innerText();
  assert.match(text, /Evidence integrity failure/);
  assert.match(text, /TAMPERED/);
  assert.doesNotMatch(text, /Intact|Verified success/);
  await page.goto(`${base}/#evidence`);
  await page.waitForSelector(`.run-row[data-run="${HOSTILE}"]`);
  assert.match(await page.locator(`.run-row[data-run="${HOSTILE}"]`).innerText(), /Evidence integrity failure/);
  await ctx.close();
});

test("MC-8 [CHROMIUM] comparing two runs shows recorded differences, and says what they don't mean", async () => {
  const { ctx, page, errors } = await open(1440, 900, `/#evidence`);
  await page.waitForSelector("#compare-form:not([hidden])");
  await page.selectOption("#compare-a", CORRECT);
  await page.selectOption("#compare-b", WRONG);
  await page.locator("#compare-form button").click();
  await page.waitForSelector("#compare-table");
  const row = page.locator("#compare-table tr", { hasText: "Observed total (store)" });
  assert.match(await row.innerText(), /\$90\.00[\s\S]*\$95\.00/);
  assert.match(await page.locator("#evidence-detail").innerText(), /not automatically a defect or a security finding/);
  const same = page.locator("#compare-table tr.same").first();
  assert.equal(await same.isVisible(), true);
  await page.locator("#only-differences").check();
  assert.equal(await same.isVisible(), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]] as const) {
  test(`MC-9 [CHROMIUM] Evidence, comparison and Trust have no sideways scrolling at ${w}x${h}`, async () => {
    const { ctx, page, errors } = await open(w, h, `/#evidence/${WRONG}`);
    await page.waitForSelector("#evidence-detail .outcome");
    assert.equal(await noOverflow(page), true);
    await page.goto(`${base}/#compare/${CORRECT}/${WRONG}`);
    await page.waitForSelector("#compare-table");
    assert.equal(await noOverflow(page), true);
    await page.goto(`${base}/#trust`);
    await page.waitForSelector("#trust-body .panel");
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test("MC-10 [CHROMIUM] Trust shows the real five actions and this deployment's real planner", async () => {
  const { ctx, page } = await open(1366, 768, "/#trust");
  await page.waitForSelector("#trust-body .panel");
  const text = await page.locator("#trust-body").innerText();
  assert.match(text, /navigate, click, fill, request_approval, finish/);
  assert.match(text, /Scripted planner, no live AI/);
  assert.match(text, /Not signatures/);
  await ctx.close();
});

test("MC-11 [CHROMIUM] keyboard users reach navigation, the task box, missions and Run, with visible focus", async () => {
  const { ctx, page } = await open(1366, 768);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "skip");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "JARVIS chat");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "settings-open");
  // Wait for the dialog to really open and close: under load, Escape can land before the modal exists,
  // or a Tab can land before the close event hands focus back.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.getElementById("settings-dialog") as HTMLDialogElement).open);
  // The dialog returns focus in its close event, which fires after it stops being open: wait for that event itself.
  await page.evaluate(() => { (window as any).__closed = new Promise((r) => document.getElementById("settings-dialog")!.addEventListener("close", r, { once: true })); });
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__closed);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "settings-open");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "task-text");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "task-run");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "solid");
  await openMissions(page);
  await page.locator('.scenario[aria-checked="true"]').focus();
  await page.keyboard.press("ArrowDown");
  assert.match(await page.locator("#selected-mission").innerText(), /Wrong discount/);
  await ctx.close();
});

test("MC-12 [CHROMIUM] reduced-motion users get no animation", async () => {
  const { ctx, page } = await open(1366, 768, "/", { reducedMotion: "reduce" });
  const t = await page.locator(".primary").first().evaluate((n: Element) => getComputedStyle(n).transitionDuration);
  assert.equal(t, "0s");
  await ctx.close();
});

for (const [name, path, wait] of [["Run", "/", "#task-run"], ["Evidence", `/#evidence/${WRONG}`, "#evidence-detail .outcome"], ["Comparison", `/#compare/${CORRECT}/${WRONG}`, "#compare-table"], ["Trust", "/#trust", "#trust-body .panel"]] as const) {
  test(`MC-13 [CHROMIUM] automated accessibility check has no serious issue on ${name}`, async () => {
    const { ctx, page } = await open(1366, 768, path, { bypassCSP: true, reducedMotion: "reduce" }); // fade-ins would skew contrast readings
    await page.waitForSelector(wait);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      const r = await (window as unknown as { axe: { run: (o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run({ resultTypes: ["violations"] });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
    });
    assert.deepEqual(res, []);
    await ctx.close();
  });
}

test("MC-14 [HTTP] read routes refuse bad ids and unknown runs, and live runs aren't summarized", async () => {
  assert.equal((await fetch(`${base}/api/compare?a=../../etc&b=x`)).status, 400);
  assert.equal((await fetch(`${base}/api/runs/run_20260101000000_00000000/summary`)).status, 404);
  assert.equal((await fetch(`${base}/api/compare?a=run_20260101000000_00000000&b=${WRONG}`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/${WRONG}/summary`, { method: "POST" })).status, 404);
  const trust = await (await fetch(`${base}/api/trust`)).text();
  assert.doesNotMatch(trust, /INFERENCE_API_KEY|PRIVATE KEY|proof\/vultr|[A-Z]:\\\\/);
});

test("MC-15 [HTTP] archived evidence is read-only and paths can't escape it", async () => {
  const before = readFileSync(join(work, "archive", WRONG, "manifest.json"), "utf8");
  assert.equal((await fetch(`${base}/api/runs/${WRONG}/evidence/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/api/runs/${WRONG}/evidence/..%2F..%2FANCHORS.txt`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/${WRONG}/evidence/manifest.json`, { method: "PUT", body: "x" })).status, 404);
  assert.equal(readFileSync(join(work, "archive", WRONG, "manifest.json"), "utf8"), before);
});

test("MC-16 [HTTP] behind a proxy, run history stays closed unless explicitly opened", async () => {
  const port = 43700 + Math.floor(Math.random() * 200);
  const child = await startServer(port, ["--archive", join(work, "archive")], { PROOFOPS_TRUST_PROXY: "1" });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/history`);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "history_private");
    const { ctx, page } = await (async () => { const c = await browser.newContext(); const p = await c.newPage(); await p.goto(`http://127.0.0.1:${port}/#evidence`); return { ctx: c, page: p }; })();
    await page.waitForSelector("#run-list li");
    assert.match(await page.locator("#run-list").innerText(), /isn't open on this deployment/);
    assert.equal(await page.locator("#compare-form").isHidden(), true);
    await ctx.close();
  } finally { child.kill(); }
});
