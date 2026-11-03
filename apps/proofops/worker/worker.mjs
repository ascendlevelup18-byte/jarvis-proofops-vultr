// ProofOps browser worker. Runs inside the disposable sandbox.
// Control channel: newline-delimited JSON on stdin/stdout. No network path to the control plane exists.
// Network: Chromium's only route is the proxy at 127.0.0.1:3128. Inside the sandbox (network=none) that port is
// a tiny TCP -> Unix-socket bridge to the host's restricted gateway (PROOFOPS_GATEWAY_SOCKET). Locally, for the
// LOCAL tier, PROOFOPS_PROXY points straight at a gateway TCP port instead.
// The worker holds no secrets: its environment is only the run id and these two settings.
import { createInterface } from "node:readline";
import { createServer, connect } from "node:net";
import { chromium } from "playwright";

const RUN_ID = process.env.PROOFOPS_RUN_ID ?? "unknown";
const SOCKET = process.env.PROOFOPS_GATEWAY_SOCKET ?? "";
const PROXY = process.env.PROOFOPS_PROXY ?? "http://127.0.0.1:3128";
const NO_SANDBOX = process.env.PROOFOPS_CHROMIUM_NO_SANDBOX === "1";

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (event) => out({ event: { at: new Date().toISOString(), runId: RUN_ID, ...event } });

function startBridge() {
  return new Promise((resolve, reject) => {
    const srv = createServer((client) => {
      const upstream = connect(SOCKET);
      client.pipe(upstream).pipe(client);
      const end = () => { client.destroy(); upstream.destroy(); };
      client.on("error", end);
      upstream.on("error", (e) => { log({ type: "bridge.error", message: e.code ?? e.message }); end(); });
    });
    srv.on("error", reject);
    srv.listen(3128, "127.0.0.1", () => resolve(srv));
  });
}

let browser, context, page;
let epoch = 0;
let current = -1; // epoch of the latest observation; -1 after any action until the next observe
const netlog = [];

async function start({ startUrl }) {
  if (SOCKET) await startBridge();
  browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY, bypass: "" },
    // WebRTC must not open UDP outside the proxy (STUN/TURN would otherwise bypass it).
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable",
      "--disable-quic", "--disable-background-networking", "--disable-component-update", "--no-first-run",
      "--disable-sync", "--disable-features=MediaRouter,OptimizationHints,DialMediaRouteProvider", "--proxy-bypass-list=<-loopback>"],
    chromiumSandbox: !NO_SANDBOX,
  });
  // A fresh, in-memory browser context per worker process: no profile directory, cookies or storage survive it.
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true });
  log({ type: "worker.cookies_at_start", count: (await context.cookies()).length });
  page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("request", (r) => netlog.push({ at: new Date().toISOString(), kind: "request", method: r.method(), url: r.url().slice(0, 300) }));
  page.on("requestfailed", (r) => netlog.push({ at: new Date().toISOString(), kind: "failed", url: r.url().slice(0, 300), error: r.failure()?.errorText ?? "" }));
  page.on("response", (r) => { if (r.status() >= 400) netlog.push({ at: new Date().toISOString(), kind: "status", url: r.url().slice(0, 300), status: r.status() }); });
  const res = await page.goto(startUrl, { waitUntil: "load" });
  current = -1;
  return { status: res?.status() ?? null, url: page.url(), chromiumSandbox: !NO_SANDBOX, bridge: Boolean(SOCKET) };
}

async function observe() {
  epoch += 1;
  const e = epoch;
  const data = await page.evaluate(() => {
    document.querySelectorAll("[data-pref]").forEach((n) => n.removeAttribute("data-pref"));
    const nodes = [...document.querySelectorAll("a[href], button, input, select, textarea")];
    const elements = [];
    let i = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const style = getComputedStyle(n);
      const hidden = n.type === "hidden";
      if (!hidden && (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none")) continue;
      i += 1;
      const ref = `e${i}`;
      n.setAttribute("data-pref", ref);
      const tag = n.tagName.toLowerCase();
      const label = (n.labels?.[0]?.innerText || n.getAttribute("aria-label") || n.getAttribute("placeholder") || n.innerText || n.value || "").trim().slice(0, 80);
      const el = { ref, tag, text: hidden ? "" : label };
      if (n.type) el.type = String(n.type).toLowerCase();
      if (n.name) el.name = n.name;
      if (tag === "a") el.href = n.href;
      if ((tag === "button" || tag === "input") && n.form && (n.type === "submit" || tag === "button")) el.formAction = n.form.action;
      if (n.dataset.consequential === "true") el.consequential = true;
      elements.push(el);
    }
    return { url: location.href, title: document.title, text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000), elements };
  });
  current = e;
  return { epoch: e, ...data };
}

