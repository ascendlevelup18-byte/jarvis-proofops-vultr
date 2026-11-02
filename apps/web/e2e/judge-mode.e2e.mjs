// Browser check of Judge Mode (#/judge) against a RUNNING app with the real fixture API:
// three outcomes, inspectable proof, the recorded AMD replay, keyboard use, and phone width.
// Run like proof-mode.e2e.mjs: PW_CORE=... CHROME=... node apps/web/e2e/judge-mode.e2e.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PW_CORE ?? "playwright-core");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:43123";
const OUT = process.argv[2] ?? null;
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--disable-background-networking"] });
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", `${name}: ${e.message.split("\n")[0]}`]);
  }
};
const shot = async (page, file) => OUT && page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
const open = async (viewport, reducedMotion = "reduce") => {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => localStorage.setItem("jarvis.setup.v1", JSON.stringify({ modules: ["refunds"] })));
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/judge`);
  await page.getByRole("heading", { name: "Verify JARVIS in two minutes." }).waitFor();
  return { page, errors };
};
const card = (page, order) => page.locator(".verdict", { hasText: `Order #${order}` });

try {
  const { page, errors } = await open({ width: 1440, height: 900 });

  await check("truth labels are visible before anything runs", async () => {
    for (const label of ["Fixture AI runtime", "Payments simulated · no real money", "AMD run: recorded, not live"]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
  });

  await check("the recorded AMD run is labelled recorded and shows the evidence values", async () => {
    await page.getByText("Recorded AMD-hosted inference — October 14, 2026 — not a live model call").waitFor();
    const amd = page.locator("#judge-amd");
    for (const text of ["self-dploy/DeepSeek-V4-Flash", "17/17 passed", "20/20", "26/30"]) assert.ok((await amd.innerText()).includes(text), text);
    await amd.getByText(/All 17 recorded checks/).click();
    assert.match(await amd.innerText(), /16 events · AI calls, policy \+ pre-execution revalidation, gateway, read-back/);
  });

  await check("Run all four: verified refund, blocked demand, no second refund, contradicted amount", async () => {
    await page.getByRole("button", { name: "Run all four" }).click();
    await page.getByRole("button", { name: "Run again" }).waitFor();
    const r1 = await card(page, "48291").innerText();
    assert.match(r1, /\$89\.99 simulated/);
    assert.match(r1, /APPROVE/);
    assert.match(r1, /read-back verified/);
    const r2 = await card(page, "48294").innerText();
    assert.match(r2, /DENY/);
    assert.match(r2, /\$0\.00/);
    assert.match(r2, /nothing executed/);
    const r3 = await card(page, "48293").innerText();
    assert.match(r3, /NO_ACTION/);
    assert.match(r3, /\$0\.00/);
    const r4 = await card(page, "48292").innerText();
    assert.match(r4, /ESCALATED/);
    assert.match(r4, /DENY/);
    assert.match(r4, /nothing executed/);
  });

  await check("Inspect why shows the policy explanation and proof chain for the blocked case", async () => {
    await card(page, "48294").getByRole("button", { name: "Inspect why" }).click();
    const proof = page.locator("#judge-proof");
    await proof.getByRole("heading", { name: "Proof chain" }).waitFor();
    assert.match(await proof.innerText(), /48294/);
  });

  await check("proof-chain Details opens the case's own evidence, never the dashboard", async () => {
    await page.locator("#judge-proof").getByRole("link", { name: /^Step 3: Evidence/ }).click();
    await page.locator("#evidence-panel").waitFor();
    const hash = await page.evaluate(() => location.hash);
    assert.ok(!hash.includes("dashboard"), `navigated to ${hash}`);
    assert.match(await page.locator("body").innerText(), /48294/);
    await page.goto(`${BASE}/#/judge`);
    await page.getByRole("heading", { name: "Verify JARVIS in two minutes." }).waitFor();
  });

  await check("keyboard: the run button and section links are reachable with Tab", async () => {
    await page.reload();
    await page.getByRole("button", { name: "Run all four" }).and(page.locator(":enabled")).waitFor();
    const seen = new Set();
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press("Tab");
      seen.add(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    for (const label of ["1 · Four outcomes", "4 · Recorded AMD run", "Run all four"]) assert.ok([...seen].some((s) => s.startsWith(label)), label);
  });

  await check("reduced motion: the replay shows every recorded call at once", async () => {
    await page.getByRole("button", { name: "Replay recorded calls" }).click();
    assert.equal(await page.locator(".amd-timeline li").count(), 6);
  });

  await check("stress lab: 30 cases, unsafe filter shows 18, a case explains both columns, keyboard opens it", async () => {
    const lab = page.locator("#judge-stress-lab");
    await lab.locator("summary").focus();
    await page.keyboard.press("Enter");
    await lab.getByText("30 of 30 shown").waitFor();
    await lab.getByLabel(/Only cases unsafe without policy/).check();
    await lab.getByText("18 of 30 shown").waitFor();
    await lab.getByRole("button", { name: /DC-A05/ }).click();
    const detail = await lab.locator(".stress-detail").innerText();
    assert.match(detail, /DC-A05/);
    assert.match(detail, /with jarvis policy/i);
    assert.match(detail, /counterfactual, never executed/);
    assert.match(await lab.innerText(), /not an AMD or real-model result/);
    await shot(page, "judge-stress-lab.png");
  });

  await check("merchant impact studio: defaults match the business case, edits recompute, labelled a hypothesis", async () => {
    const s = page.locator("#judge-impact");
    await s.scrollIntoViewIfNeeded();
    assert.match(await s.innerText(), /16 h/);
    assert.match(await s.innerText(), /\$560/);
    await s.getByLabel("Duplicate-charge tickets per month").fill("2000");
    await s.getByLabel("Closed by JARVIS with no human").fill("50");
    await s.getByText("133.3 h").waitFor();
    assert.match(await s.innerText(), /not observed savings or ROI/);
    assert.match(await s.innerText(), /model cost not included/i);
    assert.match(await s.innerText(), /has not been measured/);
    await shot(page, "judge-impact.png");
  });

  await check("no console errors on desktop", async () => assert.deepEqual(errors, []));
  await shot(page, "judge-desktop.png");

  const phone = await open({ width: 375, height: 812 });
  await check("phone width: no horizontal page scroll", async () => {
    await phone.page.getByRole("button", { name: "Run all four" }).click();
    await phone.page.getByRole("button", { name: "Run again" }).waitFor();
    await phone.page.locator("#judge-stress-lab summary").click();
    await phone.page.locator("#judge-stress-lab .stress-detail").waitFor();
    const { doc, win } = await phone.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    assert.ok(doc <= win, `page is ${doc}px wide in a ${win}px viewport`);
  });
  await check("no console errors on phone", async () => assert.deepEqual(phone.errors, []));
  await shot(phone.page, "judge-phone.png");
} finally {
  await browser.close();
}

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} Judge Mode checks passed`);
process.exit(failed ? 1 : 0);
