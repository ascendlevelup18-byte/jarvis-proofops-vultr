// Judge Mode under failure and impatience, against a RUNNING app with the real fixture API (same setup as judge-mode.e2e.mjs).
// Failures are injected in the browser with request routing; the API and gateway are never modified.
//   PW_CORE=... CHROME=... BASE_URL=... node apps/web/e2e/judge-reliability.e2e.mjs
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PW_CORE ?? "playwright-core");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:43123";
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
const open = async (setup) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("jarvis.setup.v1", JSON.stringify({ modules: ["refunds"] })));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const posts = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/cases") && posts.push(r.url()));
  if (setup) await setup(page);
  await page.goto(`${BASE}/#/judge`);
  await page.getByRole("heading", { name: "Verify JARVIS in two minutes." }).waitFor();
  return { page, ctx, posts };
};
const card = (page, order) => page.locator(".verdict", { hasText: `Order #${order}` });

try {
  await check("double-clicking Run all four sends each scenario exactly once", async () => {
    const { page, ctx, posts } = await open();
    const run = page.getByRole("button", { name: "Run all four" });
    await run.and(page.locator(":enabled")).waitFor();
    await run.dblclick();
    await run.click({ force: true, timeout: 2000 }).catch(() => {});
    await page.getByRole("button", { name: "Run again" }).waitFor();
    assert.equal(posts.length, 4, `${posts.length} POST /cases`);
    await ctx.close();
  });

  await check("a failed scenario shows its error, the others finish, and a rerun recovers", async () => {
    let failNext = true;
    const { page, ctx } = await open((p) =>
      p.route("**/cases", async (route) => {
        if (route.request().method() === "POST" && failNext) {
          failNext = false;
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
        }
        return route.continue();
      }),
    );
    await page.getByRole("button", { name: "Run all four" }).and(page.locator(":enabled")).click();
    await card(page, "48294").getByText("Needs review").waitFor();
    assert.match(await card(page, "48291").innerText(), /503/);
    assert.doesNotMatch(await card(page, "48291").innerText(), /\$89\.99 simulated/);
    await page.getByRole("button", { name: "Run all four" }).and(page.locator(":enabled")).click();
    await page.getByRole("button", { name: "Run again" }).waitFor();
    assert.match(await card(page, "48291").innerText(), /\$89\.99 simulated/);
    await ctx.close();
  });

  await check("an unreachable health check blocks every request and says why", async () => {
    const { page, ctx, posts } = await open((p) => p.route("**/api/health", (route) => route.abort()));
    await page.getByText("API not reachable", { exact: true }).waitFor();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "Run all four" }).isDisabled(), true);
    assert.equal(posts.length, 0);
    await ctx.close();
  });

  await check("a health answer that is not fixture with simulated payments blocks requests", async () => {
    const live = { ok: true, aiMode: "vllm", remoteModel: true, paymentGateway: "simulated", data: "synthetic" };
    const { page, ctx, posts } = await open((p) => p.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(live) })));
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "Run all four" }).isDisabled(), true);
    assert.equal(posts.length, 0);
    await ctx.close();
  });

  await check("stress lab: the detail always shows a case from the filtered list", async () => {
    const { page, ctx } = await open();
    const lab = page.locator("#judge-stress-lab");
    await lab.locator("summary").click();
    await lab.locator(".stress-row", { hasText: "DC-S01" }).click();
    await lab.getByLabel(/Only cases unsafe without policy/).check();
    await lab.getByText("18 of 30 shown").waitFor();
    const pressed = lab.locator('.stress-row[aria-pressed="true"]');
    assert.equal(await pressed.count(), 1);
    const id = (await pressed.innerText()).trim().split(/\s/)[0];
    assert.match(await lab.locator(".stress-detail").innerText(), new RegExp(id));
    await lab.getByLabel("Category").selectOption("STRAIGHTFORWARD");
    await lab.getByText("0 of 30 shown").waitFor();
    assert.equal(await lab.locator(".stress-detail").count(), 0);
    await ctx.close();
  });
  await check("impact studio: out-of-range input states the value used and keeps results finite", async () => {
    const { page, ctx } = await open();
    const s = page.locator("#judge-impact");
    await s.getByLabel("Closed by JARVIS with no human").fill("250");
    await s.getByText("Above 100; using 100.").waitFor();
    await s.getByLabel("Duplicate-charge tickets per month").fill("999999999");
    await s.getByText(/Above 10,000,000; using 10,000,000/).waitFor();
    assert.doesNotMatch(await s.innerText(), /NaN|Infinity/);
    assert.match(await s.innerText(), /× 100% ×/);
    assert.doesNotMatch(await s.innerText(), /250%/);
    await ctx.close();
  });
} finally {
  await browser.close();
}

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} Judge reliability checks passed`);
process.exit(failed ? 1 : 0);