async function elementFor(ref, refEpoch) {
  if (refEpoch !== current) throw new Error(`stale_reference: epoch ${refEpoch} is not current (${current})`);
  const loc = page.locator(`[data-pref="${ref}"]`);
  if ((await loc.count()) !== 1) throw new Error(`unknown_reference: ${ref}`);
  if (!(await loc.isVisible()) || !(await loc.isEnabled())) throw new Error(`not_interactable: ${ref}`);
  return loc;
}

// Re-checks the element against what the policy approved and acts in the SAME page task, so no page script can
// change the element between the check and the action (time-of-check/time-of-use). The click is a DOM click:
// no hover or pointer events are dispatched that a page could use to swap the target at the last moment.
async function actAtomically(loc, expect, action, value) {
  const r = await loc.evaluate((n, args) => {
    const tag = n.tagName.toLowerCase();
    const now = {
      tag,
      href: tag === "a" ? n.href : undefined,
      formAction: (tag === "button" || tag === "input") && n.form && (n.type === "submit" || tag === "button") ? n.form.action : undefined,
      consequential: n.dataset.consequential === "true" || undefined,
      name: n.name || undefined,
    };
    for (const k of ["tag", "href", "formAction", "consequential", "name"]) {
      if ((now[k] ?? null) !== (args.expect[k] ?? null)) return { changed: k, was: args.expect[k] ?? null, now: now[k] ?? null };
    }
    if (args.action === "approve") {
      const input = n.form && n.form.querySelector("input[name=approval]");
      if (!input) return { changed: "approval_field", was: "present", now: null };
      input.value = args.value;
    }
    if (args.action === "click" || args.action === "approve") n.click();
    return { changed: null };
  }, { expect, action, value });
  if (r.changed) throw new Error(`element_changed: ${r.changed} was ${JSON.stringify(r.was)} now ${JSON.stringify(r.now)}`);
}

async function settle() {
  await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
}

const handlers = {
  start,
  observe,
  async navigate({ url }) {
    current = -1;
    const res = await page.goto(url, { waitUntil: "load" });
    return { status: res?.status() ?? null, url: page.url() };
  },
  async click({ ref, epoch: e, expect }) {
    const loc = await elementFor(ref, e);
    current = -1; // any action invalidates references, even if it then fails
    const nav = page.waitForNavigation({ waitUntil: "load", timeout: 8_000 }).catch(() => {});
    await actAtomically(loc, expect ?? {}, "click");
    await nav;
    await settle();
    return { url: page.url() };
  },
  async fill({ ref, epoch: e, value, expect }) {
    const loc = await elementFor(ref, e);
    current = -1;
    await actAtomically(loc, expect ?? {}, "check");
    await loc.fill(String(value).slice(0, 64), { timeout: 5_000 });
    return { url: page.url() };
  },
  // Called only by the control plane after an operator approved the exact cart (never reachable by the model).
  // The token is single-use and bound to this run and cart; the store verifies it independently.
  async submitApproved({ ref, epoch: e, token, expect }) {
    const loc = await elementFor(ref, e);
    current = -1;
    const nav = page.waitForNavigation({ waitUntil: "load", timeout: 8_000 }).catch(() => {});
    await actAtomically(loc, expect ?? {}, "approve", String(token));
    await nav;
    await settle();
    return { url: page.url() };
  },
  async read({ selectors }) {
    const result = {};
    for (const [k, sel] of Object.entries(selectors)) {
      const loc = page.locator(sel);
      result[k] = (await loc.count()) > 0 ? ((await loc.first().textContent()) ?? "").trim() : null;
    }
    return { url: page.url(), values: result };
  },
  async screenshot() {
    const png = await page.screenshot({ type: "png", fullPage: true, timeout: 10_000 });
    return { png: png.toString("base64"), url: page.url() };
  },
  async netlog() {
    return { entries: netlog.splice(0) };
  },
  async close() {
    await browser?.close().catch(() => {});
    setTimeout(() => process.exit(0), 50);
    return { closed: true };
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (line.length > 65_536) return out({ id: null, ok: false, error: "message_too_large" });
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return out({ id: null, ok: false, error: "bad_json" });
  }
  const h = handlers[msg.op];
  if (!h) return out({ id: msg.id, ok: false, error: `unknown_op: ${String(msg.op).slice(0, 40)}` });
  try {
    out({ id: msg.id, ok: true, result: await h(msg) });
  } catch (e) {
    out({ id: msg.id, ok: false, error: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
  }
});
rl.on("close", async () => { await browser?.close().catch(() => {}); process.exit(0); });
// Variable NAMES only (never values), so tests can prove the environment is allow-listed.
log({ type: "worker.ready", node: process.version, bridge: Boolean(SOCKET), profile: "ephemeral", envKeys: Object.keys(process.env).sort() });
