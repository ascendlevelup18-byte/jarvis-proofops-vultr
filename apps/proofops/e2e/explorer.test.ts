// [CHROMIUM] The static Evidence Explorer, built from the sealed live runs and served as plain files under a sub-path,
// as GitHub Pages would. No control plane, no model calls, no production calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(join(ROOT, "apps/proofops/worker/package.json"));
const { chromium } = require("playwright") as any;
const axeSource = readFileSync(createRequire(join(ROOT, "package.json")).resolve("axe-core/axe.min.js"), "utf8");
const WRONG = "run_20261104154518_b6a586f4a0ec403d";
const CORRECT = "run_20261104154509_8ec3eec5addfeed1";
const SUB = "/jarvis-proofops-vultr/";
let work: string;
let site: string;
let server: Server;
let base: string;
let browser: any;

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".md": "text/markdown", ".jsonl": "application/x-ndjson" };
function serve(root: string): Promise<Server> {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (!path.startsWith(SUB)) { res.writeHead(404).end(); return; }
    const rel = path.slice(SUB.length) || "index.html";
    const full = normalize(join(root, rel));
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    createReadStream(full).pipe(res);
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}${SUB}`;

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-explorer-"));
  site = join(work, "site");
  const r = spawnSync(process.execPath, ["apps/proofops/src/build-explorer.ts", "--out", site], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  server = await serve(site);
  base = urlOf(server);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

async function open(width: number, height: number, hash = "", at = base, opts: Record<string, unknown> = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("request", (q: any) => requests.push(q.url()));
  await page.goto(at + hash);
  await page.waitForSelector(".run-row");
  return { ctx, page, errors, requests };
}
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const inView = (page: any, sel: string) => page.locator(sel).evaluate((n: Element) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0; });

for (const [w, h] of [[375, 812], [768, 1024], [1366, 768], [1440, 900]] as const) {
  test(`EX-1 [CHROMIUM] the message and first action are on screen at ${w}x${h}, with no sideways scrolling`, async () => {
    const { ctx, page, errors, requests } = await open(w, h);
    assert.match(await page.locator("#hero-h").innerText(), /still be wrong/);
    assert.equal(await inView(page, "#open-wrong"), true);
    assert.equal(await noOverflow(page), true);
    await page.locator("#open-wrong").click();
    await page.waitForSelector("#evidence-detail .outcome");
    await page.waitForTimeout(300);
    assert.equal(await inView(page, "#evidence-detail .outcome-label"), true);
    assert.equal(await noOverflow(page), true);
    await page.goto(`${base}#compare/${CORRECT}/${WRONG}`);
    await page.waitForSelector("#compare-table");
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(errors, []);
    assert.ok(requests.every((u: string) => u.startsWith(base)), "called something outside the site");
    await ctx.close();
  });
}

test("EX-2 [CHROMIUM] all six runs are listed with their recorded labels, and the planner is the real model", async () => {
  const { ctx, page } = await open(1366, 768);
  const rows = await page.locator(".run-row").allInnerTexts();
  assert.equal(rows.length, 6);
  assert.match(rows[0], /Wrong discount/);
  assert.equal(await page.locator("#compare-a").inputValue(), CORRECT);
  assert.equal(await page.locator("#compare-b").inputValue(), WRONG);
  assert.equal(rows.filter((t: string) => /Verified success/.test(t)).length, 3);
  assert.equal(rows.filter((t: string) => /Designed negative test/.test(t)).length, 3);
  assert.ok(rows.every((t: string) => /Live model: deepseek-v4\.1-flash-1017 on Vultr/.test(t)));
  await ctx.close();
});

