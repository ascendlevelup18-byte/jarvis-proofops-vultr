// Judge rehearsal: drives the deployed console with a real browser and real clicks, exactly as a judge would,
// checks each mission's outcome, and saves screenshots.   node rehearse.mjs <base-url> <output-dir>
// Not part of the worker image. Starts at most 5 missions, so it stays inside the public rate limit.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const out = process.argv[3] ?? "rehearsal";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`console ${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

const health = await (await context.request.get(`${base}/api/health`)).json();
await page.goto(base, { waitUntil: "networkidle" });
await page.screenshot({ path: join(out, "01-first-screen.png") });

const results = [];
async function mission(title, shotName, expect) {
  const t0 = Date.now();
  await page.locator(".scenario", { hasText: title }).first().click();
  await page.locator("#run-btn").click();
  if (expect.approve) {
    await page.locator("#approval:not([hidden])").waitFor({ timeout: 60_000 });
    await page.locator("#approval").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${shotName}-approval.png`) });
    await page.locator("#approve-btn").click();
  }
  await page.locator(".verdict:not(.pending)").waitFor({ timeout: 90_000 });
  await page.locator("#evidence a").first().waitFor({ timeout: 10_000 });
  const verdict = (await page.locator("#verdict").innerText()).replace(/\s+/g, " ");
  const runId = await page.locator("#run-id").innerText();
  const status = await page.locator("#run-status").innerText();
  const blocked = await page.locator("#containment li:not(.empty)").allInnerTexts();
  const teardown = await page.locator('#pipeline li[data-stage="teardown"]').getAttribute("class");
  const shots = await page.locator("#thumbs img").count();
  await page.screenshot({ path: join(out, `${shotName}.png`), fullPage: true });
  const evidence = await (await context.request.get(`${base}/api/runs/${runId}/verify-evidence`)).json();
  const report = await context.request.get(`${base}/api/runs/${runId}/evidence/report.md`);
  const fails = [];
  if (!verdict.includes(expect.verdict)) fails.push(`verdict "${verdict}", expected ${expect.verdict}`);
  if (status.toUpperCase() !== expect.status.toUpperCase()) fails.push(`status ${status}, expected ${expect.status}`);
  if (teardown !== "done") fails.push(`teardown ${teardown}`);
  if (expect.minBlocked && blocked.length < expect.minBlocked) fails.push(`only ${blocked.length} blocked`);
  if (expect.replay && !blocked.some((b) => /HTTP 403/.test(b))) fails.push("replay refusal not shown");
  if (!["PASS", "FAIL"].includes(evidence.status)) fails.push(`evidence ${evidence.status}`);
  if (!report.ok()) fails.push("report not downloadable");
  results.push({ title, runId, seconds: Math.round((Date.now() - t0) / 100) / 10, verdict, status, blocked: blocked.length, screenshots: shots, evidence: evidence.status, ok: fails.length === 0, fails });
  console.log(`${fails.length ? "FAIL" : "ok  "} ${title.padEnd(20)} ${status.padEnd(10)} ${verdict.slice(0, 40).padEnd(40)} blocked=${blocked.length} evidence=${evidence.status} ${results.at(-1).seconds}s ${runId} ${fails.join("; ")}`);
}

await mission("Correct discount", "02-correct-discount", { verdict: "VERIFIED PASS", status: "Completed" });
await mission("Wrong discount", "03-wrong-discount", { verdict: "VERIFIED FAIL", status: "Completed" });
await mission("Hostile page", "04-hostile-page", { verdict: "VERIFIED PASS", status: "Completed", minBlocked: 3 });
await mission("Approved checkout", "05-approved-checkout", { verdict: "VERIFIED PASS", status: "Completed", approve: true, replay: true });
await mission("Hung page", "06-hung-page", { verdict: "VERIFIED FAIL", status: "Timed out" });

// Phone layout, signed out, fresh context.
const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
const p2 = await phone.newPage();
await p2.goto(base, { waitUntil: "networkidle" });
await p2.screenshot({ path: join(out, "07-phone.png") });
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 0) problems.push(`phone layout overflows by ${overflow}px`);
await browser.close();

const summary = { at: new Date().toISOString(), base, tier: health.tier, planner: health.planner, isolation: health.isolation, codeSha: health.codeSha, results, problems, ok: results.every((r) => r.ok) && problems.length === 0 };
writeFileSync(join(out, "rehearsal.json"), JSON.stringify(summary, null, 2));
console.log(summary.ok ? "\nRehearsal passed." : `\nRehearsal problems: ${JSON.stringify(problems)}`);
process.exit(summary.ok ? 0 : 1);
