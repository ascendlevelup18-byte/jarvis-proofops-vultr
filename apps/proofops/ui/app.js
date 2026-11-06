// JARVIS ProofOps operator UI. Every indicator is driven by data from the control plane; nothing is simulated.
import { renderOutcome, renderOutcomeUnavailable } from "./verdict.js";
import { loadEvidenceList, loadTrust, openCompare, openRun } from "./views.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-proofops": "1", ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body;
};
const usd = (cents) => (typeof cents === "number" ? `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}` : String(cents ?? "—"));

let scenarios = [];
let selected = null;
let current = null; // { runId, stream, screenshots[], containment[], stepsSeen }
let shotToken = 0;
let starting = false;

// ---------- environment ----------
async function loadHealth() {
  const chips = [];
  const add = (text, cls, title) => { const c = el("li", `chip ${cls}`, text); if (title) c.title = title; chips.push(c); };
  try {
    const h = await api("/api/health");
    const live = h.tier.startsWith("VULTR_GVISOR");
    const liveModel = h.planner.provider === "vultr-serverless-inference";
    $("proposer").textContent = liveModel ? "model" : "scripted planner";
    $("stage-propose").textContent = liveModel ? "Model proposes" : "Planner proposes";
    add(h.planner.provider === "vultr-serverless-inference" ? `Model: ${h.planner.model} (Vultr Serverless Inference)` : "Model: scripted planner (no live AI)",
      h.planner.provider === "vultr-serverless-inference" ? "ok" : "warn", "Which planner proposes actions in this deployment");
    add(live ? "Sandbox: gVisor (runsc)" : "Sandbox: none (local development)", live ? "ok" : "warn", "Browser worker isolation in this deployment");
    add(`Code ${h.codeSha}`, "", "Git commit of the running control plane");
    if (h.active) add("Mission in progress", "warn");
  } catch {
    chips.length = 0;
    add("Control plane unreachable", "warn");
  }
  $("env").replaceChildren(...chips);
}

