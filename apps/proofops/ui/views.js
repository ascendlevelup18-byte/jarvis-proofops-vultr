let ownerFetch = (...args) => fetch(...args);
let protectedImage = async (img, path) => { img.src = path; };
let protectedLink = () => {};
export function setOwnerTransport(transport) { ownerFetch = transport.ownerFetch; protectedImage = transport.protectedImage; protectedLink = transport.protectedLink; }
// Evidence and Trust areas. Read-only: nothing here can start, approve or change a run. All page and model text is
// inserted with textContent, because it's untrusted.
import { el, usd, OUTCOME, plannerLabel, tierLabel, renderOutcome } from "./verdict.js";

const $ = (id) => document.getElementById(id);
const get = async (path) => {
  const res = await ownerFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
};
const RUN_ID = /^run_\d{14}_[0-9a-f]{8,16}$/;
/** Where finished runs come from. The console uses the control plane; the static Explorer swaps these for published files. */
export const source = {
  history: () => get("/api/history"),
  summary: (id) => get(`/api/runs/${id}/summary`),
  compare: (a, b) => get(`/api/compare?a=${a}&b=${b}`),
  file: (id, f) => `/api/runs/${id}/evidence/${f}`,
};
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "time not recorded");
const panel = (title) => {
  const s = el("section", "panel");
  s.append(el("h3", "", title));
  return s;
};
const empty = (text) => el("p", "empty", text);

function factList(rows) {
  const dl = el("dl", "facts");
  for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v === null || v === undefined || v === "" ? "not recorded" : String(v)));
  return dl;
}

let history = [];

export async function loadEvidenceList() {
  const list = $("run-list");
  try {
    history = await source.history();
  } catch (e) {
    list.replaceChildren(el("li", "empty", e.message === "history_private" ? "Run history isn't open on this deployment." : "Run history couldn't be loaded."));
    $("compare-form").hidden = true;
    return;
  }
  $("compare-form").hidden = history.length < 2;
  list.replaceChildren();
  if (!history.length) list.append(el("li", "empty", "No finished runs yet."));
  for (const r of history) {
    const o = OUTCOME[r.outcomeClass] ?? OUTCOME.incomplete_evidence;
    const a = el("a", "run-row");
    a.href = `#evidence/${r.runId}`;
    a.dataset.run = r.runId;
    const top = el("span", "run-row-top");
    top.append(el("strong", "", r.title ?? "Unknown mission"), el("span", `pill ${o.tone}`, o.label.split(":")[0]));
    a.append(top, el("span", "run-row-meta", `${when(r.at)} · ${plannerLabel(r.provider, r.model)}${r.source === "archive" ? " · recorded archive" : ""}`));
    const li = el("li");
    li.append(a);
    list.append(li);
  }
  for (const id of ["compare-a", "compare-b"]) {
    const sel = $(id);
    const keep = sel.value;
    sel.replaceChildren();
    for (const r of history) {
      const opt = el("option", "", `${r.title ?? "Unknown"} · ${(r.at ?? "").slice(0, 16).replace("T", " ")} · ${r.runId.slice(-6)}`);
      opt.value = r.runId;
      sel.append(opt);
    }
    if (keep && history.some((r) => r.runId === keep)) sel.value = keep;
  }
  if (history.length > 1 && !$("compare-b").dataset.touched && $("compare-a").value === $("compare-b").value) $("compare-b").value = history[1].runId;
}

