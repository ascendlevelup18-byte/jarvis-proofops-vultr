// Browser check of the AI Team prototype (#/ai-team) against a RUNNING app (same setup as judge-mode.e2e.mjs).
//   PW_CORE=... CHROME=... BASE_URL=... node apps/web/e2e/ai-team.e2e.mjs [screenshot-dir]
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PW_CORE ?? "playwright-core");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:43123";
const OUT = process.argv[2] ?? null;
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
const open = async (viewport) => {
  const ctx = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("jarvis.setup.v1", JSON.stringify({ modules: ["refunds"] })));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const posts = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => r.method() !== "GET" && posts.push(r.url()));
  await page.goto(`${BASE}/#/ai-team`);
  await page.getByRole("heading", { name: "Six specialists, one accountable plan." }).waitFor();
  return { page, ctx, errors, posts };
};

try {
  const { page, ctx, errors, posts } = await open({ width: 1366, height: 900 });

  await check("labels say fixture rules, synthetic data and single local user", async () => {
    for (const t of ["Fixture specialists: deterministic rules, no language model", "Synthetic data · fictional store · not real merchant records", "Single local user · stored in this browser only"])
      await page.getByText(t, { exact: true }).waitFor();
  });

  await check("directory lists six specialists with role versions", async () => {
    assert.equal(await page.locator(".team-card").count(), 6);
    for (const v of ["ceo@1.0.0", "cfo@1.0.0", "sales@1.0.0", "cmo@1.0.0", "coo@1.0.0", "hr@1.0.0"]) await page.getByText(new RegExp(v)).waitFor();
  });

  await check("private chat answers with cited evidence, labels human and AI, and survives a reload", async () => {
    await page.getByRole("button", { name: "Open private chat with CFO" }).click();
    await page.getByLabel("Message to CFO · Finance").fill("Why is our margin falling?");
    await page.keyboard.press("Enter");
    await page.getByText("(CFO, fixture rules over synthetic data; not a language model.)").waitFor();
    const log = await page.getByRole("log").innerText();
    assert.match(log, /You \(human\)/);
    assert.match(log, /CFO \(AI specialist, fixture\)/);
    assert.match(log, /evidence: .*margin_bridge/);
    await page.reload();
    await page.getByRole("tab", { name: "Private chats" }).click();
    await page.getByText("Why is our margin falling?").waitFor();
    if (OUT) await page.screenshot({ path: `${OUT}/ai-team-chat.png` });
  });

  await check("a COO chat does not contain the CFO conversation", async () => {
    await page.getByLabel("Specialist").selectOption("coo");
    assert.equal(await page.getByRole("log").locator(".msg").count(), 0);
  });

  await check("boardroom: shared message is used, report has every section, conflict shown, approvals record but execute nothing", async () => {
    await page.getByLabel("Specialist").selectOption("cfo");
    await page.locator(".msg-ai").first().getByRole("button", { name: "Share to boardroom" }).click();
    await page.getByRole("tab", { name: "Executive boardroom" }).click();
    await page.getByText(/1 message\(s\) you shared/).waitFor();
    await page.getByRole("button", { name: "Convene the team" }).click();
    await page.getByRole("heading", { name: "Executive report" }).waitFor({ timeout: 20000 });
    const report = await page.getByLabel("Executive report").innerText();
    for (const h of [/executive diagnosis/i, /key hypotheses/i, /disagreements/i, /recommended actions/i, /expected impact/i, /risks/i, /30-day plan/i, /human decisions required/i, /shared from your private chats/i])
      assert.match(report, h);
    assert.match(report, /marketingSpend/);
    await page.getByRole("button", { name: "Approve for follow-up" }).first().click();
    await page.getByText("approved by you").waitFor();
    await page.getByText(/Audit trail/).click();
    assert.match(await page.getByLabel("Executive report").innerText(), /OWNER_APPROVED .*JARVIS executed nothing/);
    if (OUT) await page.screenshot({ path: `${OUT}/ai-team-boardroom.png`, fullPage: true });
  });

  await check("mission: a refund recommendation hands one canonical case to JARVIS; policy and read-back decide; provenance from the case audit", async () => {
    await page.getByRole("button", { name: "Hand to JARVIS: open a refund investigation" }).first().click();
    await page.getByText(/Illustrative link/).waitFor();
    await page.getByRole("button", { name: "Run JARVIS investigation" }).click();
    const panel = page.locator(".team-mission");
    await panel.getByText("RESOLVED · read-back verified").waitFor({ timeout: 30000 });
    const t = await panel.innerText();
    assert.match(t, /APPROVE/);
    assert.match(t, /89\.99 USD \(simulated\)/);
    assert.match(t, /DETERMINISTIC FIXTURE · no model call/);
    if (OUT) await page.screenshot({ path: `${OUT}/ai-team-mission.png`, fullPage: true });
    await panel.getByRole("button", { name: "Open the full investigation and audit trail" }).click();
    await page.waitForFunction(() => location.hash.startsWith("#/case/"));
    await page.goto(`${BASE}/#/ai-team`);
    await page.getByRole("heading", { name: "Six specialists, one accountable plan." }).waitFor();
  });

  await check("malicious HTML in a chat message is shown as text, never executed", async () => {
    let dialog = false;
    page.on("dialog", (d) => ((dialog = true), d.dismiss()));
    await page.getByRole("tab", { name: "Private chats" }).click();
    await page.getByLabel("Specialist").selectOption("hr");
    await page.getByLabel(/Message to HR/).fill("<img src=x onerror=alert(1)><script>alert(2)</script>");
    await page.keyboard.press("Enter");
    await page.getByText("<img src=x onerror=alert(1)><script>alert(2)</script>").waitFor();
    assert.equal(await page.getByRole("log").locator("img, script").count(), 0);
    assert.equal(dialog, false);
    await page.getByRole("tab", { name: "Executive boardroom" }).click();
  });

  await check("cancel stops the run and says so", async () => {
    await page.getByRole("button", { name: "Convene the team" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByText(/Cancelled by you; partial report/).waitFor({ timeout: 20000 });
  });

  await check("keyboard: tabs and the convene button are reachable with Tab", async () => {
    await page.reload();
    await page.getByRole("tab", { name: "Executive directory" }).waitFor();
    const seen = new Set();
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press("Tab");
      seen.add(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    for (const label of ["Executive directory", "Private chats", "Executive boardroom", "Open private chat with CEO"]) assert.ok([...seen].includes(label), label);
  });

  await check("the only write is the one human-started JARVIS case (POST /cases); the team itself writes nothing", async () => assert.deepEqual(posts.map((u) => new URL(u).pathname), ["/cases"]));
  await check("no console errors on desktop", async () => assert.deepEqual(errors, []));
  await ctx.close();

  const phone = await open({ width: 375, height: 812 });
  await check("phone width: directory, chat and boardroom fit without horizontal scroll", async () => {
    for (const tab of ["Executive directory", "Private chats", "Executive boardroom"]) {
      await phone.page.getByRole("tab", { name: tab }).click();
      if (tab === "Executive boardroom") {
        await phone.page.getByRole("button", { name: "Convene the team" }).click();
        await phone.page.getByRole("heading", { name: "Executive report" }).waitFor({ timeout: 20000 });
      }
      const { doc, win } = await phone.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(doc <= win, `${tab}: page is ${doc}px wide in a ${win}px viewport`);
    }
    if (OUT) await phone.page.screenshot({ path: `${OUT}/ai-team-phone.png` });
  });
  await check("no console errors on phone", async () => assert.deepEqual(phone.errors, []));
  await phone.ctx.close();
} finally {
  await browser.close();
}

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} AI Team checks passed`);
process.exit(failed ? 1 : 0);
