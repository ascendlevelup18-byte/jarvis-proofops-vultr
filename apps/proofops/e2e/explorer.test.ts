// [CHROMIUM] The static Evidence Explorer, built from the recorded runs and served as plain files under a sub-path,
// as GitHub Pages would. No control plane, no model calls, no production calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(join(ROOT, "apps/proofops/worker/package.json"));
const { chromium } = require("playwright") as any;
const axeSource = readFileSync(createRequire(join(ROOT, "package.json")).resolve("axe-core/axe.min.js"), "utf8");
const LIVE = join(ROOT, "proof/vultr-live-20261104/runs-d14d24c");
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
    if (!path.startsWith(SUB) || req.method !== "GET") { res.writeHead(404).end(); return; }
    const rel = path.slice(SUB.length) || "index.html";
    const full = normalize(join(root, rel));
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    createReadStream(full).pipe(res);
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}${SUB}`;
const build = (out: string, ...extra: string[]) => spawnSync(process.execPath, ["apps/proofops/src/build-explorer.ts", "--out", out, ...extra], { cwd: ROOT, encoding: "utf8" });
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const treeHash = (d: string) => { const h = createHash("sha256"); for (const f of walk(d).sort()) { h.update(relative(d, f).replaceAll("\\", "/")); h.update(readFileSync(f)); } return h.digest("hex"); };

before(async () => {
  work = mkdtempSync(join(tmpdir(), "proofops-explorer-"));
  site = join(work, "site");
  const r = build(site);
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

async function open(width: number, height: number, hash = "", at = base, opts: Record<string, unknown> = {}, waitFor = "#content") {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: { url: string; method: string }[] = [];
  page.on("console", (m: any) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("request", (q: any) => requests.push({ url: q.url(), method: q.method() }));
  await page.goto(at + hash);
  await page.waitForSelector(waitFor);
  return { ctx, page, errors, requests };
}
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const verified = (page: any) => page.waitForFunction(() => /ANCHOR VERIFIED/.test(document.querySelector("#evidence-integrity .tile-value")?.textContent ?? ""), null, { timeout: 20_000 });

for (const [w, h] of [[375, 812], [768, 1024], [1366, 768], [1440, 900]] as const) {
  test(`EX-1 [CHROMIUM] story, run, comparison, library and method work at ${w}x${h}, with no sideways scrolling or outside calls`, async () => {
    const { ctx, page, errors, requests } = await open(w, h, "", base, {}, ".scenario-card");
    assert.match(await page.locator("#hero-h").innerText(), /still be wrong/);
    assert.equal(await page.locator(".recorded-flag").isVisible(), true);
    assert.match(await page.locator(".recorded-flag").innerText(), /Recorded evidence — not a live execution\./);
    assert.equal(await page.locator(".planes li").count(), 4);
    assert.equal(await noOverflow(page), true);
    for (const [hash, sel] of [[`#evidence/${WRONG}`, "#check-run"], [`#compare/${CORRECT}/${WRONG}`, "#compare-table"], ["#library", "#lib-rows tr"], ["#method", "#method-heading"]] as const) {
      await page.goto(base + hash);
      await page.waitForSelector(sel);
      assert.equal(await noOverflow(page), true, hash);
    }
    assert.deepEqual(errors, []);
    assert.ok(requests.every((q) => q.url.startsWith(base) && q.method === "GET"), "made a non-GET or left the site");
    await ctx.close();
  });
}

test("EX-2 [CHROMIUM] the signature comparison shows $90 and $95 from the recorded runs, side by side", async () => {
  const { ctx, page } = await open(1366, 768, "", base, {}, ".sig-col");
  const [a, b] = await page.locator(".sig-col").allInnerTexts();
  assert.match(a, /Correct discount[\s\S]*\$90\.00[\s\S]*PASS/i);
  assert.match(b, /Wrong discount[\s\S]*\$95\.00[\s\S]*\$90\.00 total[\s\S]*DESIGNED FAIL/i);
  assert.match(b, /Model proposals[\s\S]*finish/);
  await ctx.close();
});

test("EX-3 [CHROMIUM] six scenarios keep mission outcome and evidence integrity separate, and three aren't passes", async () => {
  const { ctx, page } = await open(1366, 768, "", base, {}, ".scenario-card");
  await page.waitForFunction(() => document.querySelectorAll(".scenario-card").length === 6 && ![...document.querySelectorAll(".scenario-card .tile-value")].some((n) => n.textContent === "Checking…"), null, { timeout: 30_000 });
  const cards = await page.locator(".scenario-card").allInnerTexts();
  assert.match(cards[0], /Wrong discount/);
  assert.equal(cards.filter((t: string) => /MISSION OUTCOME\s+PASS/i.test(t)).length, 3);
  assert.equal(cards.filter((t: string) => /MISSION OUTCOME\s+DESIGNED FAIL/i.test(t)).length, 3);
  assert.ok(cards.every((t: string) => /EVIDENCE INTEGRITY\s+ANCHOR VERIFIED/i.test(t)));
  assert.ok(cards.every((t: string) => /Live model: deepseek-v4\.1-flash-1017 on Vultr/.test(t)));
  await ctx.close();
});