const markSelected = (id) => {
  for (const a of document.querySelectorAll(".run-row")) {
    if (a.dataset.run === id) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
};

export async function openRun(id, { focus = true } = {}) {
  const out = $("evidence-detail");
  markSelected(id);
  if (!RUN_ID.test(id)) { out.replaceChildren(empty("That isn't a valid run id.")); return; }
  out.replaceChildren(empty("Loading the recorded evidence…"));
  let s;
  try {
    s = await source.summary(id);
  } catch (e) {
    out.replaceChildren(empty(e.status === 404 ? "This server has no record of that run." : e.status === 409 ? "This run is still in progress. Follow it under Run." : "The run's record couldn't be loaded."));
    return;
  }
  renderRun(out, s);
  document.dispatchEvent(new CustomEvent("proofops:run-opened", { detail: s }));
  if (focus) { $("evidence-heading").focus({ preventScroll: true }); $("evidence-detail").scrollIntoView({ block: "start" }); }
}

function renderRun(out, s) {
  out.replaceChildren();
  const head = el("header", "detail-head");
  head.append(el("p", "eyebrow", s.source === "archive" ? "Recorded archive" : "Run registry"), el("h3", "detail-title", s.mission?.title ?? s.mode ?? "Unknown mission"), el("p", "mono small", s.runId));
  const banner = el("div");
  banner.setAttribute("role", "status");
  renderOutcome(banner, s);
  out.append(head, banner);

  const grid = el("div", "detail-grid");
  const obj = panel("Objective and expected result");
  if (s.userText) obj.append(el("p", "body-copy", `You asked: "${s.userText}"`));
  obj.append(el("p", "body-copy", s.task ?? s.mission?.purpose ?? "Objective not recorded."));
  obj.append(factList([
    ["Expected total", s.expected ? usd(s.expected.totalCents) : null],
    ["Orders expected", s.expected?.ordersExpected],
    ["This mission is designed to", s.mission ? (s.mission.expected.verdict === "OPEN" ? "be checked against the store" : s.mission.expected.verdict === "PASS" ? "pass" : s.mission.expected.status === "timed_out" ? "time out and fail" : "fail") : null],
  ]));
  grid.append(obj);

  const seen = panel("What the store recorded");
  seen.append(s.observed ? factList([
    ["Observed total", usd(s.observed.totals?.totalCents)],
    ["Observed discount", usd(s.observed.totals?.discountCents)],
    ["Promo code", s.observed.coupon ?? "none"],
    ["Checkout reached", s.observed.checkoutReached],
    ["Orders", s.observed.orders],
  ]) : empty("Store state wasn't recorded for this run."));
  grid.append(seen);

  const model = panel("Model and provider");
  model.append(factList([
    ["Planner", plannerLabel(s.model?.provider, s.model?.requested)],
    ["Response model", s.model?.responseModels?.join(", ")],
    ["Model calls", s.model?.calls],
    ["Tokens", s.model?.totalTokens],
    ["Duration", s.durationMs === null ? null : `${(s.durationMs / 1000).toFixed(1)} s`],
    ["Environment", tierLabel(s.tier)],
    ["Code", s.codeSha?.slice(0, 12)],
  ]));
  grid.append(model);

  const appr = panel("Approval");
  if (s.approval) {
    const cart = s.approval.cart ?? {};
    appr.append(factList([
      ["Item", cart.sku ? `${cart.sku} × ${cart.quantity}` : null],
      ["Promo code", cart.coupon ?? "none"],
      ["Approved total", usd(cart.totalCents)],
      ["Cart hash", s.approval.payloadSha256 ? `${s.approval.payloadSha256.slice(0, 24)}…` : null],
      ["Decision", s.approval.granted ? "Approved by the operator" : s.approval.refused ? "Refused" : "No decision recorded"],
      ["Replay of the used token", s.approval.replayStatus === null ? "not attempted" : `HTTP ${s.approval.replayStatus}${s.approval.replayRefused ? ", refused" : ", NOT refused"}`],
    ]));
  } else appr.append(empty("No approval was requested in this run."));
  grid.append(appr);
  out.append(grid);

  const dec = panel("Policy decisions");
  if (s.steps.length) {
    const ol = el("ol", "decisions");
    for (const d of s.steps) {
      const li = el("li", "step");
      const top = el("div", "top");
      const label = { allow: "ALLOWED", deny: "REFUSED", needs_approval: "HELD FOR APPROVAL" }[d.decision] ?? d.decision;
      top.append(el("span", "tool", `${d.step + 1}. ${d.proposal}`), el("span", `badge ${d.decision}`, label));
      li.append(top);
      if (d.reason) li.append(el("div", "why", `Model's reason, untrusted: "${d.reason}"`));
      if (d.rule) li.append(el("div", "why", `Rule: ${d.rule.replaceAll("_", " ")} · ${d.dispatched ? "dispatched to the browser" : "not dispatched"}`));
      ol.append(li);
    }
    dec.append(ol);
  } else dec.append(empty("No policy decisions were recorded."));
  out.append(dec);

  const contain = panel("Containment and refusals");
  if (s.containment.length) {
    const ul = el("ul", "containment");
    for (const c of s.containment) {
      const li = el("li");
      li.append(el("span", `badge ${c.kind === "policy" ? "deny" : "gw"}`, c.kind.toUpperCase()), document.createTextNode(" "), el("span", "", c.text));
      if (c.detail) li.append(el("div", "mono small", c.detail.replaceAll("_", " ")));
      ul.append(li);
    }
    contain.append(ul);
  } else contain.append(empty("Nothing was refused or blocked in this run."));
  out.append(contain);

  if (s.checks.length) {
    const checks = panel("Independent checks");
    const table = el("table", "checks");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Check", "Expected", "Observed", "Result"]) { const th = el("th", "", h); th.scope = "col"; hr.append(th); }
    thead.append(hr);
    const tbody = el("tbody");
    const money = /^(dom|server)\.(subtotal|discount|total)$/;
    const fmt = (c, x) => (x === undefined ? "" : money.test(c.name) && typeof x === "number" ? usd(x) : typeof x === "object" ? JSON.stringify(x) : String(x));
    for (const c of s.checks) {
      const tr = el("tr", c.outcome);
      tr.append(el("td", "", c.name), el("td", "", fmt(c, c.expected)), el("td", "", fmt(c, c.observed)), el("td", c.outcome, c.outcome));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = el("div", "table-wrap");
    wrap.append(table);
    checks.append(wrap);
    out.append(checks);
  }

  if (s.screenshots.length) {
    const shots = panel("Screenshots");
    const row = el("div", "gallery");
    for (const f of s.screenshots) {
      const a = el("a");
      a.href = source.file(s.runId, f);
      a.target = "_blank";
      a.rel = "noopener";
      const img = el("img");
      img.loading = "lazy";
      protectedImage(img, a.href).catch(() => {});
      protectedLink(a);
      img.alt = `Recorded screenshot ${f.replace("screenshots/", "")}`;
      a.append(img);
      row.append(a);
    }
    shots.append(row);
    out.append(shots);
  }

  const ev = panel("Evidence");
  ev.append(factList([
    ["Evidence integrity", s.evidence.integrity_status],
    ["What was checked", s.evidence.integrity],
    ["Files with checksums", s.evidence.files],
    ["Recorded manifest hash", s.evidence.manifestSha256 ? `${s.evidence.manifestSha256.slice(0, 32)}…` : "none recorded"],
  ]));
  if (s.evidence.reasons.length) {
    const ul = el("ul", "reasons");
    for (const r of s.evidence.reasons) ul.append(el("li", "", r));
    ev.append(ul);
  }
  const links = el("ul", "evidence");
  for (const f of s.evidence.available) {
    const a = el("a", "", f);
    a.href = source.file(s.runId, f);
    protectedLink(a);
    a.target = "_blank";
    a.rel = "noopener";
    const li = el("li");
    li.append(a);
    links.append(li);
  }
  ev.append(links);
  ev.append(el("p", "small muted", "These are checksums, not signatures. Someone who controls the host could rewrite both the files and the recorded hash."));
  if (s.notRetained.length) ev.append(el("p", "small muted", `Not retained by this run: ${s.notRetained.join(", ")}.`));
  out.append(ev);
}

export async function openCompare(a, b) {
  const out = $("evidence-detail");
  markSelected(null);
  if (!RUN_ID.test(a) || !RUN_ID.test(b)) { out.replaceChildren(empty("Choose two finished runs to compare.")); return; }
  if (a === b) { out.replaceChildren(empty("Choose two different runs to compare.")); return; }
  out.replaceChildren(empty("Comparing the recorded evidence…"));
  let c;
  try {
    c = await source.compare(a, b);
  } catch (e) {
    out.replaceChildren(empty(e.status === 409 ? "One of these runs is still in progress." : "These runs couldn't be compared."));
    return;
  }
  out.replaceChildren();
  const head = el("header", "detail-head");
  head.append(el("p", "eyebrow", "Run comparison"), el("h3", "detail-title", `${c.a.title} and ${c.b.title}`), el("p", "body-copy", `${c.differences} recorded difference${c.differences === 1 ? "" : "s"}. ${c.note}`));
  out.append(head);
  const onlyDiff = el("label", "toggle");
  const box = el("input");
  box.type = "checkbox";
  box.id = "only-differences";
  onlyDiff.append(box, document.createTextNode(" Show only differences"));
  out.append(onlyDiff);
  const table = el("table", "compare");
  table.id = "compare-table";
  const cap = el("caption", "sr", "Two finished runs side by side");
  const thead = el("thead");
  const hr = el("tr");
  for (const [text, title] of [["Field", null], [`A: ${c.a.title}`, c.a.runId], [`B: ${c.b.title}`, c.b.runId]]) {
    const th = el("th", "", text);
    th.scope = "col";
    if (title) th.title = title;
    hr.append(th);
  }
  thead.append(hr);
  table.append(cap, thead);
  let group = null;
  let tbody = null;
  const pretty = (v, field) => (field === "Outcome" ? (OUTCOME[v]?.label ?? v) : v);
  for (const r of c.rows) {
    if (r.group !== group) {
      group = r.group;
      tbody = el("tbody");
      const gr = el("tr", "group");
      const th = el("th", "", group);
      th.colSpan = 3;
      th.scope = "colgroup";
      gr.append(th);
      tbody.append(gr);
      table.append(tbody);
    }
    const tr = el("tr", r.differs ? "differs" : "same");
    const th = el("th", "", r.field);
    th.scope = "row";
    tr.append(th, el("td", "", pretty(r.a, r.field)), el("td", "", pretty(r.b, r.field)));
    tbody.append(tr);
  }
  const wrap = el("div", "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Run comparison table");
  wrap.append(table);
  out.append(wrap);
  box.addEventListener("change", () => table.classList.toggle("only-diff", box.checked));
  $("evidence-heading").focus({ preventScroll: true });
  out.scrollIntoView({ block: "start" }); // on narrow screens the result sits below the run list
}

export async function loadTrust() {
  const out = $("trust-body");
  let t;
  try {
    t = await get("/api/trust");
  } catch {
    out.replaceChildren(empty("This information couldn't be loaded."));
    return;
  }
  out.replaceChildren();
  const who = panel("Who can do what");
  const rows = el("dl", "facts wide");
  for (const [k, v] of [
    ["Model", `Proposes one of ${t.actions.length} typed actions: ${t.actions.join(", ")}. It can't authorize itself.`],
    ["Policy", "Deterministic code checks every proposal before anything reaches the browser."],
    ["Operator", t.approvals],
    ["Verifier", "Compares the page and the store's records with expectations frozen before the run. It doesn't read the model's claim."],
  ]) rows.append(el("dt", "", k), el("dd", "", v));
  who.append(rows);
  out.append(who);

  const now = panel("This deployment, now");
  now.append(factList([
    ["Planner", plannerLabel(t.planner.provider, t.planner.model)],
    ["Browser isolation", t.isolation],
    ["Silent fallback to scripted", t.silentFallback ? "yes" : "no: if the planner fails, the run fails"],
    ["Code", t.codeSha],
    ["Recorded runs available to inspect", t.archivedRuns],
  ]));
  out.append(now);

  const lim = panel("Limits in force");
  lim.append(factList([
    ["Steps per mission", t.limits.maxSteps],
    ["Model calls per mission", t.limits.maxModelCalls],
    ["Tokens per mission", t.limits.maxTotalTokens.toLocaleString("en-US")],
    ["Missions at once", t.limits.activeMissions],
    ["Mission starts per rolling day", t.limits.missionsPerRollingDay],
    ["Starts per minute, per address", t.limits.startsPerMinutePerAddress],
    ["Evidence bundles kept", t.limits.evidenceBundlesKept],
  ]));
  out.append(lim);

  const ev = panel("What evidence does and doesn't prove");
  ev.append(el("p", "body-copy", t.evidence));
  out.append(ev);

  const m = panel("Missions and their designed results");
  const table = el("table", "checks");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["Mission", "Designed to", "Time limit", "Approval"]) { const th = el("th", "", h); th.scope = "col"; hr.append(th); }
  thead.append(hr);
  const tbody = el("tbody");
  for (const x of t.missions) {
    const tr = el("tr");
    tr.append(el("td", "", x.title), el("td", "", x.expected.verdict === "PASS" ? "pass" : x.expected.status === "timed_out" ? "time out and fail" : "fail"), el("td", "", `${x.wallClockSeconds} s`), el("td", "", x.approval === "operator" ? "Operator approves the order" : "None"));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const wrap = el("div", "table-wrap");
  wrap.append(table);
  m.append(wrap);
  out.append(m);
}

