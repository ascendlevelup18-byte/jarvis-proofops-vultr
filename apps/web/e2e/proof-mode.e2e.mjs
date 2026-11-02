// Browser end-to-end check of Proof Mode against a RUNNING app (real API, real engine).
// Not part of `npm test` (needs a browser). Run:
//   PORT=3000 npm run api:start &            # fixture mode
//   npm run web:dev &                        # http://127.0.0.1:43123
//   PW_CORE=<path to playwright-core> CHROME=<chromium binary> node apps/web/e2e/proof-mode.e2e.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PW_CORE ?? "playwright-core");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:43123";
const OUT = process.argv[2] ?? null;
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--no-sandbox", "--disable-background-networking", "--disable-component-update"],
});
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", `${name}: ${e.message.split("\n")[0]}`]);
  }
};
const shot = async (page, file, fullPage = true) => OUT && page.screenshot({ path: `${OUT}/${file}`, fullPage });

// Proof Mode and AI provider live under the sidebar's collapsed "Demo & advanced tools" (16 Oct redesign).
async function openNav(page, label) {
  const nav = page.getByRole("navigation", { name: "Primary" });
  const button = nav.getByRole("button", { name: label, exact: true });
  if (!(await button.isVisible())) await nav.getByText("Demo & advanced tools").click();
  await button.click();
}

async function runDemo(page, title) {
  const back = page.getByRole("button", { name: /Back to / });
  if (await back.count()) await back.click();
  const scenarios = page.getByRole("group", { name: "Demo scenarios" });
  if (!(await scenarios.count())) await openNav(page, "Proof Mode");
  await scenarios.getByRole("button", { name: new RegExp(title) }).click();
  await page.getByText("Proof chain").waitFor();
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  // Skip first-run onboarding (covered by merchant-platform.e2e.mjs).
  await page.addInitScript(() => localStorage.setItem("jarvis.setup.v1", JSON.stringify({ modules: ["refunds"] })));
  await page.goto(`${BASE}/#/proof`);

  await check("runtime chips come from /api/health (fixture backend)", async () => {
    // Header chips, then the expanded connection details, all derived from /api/health.
    const bar = page.locator(".runtime-bar");
    await bar.getByText("Connected", { exact: true }).waitFor({ timeout: 5000 });
    await bar.getByText("Demo AI (fixture)").waitFor();
    await bar.getByText("Payments simulated").first().waitFor();
    await bar.getByText("Connection details").click();
    await bar.getByText("FIXTURE AI", { exact: true }).waitFor();
    await bar.getByText("AMD hardware: NOT VERIFIED").waitFor();
    await bar.getByText("Evolus: NOT CONNECTED").waitFor();
  });
  await shot(page, "01-operations.png", false);

  await check("safety showdown: two real requests, A resolves and moves $89.99, B escalates and moves $0.00", async () => {
    await page.getByRole("button", { name: "Run vs Adversarial message" }).click();
    const table = page.getByRole("table");
    await table.waitFor({ timeout: 10000 });
    const row = async (label) => (await table.getByRole("row", { name: new RegExp(`^${label}`) }).innerText()).replace(/\s+/g, " ");
    assert.match(await row("Final state"), /RESOLVED ESCALATED/);
    assert.match(await row("Money observed moving"), /\$89\.99 \$0\.00/);
    assert.match(await row("Policy outcome"), /APPROVE DENY/);
  });
  await shot(page, "02-safety-showdown.png");

  await check("valid duplicate: 7-step proof chain, refund allowed, audit trail from records", async () => {
    await runDemo(page, "Valid duplicate");
    const steps = page.getByRole("link", { name: /^Step \d: / });
    assert.equal(await steps.count(), 7);
    assert.match(await steps.nth(6).getAttribute("aria-label"), /Verification — Done\. Read-back confirmed/);
    await page.getByRole("heading", { name: "Why the refund was allowed" }).waitFor();
    const audit = page.getByRole("list", { name: "Recorded audit events" });
    assert.ok((await audit.getByRole("listitem").count()) > 10);
    await audit.getByText("Refund sent to simulated gateway").waitFor();
  });
  await shot(page, "03-investigation-resolved.png");

  await check("conflicting amount: refusal explained, execution not run, nothing presented as success", async () => {
    await runDemo(page, "Conflicting amount");
    await page.getByRole("heading", { name: "Why JARVIS refused to refund" }).waitFor();
    await page.getByText("The AI proposed a refund; deterministic policy overrode it").waitFor();
    const exec = await page.getByRole("link", { name: /^Step 6: / }).getAttribute("aria-label");
    assert.match(exec, /Not executed/);
    assert.equal(await page.getByText("RESOLVED — VERIFIED REFUND").count(), 0);
  });
  await shot(page, "04-investigation-blocked.png");

  await check("repeat: valid duplicate resolves again in a fresh world", async () => {
    await runDemo(page, "Valid duplicate");
    await page.getByRole("heading", { name: "Why the refund was allowed" }).waitFor();
  });

  await check("every button and link has an accessible name", async () => {
    const unnamed = await page.$$eval("button, a", (els) =>
      els.filter((e) => !(e.getAttribute("aria-label") || e.textContent || "").trim()).length,
    );
    assert.equal(unnamed, 0);
  });

  await check("system page: truthful labels from health", async () => {
    await page.getByRole("button", { name: /Back to / }).click();
    await openNav(page, "AI provider");
    const truth = page.locator("#system-truth");
    await truth.getByText("FIXTURE AI").waitFor({ timeout: 5000 });
    // Whatever /api/health reports for this target: NODE-SERVER locally, VERCEL in production.
    const deployment = (await (await page.request.get(`${BASE}/api/health`)).json()).deployment;
    await truth.getByText(String(deployment).toUpperCase(), { exact: true }).waitFor();
    assert.equal(await truth.getByText("NOT VERIFIED", { exact: true }).count(), 1);
    assert.equal(await truth.getByText("NOT CONNECTED", { exact: true }).count(), 1);
  });
  await shot(page, "05-system.png");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, reducedMotion: "reduce" });
  mobile.setDefaultTimeout(8000);
  await mobile.addInitScript(() => localStorage.setItem("jarvis.setup.v1", JSON.stringify({ modules: ["refunds"] })));
  await mobile.goto(`${BASE}/#/proof`);
  await check("mobile: investigation renders without horizontal page scroll", async () => {
    await runDemo(mobile, "Prompt injection");
    await mobile.getByRole("heading", { name: "Why JARVIS refused to refund" }).waitFor();
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page overflows by ${overflow}px`);
  });
  await shot(mobile, "06-mobile-injection.png");
} finally {
  await browser.close();
}

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