// ---------- missions ----------
// Radio-group pattern: one tab stop, arrow keys move the selection, focus is never lost on select.
function selectScenario(s, focus = false) {
  selected = s;
  $("selected-mission").textContent = s.title;
  for (const b of $("scenario-list").children) {
    const on = b.dataset.id === s.id;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  $("run-btn").disabled = starting || Boolean(current?.running);
}

function renderScenarios() {
  const list = $("scenario-list");
  list.replaceChildren();
  scenarios.forEach((s, i) => {
    const b = el("button", "scenario");
    b.type = "button";
    b.dataset.id = s.id;
    b.setAttribute("role", "radio");
    b.append(el("strong", "", s.title), el("span", "", s.purpose));
    b.addEventListener("click", () => selectScenario(s));
    b.addEventListener("keydown", (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      selectScenario(scenarios[(i + step + scenarios.length) % scenarios.length], true);
    });
    list.append(b);
  });
  if (selected) selectScenario(selected);
}

async function loadHistory() {
  try {
    const rows = await api("/api/runs");
    const ol = $("history");
    ol.replaceChildren();
    for (const r of rows.slice(0, 8)) {
      const li = el("li");
      const sc = el("span", "mono", r.ref);
      const v = el("span", `badge ${r.verdict === "PASS" ? "allow" : r.verdict ? "deny" : "gw"}`, r.verdict ?? r.status);
      li.append(el("span", "", r.mode), sc, v);
      ol.append(li);
    }
  } catch { /* history is optional */ }
}

// ---------- run lifecycle ----------
function resetRunView(scenario, runId) {
  $("run-scenario").textContent = `Mission · ${scenario.title}`;
  $("run-title").textContent = scenario.purpose;
  $("run-id").textContent = runId;
  $("timeline").replaceChildren();
  $("containment").replaceChildren(el("li", "empty", "Nothing blocked yet."));
  $("evidence").replaceChildren(el("li", "empty", "Available when the run ends."));
  $("thumbs").replaceChildren();
  shotToken++;
  $("shot").hidden = true;
  $("shot-empty").hidden = false;
  $("shot-empty").textContent = "Real screenshots from the worker appear here.";
  $("shot-label").textContent = "";
  $("verdict").className = "verdict pending";
  $("verdict").textContent = "Run in progress. The verifier decides at the end.";
  $("outcomes").replaceChildren();
  $("checks").hidden = true;
  $("approval").hidden = true;
  $("outcome").hidden = true;
  $("outcome").replaceChildren();
  for (const li of document.querySelectorAll("#pipeline li")) li.className = "";
}

function stage(name, state) {
  const li = document.querySelector(`#pipeline li[data-stage="${name}"]`);
  if (!li) return;
  const order = ["propose", "policy", "execute", "verify", "evidence", "teardown"];
  if (state === "active") {
    for (const s of order.slice(0, order.indexOf(name))) {
      const prev = document.querySelector(`#pipeline li[data-stage="${s}"]`);
      if (prev && !prev.classList.contains("bad")) prev.className = "done";
    }
  }
  li.className = state;
}

function setStatus(status) {
  const s = $("run-status");
  s.className = `status ${status}`;
  s.textContent = { running: "Running", awaiting_approval: "Awaiting approval", completed: "Completed", failed: "Failed", timed_out: "Timed out", cancelled: "Cancelled" }[status] ?? status;
  $("cancel-btn").hidden = !(status === "running" || status === "awaiting_approval");
}

function describe(p) {
  if (!p || typeof p !== "object") return "unusable model reply";
  switch (p.tool) {
    case "navigate": return `navigate ${p.path}`;
    case "click": return `click ${p.ref} (epoch ${p.epoch})`;
    case "fill": return `fill ${p.ref} = "${p.value}"`;
    case "request_approval": return `request approval for ${p.ref}`;
    case "finish": return `finish${p.note ? `: ${p.note}` : ""}`;
    default: return JSON.stringify(p).slice(0, 80);
  }
}

function addStep(s) {
  const tl = $("timeline");
  tl.querySelector(".empty")?.remove();
  const li = el("li", "step");
  const top = el("div", "top");
  top.append(el("span", "tool", `${s.step + 1}. ${describe(s.proposal)}`));
  const decision = s.approved ? "approved" : s.policy?.decision ?? "deny";
  const label = { allow: "ALLOWED", deny: "REFUSED", needs_approval: "NEEDS APPROVAL", approved: "OPERATOR APPROVED" }[decision] ?? decision;
  top.append(el("span", `badge ${decision}`, label));
  li.append(top);
  const why = [];
  if (s.proposal?.reason) why.push(`Model's reason: "${s.proposal.reason}"`);
  if (s.policy?.decision !== "allow" && s.policy?.rule) why.push(`Policy: ${s.policy.rule.replaceAll("_", " ")}${s.policy.detail ? ` (${s.policy.detail})` : ""}`);
  if (s.result) why.push(s.dispatched ? `Result: ${s.result}` : "Not dispatched to the browser");
  if (s.model?.provider) why.push(`${s.model.provider === "local-model-stub" ? "Scripted stub" : `Vultr ${s.model.responseModel ?? s.model.requestedModel}`}${s.model.latencyMs ? ` · ${s.model.latencyMs} ms` : ""}`);
  for (const w of why) li.append(el("div", "why", w));
  tl.append(li);
  tl.scrollTop = tl.scrollHeight;
  if (decision === "deny" || decision === "needs_approval") {
    addContainment(`Refused before dispatch: ${describe(s.proposal)}`, s.policy?.rule ?? "");
  }
}

function addContainment(text, detail, kind = "policy") {
  const ul = $("containment");
  ul.querySelector(".empty")?.remove();
  const li = el("li", kind === "limit" ? "limit" : "");
  li.append(el("span", `badge ${kind === "policy" ? "deny" : "gw"}`, { network: "NETWORK", policy: "POLICY", limit: "LIMIT" }[kind]), document.createTextNode(" "), el("span", "", text));
  if (detail) li.append(el("div", "mono small", detail));
  ul.append(li);
}

function showShot(file) {
  if (!current) return;
  const src = `/api/runs/${current.runId}/evidence/${file}`;
  const token = ++shotToken;
  const preload = new Image();
  preload.onload = () => {
    if (token !== shotToken) return; // a newer screenshot was chosen while this one loaded
    $("shot").src = src;
    $("shot").hidden = false;
    $("shot-empty").hidden = true;
    $("shot-label").textContent = file.replace("screenshots/", "");
  };
  preload.src = src;
  for (const b of $("thumbs").children) b.setAttribute("aria-current", String(b.dataset.file === file));
}

function addShot(file) {
  const b = el("button");
  b.type = "button";
  b.dataset.file = file;
  b.setAttribute("aria-label", `Show ${file}`);
  const img = el("img");
  img.src = `/api/runs/${current.runId}/evidence/${file}`;
  img.alt = "";
  b.append(img);
  b.addEventListener("click", () => showShot(file));
  $("thumbs").append(b);
  showShot(file);
}

function onEvent(e) {
  switch (e.type) {
    case "spec.frozen": stage("propose", "active"); break;
    case "policy.decision": stage("policy", "active"); break;
    case "gateway.denied": addContainment(`${e.method} ${e.target}`, `Gateway refused: ${e.reason.replaceAll("_", " ")}`, "network"); break;
    case "screenshot": stage("execute", "active"); addShot(e.file); break;
    case "approval.replay_probe":
      addContainment(`Replay of the used approval sent straight to the store: HTTP ${e.status}`, e.refused ? "Store refused the replay" : "Store did NOT refuse the replay", "policy");
      break;
    case "verifier.dom_read": stage("verify", "active"); break;
    case "run.wall_clock_expired": addContainment("Wall-clock limit reached: worker destroyed", "Hard stop", "limit"); break;
    case "cleanup.done": stage("evidence", "done"); stage("teardown", e.workerGone ? "done" : "bad"); break;
  }
}

function showApproval(p) {
  if (!p) { $("approval").hidden = true; return; }
  $("approval").hidden = false;
  $("approval-element").textContent = p.element || "submit the order";
  const dl = $("approval-cart");
  dl.replaceChildren();
  for (const [k, v] of [["Item", `${p.cart.sku} × ${p.cart.quantity}`], ["Promo code", p.cart.coupon ?? "none"], ["Order total", usd(p.cart.totalCents)]]) {
    dl.append(el("dt", "", k), el("dd", "", v));
  }
  $("approval-hash").textContent = p.payloadSha256.slice(0, 24) + "…";
  $("approval").dataset.hash = p.payloadSha256;
  $("approve-btn").focus();
}

/** States the finished run's outcome where it can't be missed, using its recorded evidence. */
async function showOutcome(runId, verdict, { reveal = true } = {}) {
  const box = $("outcome");
  let summary = null;
  for (let attempt = 0; attempt < 3 && !summary; attempt++) {
    try { summary = await api(`/api/runs/${runId}/summary`); }
    catch (e) { if (e.status !== 409) break; await new Promise((r) => setTimeout(r, 300)); }
  }
  if (current?.runId !== runId) return; // another mission took over while this loaded
  if (summary) renderOutcome(box, summary);
  else renderOutcomeUnavailable(box, verdict);
  const link = el("a", "outcome-link", "Open the full record");
  link.href = `#evidence/${runId}`;
  box.append(link);
  if (reveal && !$("view-run").hidden) {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    box.focus({ preventScroll: true });
  }
}

function renderArchivedRun(snap) {
  const verdict = $("verdict");
  verdict.className = `verdict ${snap.verdict ?? "pending"}`;
  verdict.textContent = snap.verdict ?? "No recorded verdict";
  const message = snap.error ?? "This mission is in the durable run registry.";
  $("timeline").replaceChildren(el("li", "empty", message));
  $("shot-empty").textContent = "Live preview is unavailable for this run. Check the run evidence below.";
  $("containment").replaceChildren(el("li", "empty", "See the saved gateway and policy logs for containment details."));
  if (snap.manifestSha256) renderEvidence(snap.runId, snap.manifestSha256);
  else $("evidence").replaceChildren(el("li", "empty", "No anchored evidence is available."));
  showOutcome(snap.runId, snap.verdict, { reveal: false });
}

function renderResult(snap) {
  const r = snap.result;
  if (!r) return;
  const v = $("verdict");
  v.className = `verdict ${r.verdict}`;
  v.textContent = r.verdict === "PASS" ? "VERIFIED PASS" : r.verdict === "FAIL" ? "VERIFIED FAIL" : "INCONCLUSIVE";
  const blocked = $("containment").querySelectorAll("li:not(.empty):not(.limit)").length;
  if (!$("containment").querySelector("li:not(.empty)")) $("containment").replaceChildren(el("li", "empty", "Nothing was blocked in this run."));
  if (!$("timeline").children.length) $("timeline").append(el("li", "empty", "No step finished before the run ended."));
  const sub = [r.error ? `Run ${snap.status.replace("_", " ")}: ${r.error}` : `Run ${snap.status.replace("_", " ")}`];
  if (blocked) sub.push(`CONTAINED: ${blocked} attempt${blocked === 1 ? "" : "s"} blocked`);
  v.append(el("small", "", sub.join(" · ")));
  const oc = $("outcomes");
  oc.replaceChildren();
  for (const [k, val] of Object.entries(r.outcomes ?? {})) {
    const li = el("li", val, k);
    li.append(el("b", "", val === "INCONCLUSIVE" ? "UNSURE" : val));
    oc.append(li);
  }
  const tbody = $("checks").querySelector("tbody");
  tbody.replaceChildren();
  const money = new Set(["dom.subtotal", "dom.discount", "dom.total", "server.subtotal", "server.discount", "server.total"]);
  for (const c of r.checks ?? []) {
    const tr = el("tr", c.outcome);
    const fmt = (x) => (x === undefined ? "" : money.has(c.name) && typeof x === "number" ? usd(x) : typeof x === "object" ? JSON.stringify(x) : String(x));
    tr.append(el("td", "", c.name), el("td", "", fmt(c.expected)), el("td", "", fmt(c.observed)), el("td", c.outcome, c.outcome));
    tbody.append(tr);
  }
  $("checks").hidden = false;
  stage("verify", r.verdict === "PASS" ? "done" : "bad");
  for (const li of document.querySelectorAll("#pipeline li.active")) li.className = "done"; // nothing is still running once there is a result
  renderEvidence(snap.runId, r.manifestSha256);
  showOutcome(snap.runId, r.verdict);
}

function renderEvidence(runId, manifestSha256) {
  const ev = $("evidence");
  ev.replaceChildren();
  if (manifestSha256) {
    const seal = el("li", "mono small", `Manifest SHA-256 checksum (anchored outside the bundle): ${manifestSha256.slice(0, 32)}…`);
    ev.append(seal);
    const li = el("li");
    const b = el("button", "ghost evidence-check", "Re-check evidence integrity");
    b.type = "button";
    b.addEventListener("click", async () => {
      const v = await api(`/api/runs/${runId}/verify-evidence`).catch(() => null);
      b.dataset.result = v?.ok === true ? "intact" : "problem";
      b.textContent = !v ? "Evidence is unavailable or the check failed."
        : v.status === "TAMPERED" ? `TAMPERED: ${v.reasons.join("; ")}`
        : v.status === "INCOMPLETE" ? `INCOMPLETE: ${v.reasons.join("; ")}`
        : v.ok === true ? `Checksums match: ${v.files} files match the recorded manifest hash. Recorded verdict ${v.status}.`
        : "Evidence could not be verified.";
    });
    li.append(b);
    ev.append(li);
  }
  for (const [f, label] of [["report.md", "Run report"], ["manifest.json", "Manifest with file hashes"], ["assertions.json", "Verifier output"], ["policy-decisions.jsonl", "Policy decisions"],
    ["model-calls.jsonl", "Model calls (redacted)"], ["gateway.jsonl", "Gateway log"], ["server-state.json", "Store server state"], ["cleanup.json", "Teardown record"], ["spec.json", "Frozen spec"]]) {
    const li = el("li");
    const a = el("a", "", label);
    a.href = `/api/runs/${runId}/evidence/${f}`;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(a);
    ev.append(li);
  }
}

async function startRun() {
  if (!selected || starting || current?.running) return;
  const scenario = selected;
  starting = true;
  $("run-error").hidden = true;
  $("run-btn").disabled = true;
  try {
    const { runId, runToken } = await api("/api/runs", { method: "POST", body: JSON.stringify({ scenario: scenario.id }), headers: { "idempotency-key": crypto.randomUUID() } });
    current = { runId, running: true, runToken };
    try { sessionStorage.setItem("proofops.run", JSON.stringify({ runId, runToken, scenarioId: scenario.id })); } catch { /* optional */ }
    resetRunView(scenario, runId);
    setStatus("running");
    $("main").focus();
    follow(runId);
  } catch (e) {
    $("run-error").textContent = e.status === 409 ? "Another mission is still running. Wait for it to finish."
      : e.message === "daily_limit" ? "This demo has reached its daily mission limit. Please try again tomorrow."
      : e.status === 429 ? "Too many runs from this address in the last minute. Try again shortly."
      : e instanceof TypeError ? "The control plane is not reachable. Check that it is running."
      : `Could not start the mission (${e.message}).`;
    $("run-error").hidden = false;
  } finally {
    starting = false;
    $("run-btn").disabled = !selected || Boolean(current?.running);
  }
}

function follow(runId) {
  const es = new EventSource(`/api/runs/${runId}/stream`);
  current.stream = es;
  let seenSteps = 0;
  let seenEvents = 0;
  es.addEventListener("snapshot", (m) => {
    const s = JSON.parse(m.data);
    s.events.slice(seenEvents).forEach(onEvent);
    seenEvents = s.events.length;
    s.steps.slice(seenSteps).forEach(addStep);
    seenSteps = s.steps.length;
    setStatus(s.status);
    showApproval(s.pendingApproval);
  });
  es.addEventListener("event", (m) => { seenEvents++; onEvent(JSON.parse(m.data)); });
  es.addEventListener("step", (m) => { seenSteps++; addStep(JSON.parse(m.data)); });
  es.addEventListener("approval", (m) => { setStatus("awaiting_approval"); showApproval(JSON.parse(m.data)); });
  es.addEventListener("done", (m) => {
    const s = JSON.parse(m.data);
    es.close();
    current.running = false;
    setStatus(s.status);
    showApproval(null);
    renderResult(s);
    $("run-btn").disabled = !selected;
    loadHistory();
    loadHealth();
  });
  es.onerror = async () => {
    if (current?.stream !== es || !current.running) return;
    if (es.readyState !== EventSource.CLOSED) {
      $("run-status").textContent = "Reconnecting…";
      return;
    }
    const saved = await api(`/api/runs/${runId}`).catch(() => null);
    if (current?.stream !== es || !current.running) return;
    current.running = false;
    setStatus(saved?.status ?? "unknown");
    showApproval(null);
    $("cancel-btn").hidden = true;
    $("run-btn").disabled = !selected;
    if (saved?.result) renderResult(saved);
    else if (saved?.status && !saved.events) renderArchivedRun(saved);
    else {
      $("run-error").textContent = "Live updates are unavailable. Reload to reconnect to this mission.";
      $("run-error").hidden = false;
    }
    loadHistory();
  };
}

async function decide(kind) {
  if (!current) return;
  $("approve-btn").disabled = $("reject-btn").disabled = true;
  try {
    await api(`/api/runs/${current.runId}/${kind}`, { method: "POST", body: JSON.stringify({ payloadSha256: $("approval").dataset.hash }), headers: { "x-run-token": current.runToken ?? "" } });
    if (current?.running) {
      showApproval(null);
      setStatus("running");
    }
  } catch (e) {
    const why = {
      no_pending_approval: "This approval request has already been answered or has expired. Nothing was signed.",
      approval_payload_changed: "The cart changed after this request was shown. Nothing was signed; the agent must ask again.",
      missing_ui_header: "The request did not come from this console, so it was refused.",
      not_run_owner: "Only the browser that started this mission can approve it. Nothing was signed.",
    }[e.message];
    $("run-error").textContent = why ?? `Could not confirm the approval response (${e.message}). Check the run timeline before retrying.`;
    $("run-error").hidden = false;
  } finally {
    $("approve-btn").disabled = $("reject-btn").disabled = false;
  }
}

const VIEWS = ["run", "evidence", "trust"];
function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = name === "run" ? "JARVIS ProofOps" : `${name === "evidence" ? "Evidence" : "Trust"} · JARVIS ProofOps`;
}
async function route() {
  const [head, a, b] = location.hash.replace(/^#/, "").split("/");
  if (head === "" || head === "run") { showView("run"); return; }
  if (head === "trust") { showView("trust"); await loadTrust(); return; }
  if (head === "evidence" || head === "compare") {
    showView("evidence");
    await loadEvidenceList();
    if (head === "compare" && a && b) {
      $("compare-a").value = a;
      $("compare-b").value = b;
      await openCompare(a, b);
    } else if (a) await openRun(a);
  }
}
window.addEventListener("hashchange", route);
$("compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  location.hash = `#compare/${$("compare-a").value}/${$("compare-b").value}`;
});
$("compare-b").addEventListener("change", () => { $("compare-b").dataset.touched = "1"; });