test("EX-4 [CHROMIUM] every featured run passes the browser check with its measured file count", async () => {
  const { ctx, page } = await open(1366, 768, "#evidence", base, {}, ".run-row");
  const ids = await page.locator(".run-row").evaluateAll((a: HTMLElement[]) => a.map((x) => x.dataset.run));
  assert.equal(ids.length, 6);
  for (const id of ids) {
    await page.goto(`${base}#evidence/${id}`);
    await page.waitForSelector("#check-run");
    await page.waitForSelector('#check-result[data-state="match"]', { timeout: 20_000 });
    await verified(page);
    const expected = Object.keys(JSON.parse(readFileSync(join(site, "runs", id, "manifest.json"), "utf8")).files).length;
    assert.match(await page.locator("#check-result").innerText(), new RegExp(`All ${expected} files match`));
  }
  await ctx.close();
});

test("EX-5 [CHROMIUM] the simulation shows a real hash mismatch, is labeled educational, and Reset restores the real result", async () => {
  const before = treeHash(site);
  const { ctx, page, requests } = await open(1366, 768, `#evidence/${WRONG}`, base, {}, "#check-flip");
  await verified(page);
  assert.equal(await page.locator("#check-reset").isVisible(), false);
  assert.match(await page.locator("#check-flip").innerText(), /Simulate a one-byte evidence change/);
  await page.locator("#check-flip").click();
  await page.waitForSelector('#check-result[data-state="mismatch"]');
  const r = await page.locator("#check-result").innerText();
  assert.match(r, /Educational simulation/);
  assert.match(r, /report\.md/);
  assert.match(r, /isn't an attack on the VM/);
  const hashes = await page.locator("#check-result dd.mono").allInnerTexts();
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], hashes[1]);
  assert.match(await page.locator("#evidence-integrity").innerText(), /TAMPERED \(simulated\)/);
  assert.match(await page.locator("#mission-outcome").innerText(), /DESIGNED FAIL/); // the mission result doesn't change
  assert.match(await page.locator("#evidence-detail .outcome").innerText(), /Simulated: evidence integrity failure/);
  await page.locator("#check-reset").click();
  await page.waitForSelector('#check-result[data-state="match"]');
  await verified(page);
  assert.match(await page.locator("#evidence-detail .outcome").innerText(), /failed as intended/);
  assert.ok(requests.every((q) => q.method === "GET"));
  assert.equal(treeHash(site), before, "a published file changed");
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
      const { ctx, page } = await open(1366, 768, `#evidence/${WRONG}`, urlOf(s), {}, "#check-run");
      await page.waitForSelector('#check-result[data-state="mismatch"]');
      const text = await page.locator("#check-result").innerText();
      assert.match(text, /failed the check/);
      assert.match(text, pattern);
      assert.doesNotMatch(text, /simulation|All \d+ files match/i);
      assert.match(await page.locator("#evidence-integrity").innerText(), /TAMPERED/);
      assert.doesNotMatch(await page.locator("#evidence-integrity").innerText(), /simulated/);
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

test("EX-8 [CHROMIUM] the library shows all 31 bundles with the recorded tally, and search and filters work", async () => {
  const { ctx, page } = await open(1366, 768, "#library", base, {}, "#lib-rows tr");
  assert.equal(await page.locator("#lib-rows tr").count(), 31);
  const tally = await page.locator("#lib-tally").innerText();
  assert.match(tally, /31 bundles: 16 PASS, 14 designed FAIL, 0 other FAIL, 1 INCOMPLETE, 0 TAMPERED/);
  assert.match(tally, /7 older bundles have no separately recorded anchor/);
  await page.selectOption("#lib-outcome", "INCOMPLETE");
  assert.equal(await page.locator("#lib-rows tr").count(), 1);
  assert.match(await page.locator("#lib-rows").innerText(), /teardown not proven/);
  await page.selectOption("#lib-outcome", "");
  await page.selectOption("#lib-integrity", "NO ANCHOR");
  assert.equal(await page.locator("#lib-rows tr").count(), 7);
  await page.selectOption("#lib-integrity", "");
  await page.fill("#lib-search", "forced");
  assert.equal(await page.locator("#lib-rows tr").count(), 1);
  assert.match(await page.locator("#lib-rows").innerText(), /Scripted forced-proposal test/);
  await page.fill("#lib-search", "no such bundle");
  assert.equal(await page.locator("#lib-empty").isVisible(), true);
  const hrefs = await page.evaluate(async () => (await (await fetch("data/library.json")).json()).map((r: any) => r.path));
  assert.equal(new Set(hrefs).size, 31);
  for (const p of hrefs) assert.ok(existsSync(join(ROOT, "proof", p)), p);
  await ctx.close();
});

test("EX-9 [CHROMIUM] the method page states the mechanism and limits exactly", async () => {
  const { ctx, page } = await open(1366, 768, "#method", base, {}, "#method-heading");
  const t = await page.locator("#view-method").innerText();
  for (const re of [/Unkeyed SHA-256 file checksums/, /No HMAC/, /No KMS signature/, /No off-host immutable attestation/, /rewrite both the files and the anchor/, /d14d24c/, /35e201d/, /live model didn't make those proposals/]) assert.match(t, re);
  await ctx.close();
});

test("EX-10 [CHROMIUM] keyboard users can reach navigation and the check, with visible focus", async () => {
  const { ctx, page } = await open(1366, 768, "", base, {}, ".scenario-card");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "skip");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Story");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "solid");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#view-runs:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "evidence-heading");
  await page.goto(`${base}#evidence/${WRONG}`);
  await page.waitForSelector("#check-flip");
  await verified(page);
  await page.locator("#check-flip").focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('#check-result[data-state="mismatch"]');
  assert.equal(await page.evaluate(() => document.activeElement?.id), "check-flip");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "check-reset");
  await page.keyboard.press("Enter");
  await page.waitForSelector('#check-result[data-state="match"]');
  await verified(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "check-run");
  await ctx.close();
});

test("EX-11 [CHROMIUM] reduced-motion users get no animation", async () => {
  const { ctx, page } = await open(1366, 768, "", base, { reducedMotion: "reduce" }, ".scenario-card");
  assert.equal(await page.locator(".scenario-card").first().evaluate((n: Element) => getComputedStyle(n).transitionDuration), "0s");
  await ctx.close();
});

for (const [name, hash, wait] of [["story", "", ".sig-col"], ["run", `#evidence/${WRONG}`, "#check-result[data-state='match']"], ["comparison", `#compare/${CORRECT}/${WRONG}`, "#compare-table"], ["library", "#library", "#lib-rows tr"], ["method", "#method", "#method-heading"]] as const) {
  test(`EX-12 [CHROMIUM] automated accessibility check has no serious issue on the ${name} view`, async () => {
    const { ctx, page } = await open(1366, 768, hash, base, { bypassCSP: true, reducedMotion: "reduce" }, wait);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      const r = await (window as any).axe.run({ resultTypes: ["violations"] });
      return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => `${v.id}: ${v.nodes.slice(0, 3).map((n: any) => n.target.join(" ")).join(", ")}`);
    });
    assert.deepEqual(res, []);
    await ctx.close();
  });
}