test("EX-3 [CHROMIUM] the wrong-discount run shows its recorded result, and images load", async () => {
  const { ctx, page, errors } = await open(1440, 900, `#evidence/${WRONG}`);
  await page.waitForSelector("#evidence-detail .outcome");
  const text = await page.locator("#evidence-detail").innerText();
  assert.match(text, /failed as intended/);
  assert.match(text, /\$90\.00/);
  assert.match(text, /\$95\.00/);
  assert.match(text, /checksums, not signatures/);
  assert.equal(await page.locator(".gallery img").first().evaluate((i: HTMLImageElement) => new Promise((r) => { if (i.complete) r(i.naturalWidth > 0); else { i.onload = () => r(true); i.onerror = () => r(false); i.scrollIntoView(); } })), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("EX-4 [CHROMIUM] the browser check passes on every published run, with a measured file count", async () => {
  const { ctx, page } = await open(1366, 768);
  const ids = await page.locator(".run-row").evaluateAll((a: HTMLElement[]) => a.map((x) => x.dataset.run));
  for (const id of ids) {
    await page.goto(`${base}#evidence/${id}`);
    await page.waitForSelector("#check-run");
    await page.locator("#check-run").click();
    await page.waitForSelector('#check-result[data-state="match"]', { timeout: 20_000 });
    const expected = Object.keys(JSON.parse(readFileSync(join(site, "runs", id, "manifest.json"), "utf8")).files).length;
    assert.match(await page.locator("#check-result").innerText(), new RegExp(`All ${expected} files match`));
  }
  await ctx.close();
});

test("EX-5 [CHROMIUM] flipping one byte is caught and clearly labeled as simulated, then a real check recovers", async () => {
  const { ctx, page } = await open(1366, 768, `#evidence/${WRONG}`);
  await page.waitForSelector("#check-flip");
  await page.locator("#check-flip").click();
  await page.waitForSelector('#check-result[data-state="mismatch"]');
  const r = await page.locator("#check-result").innerText();
  assert.match(r, /Simulated change detected/);
  assert.match(r, /report\.md: content changed/);
  assert.match(await page.locator("#evidence-detail .outcome").innerText(), /Simulated: evidence integrity failure/);
  assert.doesNotMatch(await page.locator("#evidence-detail .outcome").innerText(), /failed as intended|Intact/);
  await page.locator("#check-run").click();
  await page.waitForSelector('#check-result[data-state="match"]');
  assert.match(await page.locator("#evidence-detail .outcome").innerText(), /failed as intended/);
  await ctx.close();
});

for (const [name, damage, pattern] of [
  ["a changed file", (d: string) => writeFileSync(join(d, "report.md"), "edited"), /report\.md: content changed/],
  ["a missing file", (d: string) => rmSync(join(d, "assertions.json")), /assertions\.json: missing/],
  ["a changed manifest", (d: string) => writeFileSync(join(d, "manifest.json"), readFileSync(join(d, "manifest.json"), "utf8") + " "), /manifest\.json doesn't match/],
  ["a removed manifest", (d: string) => rmSync(join(d, "manifest.json")), /manifest\.json is missing/],
] as const) {
  test(`EX-6 [CHROMIUM] really damaged evidence fails the check: ${name}`, async () => {
    const copy = join(work, `damaged-${name.replaceAll(" ", "-")}`);
    cpSync(site, copy, { recursive: true });
    damage(join(copy, "runs", WRONG));
    const s = await serve(copy);
    try {
      const { ctx, page } = await open(1366, 768, `#evidence/${WRONG}`, urlOf(s));
      await page.waitForSelector("#check-run");
      await page.locator("#check-run").click();
      await page.waitForSelector('#check-result[data-state="mismatch"]');
      const text = await page.locator("#check-result").innerText();
      assert.match(text, /failed the check/);
      assert.match(text, pattern);
      assert.doesNotMatch(text, /Simulated|All \d+ files match/);
      assert.match(await page.locator("#evidence-detail .outcome").innerText(), /Evidence integrity failure/);
      await ctx.close();
    } finally { s.close(); }
  });
}

test("EX-7 [CHROMIUM] a missing or invalid run gets a plain message, not a result", async () => {
  const { ctx, page } = await open(1366, 768, "#evidence/run_20260101000000_00000000");
  await page.waitForFunction(() => /no record|couldn't be loaded/.test(document.getElementById("evidence-detail")!.textContent ?? ""));
  await page.goto(`${base}#evidence/nonsense`);
  await page.waitForFunction(() => /isn't a valid run id/.test(document.getElementById("evidence-detail")!.textContent ?? ""));
  await ctx.close();
});

test("EX-8 [CHROMIUM] the site is published without the control plane, secrets or the wider repository", async () => {
  const listing = spawnSync("git", ["-C", ROOT, "grep", "-c", "PROOFOPS_INFERENCE_API_KEY", "--", "apps/proofops/explorer"], { encoding: "utf8" });
  assert.equal(listing.status, 1);
  assert.equal(existsSync(join(site, "app.js")), false);
  assert.equal(existsSync(join(site, "ANCHORS.txt")), false);
  const { ctx, page } = await open(1366, 768);
  assert.match(await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content"), /default-src 'self'/);
  const hrefs = await page.locator("a[href^='http']").evaluateAll((a: HTMLAnchorElement[]) => a.map((x) => new URL(x.href).host));
  assert.deepEqual([...new Set(hrefs)].sort(), ["45-63-82-115.sslip.io", "github.com", "lablab.build"]);
  await ctx.close();
});

for (const [name, hash] of [["home", ""], ["run", `#evidence/${WRONG}`], ["comparison", `#compare/${CORRECT}/${WRONG}`]] as const) {
  test(`EX-9 [CHROMIUM] automated accessibility check has no serious issue on the ${name} view`, async () => {
    const { ctx, page } = await open(1366, 768, hash, base, { bypassCSP: true, reducedMotion: "reduce" });
    if (hash) await page.waitForSelector(hash.startsWith("#compare") ? "#compare-table" : "#check-run");
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      const r = await (window as any).axe.run({ resultTypes: ["violations"] });
      return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => `${v.id}: ${v.nodes.slice(0, 3).map((n: any) => n.target.join(" ")).join(", ")}`);
    });
    assert.deepEqual(res, []);
    await ctx.close();
  });
}
