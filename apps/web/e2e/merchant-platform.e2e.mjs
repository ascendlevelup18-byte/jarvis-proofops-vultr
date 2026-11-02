// Browser check of the JARVIS Automations vertical slice against a RUNNING app (real API).
// onboarding → connect demo store → storefront order lookup → refund request → real case →
// merchant sees it (Automations, Approvals, investigation) → unsafe request escalates.
// Run like proof-mode.e2e.mjs: PW_CORE=... CHROME=... node apps/web/e2e/merchant-platform.e2e.mjs [screenshot-dir]
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

async function requestFromStore(page, orderNumber) {
  await page.getByLabel("Order number").fill(orderNumber);
  await page.getByRole("button", { name: "Find order" }).click();
  await page.getByRole("article", { name: `Order ${orderNumber.replace("#", "")}` }).getByRole("button", { name: "Request a refund" }).click();
  await page.getByRole("button", { name: new RegExp(`Send for order #${orderNumber.replace("#", "")}`) }).click();
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  // Since the 16 Oct redesign a first visit opens Home; setup is the #setup route.
  await page.goto(`${BASE}/#setup`);

  await check("first run shows onboarding; only Refunds is operational", async () => {
    await page.getByRole("heading", { name: "What do you want to automate?" }).waitFor();
    const fieldset = page.getByRole("group", { name: "Automation modules" });
    assert.equal(await fieldset.getByText("Operational", { exact: true }).count(), 1);
    assert.equal(await fieldset.getByText("Preview", { exact: true }).count(), 5);
    await page.getByLabel(/Inventory alerts/).check();
  });
  await shot(page, "m01-onboarding.png", false);

  await check("connect your store: real domains are not connectable; demo store loads the backend seed", async () => {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Connect your store" }).waitFor();
    await page.getByLabel("Your store domain").fill("myshop.example.com");
    await page.getByText(/Store integrations are not available yet/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Coming soon" }).isDisabled(), true);
    await page.getByRole("button", { name: "Connect demo store" }).click();
    await page.getByText(/Connected: Northwind Goods \(demo\) · 4 orders read from the backend/).waitFor();
  });
  await shot(page, "m02-connect-store.png", false);

  await check("setup opens Home; the automation catalog shows the setup choices", async () => {
    await page.getByRole("button", { name: "Open command center" }).click();
    await page.getByRole("heading", { name: "Welcome back." }).waitFor();
    // The catalog lives under the sidebar's collapsed "Demo & advanced tools" since the redesign.
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByText("Demo & advanced tools").click();
    await nav.getByRole("button", { name: "Automation catalog", exact: true }).click();
    await page.getByRole("heading", { name: "Automation catalog", exact: true }).waitFor();
    assert.equal(await page.getByText("Selected in setup").count(), 2);
  });

  await check("storefront: valid duplicate → real case RESOLVED → customer told refund issued (simulated)", async () => {
    // "Open demo store" moved into the merchant profile menu.
    await page.getByLabel("Merchant profile").click();
    await page.getByRole("button", { name: "Open demo store" }).click();
    await page.getByText("Demo storefront · synthetic data · simulated payments").waitFor();
    await requestFromStore(page, "48291");
    const reply = page.getByText("Refund of $89.99 issued");
    await reply.waitFor({ timeout: 10000 });
    await page.getByText(/payment is simulated/).waitFor();
  });
  await shot(page, "m03-store-refund.png");

  await check("storefront: hostile request (#48294) escalates; customer told no refund was made", async () => {
    await page.getByLabel("Order number").fill("");
    await requestFromStore(page, "#48294");
    await page.getByText("Passed to our team for review").waitFor({ timeout: 10000 });
    assert.ok((await page.getByText("No refund has been made yet").count()) >= 1);
  });
  await shot(page, "m04-store-escalation.png");

  await check("free text is visibly disabled in the public demo", async () => {
    assert.equal(await page.getByLabel("Write your own message").isDisabled(), true);
  });

  await check("merchant sees the store cases: investigation, approvals, analytics", async () => {
    // The storefront no longer links customers to the merchant investigation; the merchant opens it from Approvals.
    await page.getByRole("button", { name: /Merchant command center/ }).click();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("button", { name: "Approvals" }).click();
    await page.getByText("from demo store").first().waitFor();
    await page.getByRole("row", { name: /#48294/ }).getByRole("button", { name: "Review evidence" }).click();
    await page.getByRole("heading", { name: "Why JARVIS refused to refund" }).waitFor();
    await page.getByText("Demo store · order #48294").first().waitFor();
    await page.getByRole("button", { name: /Back to / }).click();
    await nav.getByRole("button", { name: "Analytics" }).click();
    const cases = page.locator("dt", { hasText: /^Recorded cases$/ }).locator("xpath=following-sibling::dd").first();
    assert.equal(await cases.innerText(), "2");
    await page.getByRole("region", { name: "Support activity" }).getByText("Customer requests from the demo store").waitFor();
  });
  await shot(page, "m05-merchant-analytics.png");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, reducedMotion: "reduce" });
  mobile.setDefaultTimeout(8000);
  await mobile.goto(`${BASE}/#store`);
  await check("mobile storefront: refund flow works without horizontal scroll", async () => {
    await requestFromStore(mobile, "48293");
    await mobile.getByText("No duplicate charge to refund").waitFor({ timeout: 10000 });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page overflows by ${overflow}px`);
  });
  await shot(mobile, "m06-mobile-store.png");
} finally {
  await browser.close();
}

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