$("run-btn").addEventListener("click", startRun);
$("approve-btn").addEventListener("click", () => decide("approve"));
$("reject-btn").addEventListener("click", () => decide("reject"));
$("cancel-btn").addEventListener("click", async () => { if (current) await api(`/api/runs/${current.runId}/cancel`, { method: "POST", body: "{}", headers: { "x-run-token": current.runToken ?? "" } }).catch(() => {}); });

(async () => {
  await loadHealth();
  try { scenarios = await api("/api/scenarios"); } catch { scenarios = []; }
  selected = scenarios[0] ?? null;
  renderScenarios();
  $("run-btn").disabled = !selected;
  loadHistory();
  route();
  // A reload mid-mission reconnects to the same run; it never starts or repeats anything.
  try {
    const saved = JSON.parse(sessionStorage.getItem("proofops.run") ?? "null");
    if (saved?.runId) {
      const snap = await api(`/api/runs/${saved.runId}`);
      const scenario = scenarios.find((s) => s.id === saved.scenarioId);
      if (!snap.events && scenario) {
        selectScenario(scenario);
        current = { runId: saved.runId, running: false };
        resetRunView(scenario, saved.runId);
        setStatus(snap.status);
        renderArchivedRun(snap);
      } else if (snap.events && scenario) {
        selectScenario(scenario);
        current = { runId: saved.runId, running: !snap.result, runToken: saved.runToken };
        resetRunView(scenario, saved.runId);
        setStatus(snap.status);
        follow(saved.runId);
        $("run-btn").disabled = current.running;
      }
    }
  } catch { /* nothing to reconnect to */ }
})();