/** A proof tree whose recorded text is hostile, with manifest and anchors recomputed so the bundle stays consistent. */
function hostileProof(edit: (bundle: string) => void): string {
  const proof = mkdtempSync(join(work, "hostile-"));
  const set = join(proof, "vultr-live-20261104/runs-d14d24c");
  mkdirSync(set, { recursive: true });
  cpSync(join(LIVE, WRONG), join(set, WRONG), { recursive: true });
  cpSync(join(LIVE, CORRECT), join(set, CORRECT), { recursive: true });
  const bundle = join(set, WRONG);
  edit(bundle);
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const m = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
  for (const rel of Object.keys(m.files)) if (existsSync(join(bundle, rel))) m.files[rel] = sha(readFileSync(join(bundle, rel)));
  const text = JSON.stringify(m, null, 2);
  writeFileSync(join(bundle, "manifest.json"), text);
  const anchors = readFileSync(join(LIVE, "ANCHORS.txt"), "utf8").split("\n").filter((l) => l.startsWith(CORRECT));
  writeFileSync(join(set, "ANCHORS.txt"), [...anchors, `${WRONG} ${sha(text)}`].join("\n"));
  return proof;
}
const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

test("EX-13 [CHROMIUM] hostile text in evidence stays text: no script runs, no element is created, no unsafe link appears", async () => {
  const proof = hostileProof((b) => {
    const decisions = readFileSync(join(b, "policy-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    decisions[0].proposal.reason = XSS;
    decisions[0].result = "javascript:window.__pwned=3";
    decisions.at(-1).proposal.note = XSS;
    decisions[1].decision = { decision: "deny", rule: `<b onmouseover=window.__pwned=4>x</b>`, detail: "x" };
    writeFileSync(join(b, "policy-decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n"));
    const gw = readFileSync(join(b, "gateway.jsonl"), "utf8").trim().split("\n");
    gw.push(JSON.stringify({ decision: "deny", reason: XSS, method: "GET", target: "javascript:window.__pwned=5" }));
    writeFileSync(join(b, "gateway.jsonl"), gw.join("\n"));
  });
  const out = join(work, "hostile-site");
  const r = build(out, "--proof", proof, "--featured", "vultr-live-20261104/runs-d14d24c");
  assert.equal(r.status, 0, r.stderr);
  const s = await serve(out);
  try {
    const { ctx, page, errors } = await open(1366, 768, `#evidence/${WRONG}`, urlOf(s), {}, "#check-result[data-state='match']");
    const text = await page.locator("#evidence-detail").innerText();
    assert.ok(text.includes('<img src=x onerror="window.__pwned=1">'), "hostile text should show literally");
    const state = await page.evaluate(() => ({
      pwned: (window as any).__pwned,
      injected: document.querySelectorAll("#evidence-detail img[src='x'], #evidence-detail script, #evidence-detail [onerror], #evidence-detail [onmouseover]").length,
      bad: [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).protocol).filter((p) => p !== "http:" && p !== "https:"),
    }));
    assert.equal(state.pwned, undefined);
    assert.equal(state.injected, 0);
    assert.deepEqual(state.bad, []);
    await page.goto(`${urlOf(s)}#compare/${CORRECT}/${WRONG}`);
    await page.waitForSelector("#compare-table");
    await page.goto(urlOf(s));
    await page.waitForSelector(".sig-col");
    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { s.close(); }
});

test("EX-14 the build refuses tampered bundles, unsafe file names and files outside the manifest's list stay out", () => {
  const damaged = hostileProof(() => {});
  writeFileSync(join(damaged, "vultr-live-20261104/runs-d14d24c", WRONG, "report.md"), "edited after the manifest");
  const a = build(join(work, "refused-1"), "--proof", damaged);
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /fails its integrity check; refusing to publish/);

  const unsafe = hostileProof((b) => {
    const m = JSON.parse(readFileSync(join(b, "manifest.json"), "utf8"));
    writeFileSync(join(b, "evil.html"), "<script>1</script>");
    m.files["evil.html"] = "0".repeat(64);
    writeFileSync(join(b, "manifest.json"), JSON.stringify(m));
  });
  const c = build(join(work, "refused-2"), "--proof", unsafe);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /refusing to publish evil\.html/);

  const pub = walk(site).map((f) => relative(site, f).replaceAll("\\", "/"));
  assert.ok(pub.every((f) => /^(index\.html|explorer\.(js|css)|styles\.css|verdict\.js|views\.js|\.nojekyll|data\/.+\.json|runs\/run_[^/]+\/.+\.(json|jsonl|md|png|txt))$/.test(f)), pub.find((f) => !/^(index\.html|explorer\.(js|css)|styles\.css|verdict\.js|views\.js|\.nojekyll|data\/.+\.json|runs\/run_[^/]+\/.+\.(json|jsonl|md|png|txt))$/.test(f)));
  for (const f of ["app.js", "ANCHORS.txt", "package.json"]) assert.equal(existsSync(join(site, f)), false, f);
  const text = walk(site).filter((f) => !f.endsWith(".png")).map((f) => readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(text, /INFERENCE_API_KEY|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{32}|[A-Za-z0-9_-]{40,}.[A-Za-z0-9_-]{80,}|ascend.levelup18/);
});

test("EX-15 the build is reproducible: two builds of the same source are byte-identical", () => {
  const other = join(work, "repro");
  assert.equal(build(other).status, 0);
  assert.equal(treeHash(other), treeHash(site));
});

test("EX-16 [CHROMIUM] the published page declares a strict CSP and links only to expected hosts", async () => {
  const { ctx, page } = await open(1366, 768, "", base, {}, ".scenario-card");
  assert.match(await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content"), /default-src 'self'/);
  const hosts = await page.locator("a[href^='http']").evaluateAll((a: HTMLAnchorElement[]) => a.map((x) => new URL(x.href).host));
  const external = [...new Set(hosts)].filter((h) => !base.includes(h as string)).sort();
  assert.deepEqual(external, ["45-63-82-115.sslip.io", "github.com", "lablab.build"]);
  await ctx.close();
});

for (const [w, h] of [[375, 812], [768, 1024]] as const) {
  test(`EX-17 [CHROMIUM] choosing a comparison brings the result into view at ${w}x${h}`, async () => {
    const { ctx, page } = await open(w, h, "#evidence", base, {}, ".run-row");
    await page.locator("#compare-form button").click();
    await page.waitForSelector("#compare-table");
    await page.waitForTimeout(200);
    const top = await page.locator("#evidence-detail .detail-title").evaluate((n: Element) => n.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < h / 2, `title at ${top}`);
    await ctx.close();
  });
}
