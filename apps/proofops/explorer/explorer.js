// Evidence Explorer: the console's evidence views over published files, a signature comparison, a library of every
// bundle, and a checksum re-check in the visitor's browser. Nothing here contacts a server, a model or the live demo.
// All recorded text is inserted with textContent, because it came from models and web pages and is untrusted.
import { el, usd, plannerLabel, renderOutcome } from "./verdict.js";
import { loadEvidenceList, openCompare, openRun, source } from "./views.js";

const $ = (id) => document.getElementById(id);
const CORRECT = "run_20261104154509_8ec3eec5addfeed1";
const WRONG = "run_20261104154518_b6a586f4a0ec403d";
const RUN_ID = /^run_\d{14}_[0-9a-f]{8,16}$/;
const REPO = "https://github.com/ascendlevelup18-byte/jarvis-proofops-vultr/tree/evidence-20261105/proof";
const FEATURED_SET = "vultr-live-20261104/runs-d14d24c";

const getJson = async (path) => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
};
source.history = () => getJson("data/history.json");
source.summary = (id) => getJson(`data/runs/${id}.json`);
source.compare = (a, b) => getJson(`data/compare/${a}__${b}.json`);
source.file = (id, f) => `runs/${id}/${f}`;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (buf) => hex(await crypto.subtle.digest("SHA-256", buf));
const fetchBytes = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
};

/** The same comparison a clone's verifier makes: every file against the manifest, and the manifest against its recorded hash. */
async function check(summary, { simulateIn = null } = {}) {
  const problems = [];
  let simulated = null;
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await fetchBytes(`runs/${summary.runId}/manifest.json`);
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return { files: 0, problems: ["manifest.json is missing or unreadable"], simulated, status: "TAMPERED" };
  }
  const anchored = typeof summary.evidence.manifestSha256 === "string";
  if (anchored && (await sha256(manifestBytes)) !== summary.evidence.manifestSha256) problems.push("manifest.json doesn't match the recorded manifest hash");
  const entries = Object.entries(manifest.files ?? {});
  for (const [rel, expected] of entries) {
    try {
      const bytes = new Uint8Array(await fetchBytes(`runs/${summary.runId}/${rel}`));
      if (rel === simulateIn && bytes.length) bytes[0] ^= 1; // a copy in this browser's memory; no file changes
      const actual = await sha256(bytes);
      if (rel === simulateIn) simulated = { file: rel, expected, actual };
      if (actual !== expected) problems.push(`${rel}: content changed`);
    } catch {
      problems.push(`${rel}: missing`);
    }
  }
  return { files: entries.length, problems, simulated, status: problems.length ? "TAMPERED" : anchored ? "ANCHOR VERIFIED" : "INCOMPLETE" };
}

const tile = (label, value, tone, id) => {
  const d = el("div", `status-tile ${tone}`);
  if (id) d.id = id;
  d.append(el("span", "tile-label", label), el("strong", "tile-value", value));
  return d;
};
const outcomeTone = (o) => (o === "PASS" ? "good" : o === "DESIGNED FAIL" ? "designed" : o === "INCOMPLETE" || o === "TIMED OUT" || o === "CANCELLED" ? "warn" : "bad");
const integrityTone = (s) => (s === "ANCHOR VERIFIED" ? "good" : s === "TAMPERED" ? "bad" : "warn");

// ---------- Run detail: separate results, the check and the simulation ----------
document.addEventListener("proofops:run-opened", (e) => {
  const summary = e.detail;
  const out = $("evidence-detail");
  const banner = out.querySelector(".outcome");
  const tiles = el("div", "status-tiles");
  tiles.append(tile("Mission outcome", summary.missionOutcome, outcomeTone(summary.missionOutcome), "mission-outcome"), tile("Evidence integrity", "Checking…", "pending", "evidence-integrity"));
  banner.before(tiles);

  const panel = el("section", "panel check-panel");
  panel.append(el("h3", "", "Check it yourself"), el("p", "body-copy", "Your browser fetches this run's files, hashes them with SHA-256, and compares them with the manifest and its separately recorded hash."));
  const row = el("div", "check-actions");
  const button = (id, cls, text) => { const b = el("button", cls, text); b.type = "button"; b.id = id; return b; };
  const run = button("check-run", "primary", "Run the check again");
  const sim = button("check-flip", "ghost", "Simulate a one-byte evidence change");
  const reset = button("check-reset", "ghost", "Reset");
  reset.hidden = true;
  row.append(run, sim, reset);
  const result = el("div", "check-result");
  result.id = "check-result";
  result.setAttribute("role", "status");
  const sourceLink = el("a", "", "Source evidence on GitHub, at the evidence tag");
  sourceLink.href = `${REPO}/${FEATURED_SET}/${summary.runId}`;
  sourceLink.rel = "noopener";
  const ref = el("p", "small");
  ref.append(sourceLink);
  panel.append(row, result, ref);
  banner.after(panel);

  const setIntegrity = (status, note) => {
    const t = $("evidence-integrity");
    t.className = `status-tile ${integrityTone(status)}`;
    t.querySelector(".tile-value").textContent = note ? `${status} ${note}` : status;
  };
  let busy = false; // buttons stay enabled so keyboard focus is never lost
  const go = async (simulate) => {
    if (busy) return;
    busy = true;
    const fromReset = document.activeElement === reset;
    result.dataset.state = "running";
    result.replaceChildren(el("p", "small muted", "Hashing files…"));
    const r = await check(summary, { simulateIn: simulate ? "report.md" : null });
    result.replaceChildren();
    if (simulate) {
      result.dataset.state = "mismatch";
      result.append(el("p", "check-title", "Educational simulation: one byte changed in your browser's memory, and the check caught it."));
      if (r.simulated) {
        const dl = el("dl", "facts");
        dl.append(el("dt", "", "File"), el("dd", "", r.simulated.file), el("dt", "", "Recorded SHA-256"), el("dd", "mono", r.simulated.expected), el("dt", "", "Recomputed SHA-256"), el("dd", "mono mismatch", r.simulated.actual));
        result.append(dl);
      }
      result.append(el("p", "small muted", "No published file changed, and this isn't an attack on the VM. Reset to repeat the real check."));
      setIntegrity("TAMPERED", "(simulated)");
      renderOutcome(banner, { ...summary, outcomeClass: "evidence_integrity_failure", evidence: { ...summary.evidence, status: "TAMPERED", integrity_status: "TAMPERED", reasons: r.problems } });
      banner.querySelector(".outcome-label").textContent = "Simulated: evidence integrity failure";
      reset.hidden = false;
    } else if (r.problems.length === 0) {
      result.dataset.state = "match";
      result.append(el("p", "check-title", `All ${r.files} files match their checksums${r.status === "ANCHOR VERIFIED" ? ", and the manifest matches its recorded hash" : ", but no separate hash was recorded for this manifest"}.`), el("p", "small muted", "This shows the published files are consistent with their recorded hashes. It doesn't show who produced them, because these are checksums, not signatures."));
      setIntegrity(r.status);
      renderOutcome(banner, summary);
      reset.hidden = true;
    } else {
      result.dataset.state = "mismatch";
      result.append(el("p", "check-title", "This run's evidence failed the check."));
      const ul = el("ul", "reasons");
      for (const p of r.problems.slice(0, 8)) ul.append(el("li", "", p));
      result.append(ul);
      setIntegrity("TAMPERED");
      renderOutcome(banner, { ...summary, outcomeClass: "evidence_integrity_failure", evidence: { ...summary.evidence, status: "TAMPERED", integrity_status: "TAMPERED", reasons: r.problems } });
      reset.hidden = true;
    }
    busy = false;
    if (fromReset) run.focus(); // Reset hides itself, so keep keyboard focus nearby
  };
  run.addEventListener("click", () => go(false));
  reset.addEventListener("click", () => go(false));
  sim.addEventListener("click", () => go(true));
  go(false);
});

// ---------- Story: the signature comparison and six scenarios ----------
function renderSignature(a, b) {
  const box = $("signature");
  box.replaceChildren();
  const column = (s, verdictClass) => {
    const c = el("article", `sig-col ${verdictClass}`);
    const tools = s.steps.map((x) => x.tool ?? "unusable").join(" > ");
    const allowed = s.steps.filter((x) => x.decision === "allow").length;
    const finish = [...s.steps].reverse().find((x) => x.tool === "finish");
    c.append(el("h3", "", s.mission?.title ?? "Recorded run"), el("p", "sig-total", usd(s.observed?.totals?.totalCents)), el("p", "sig-total-label", "total in the store's own records"));
    const dl = el("dl", "facts");
    for (const [k, v] of [
      ["Goal", s.task], ["Model proposals", tools], ["Applied decisions", `${allowed} of ${s.steps.length} allowed by policy`],
      ["Model's last action", finish ? finish.proposal : "not recorded"], ["Expected state", `${usd(s.expected?.totalCents)} total, ${s.expected?.ordersExpected ?? "?"} orders`],
      ["Observed state", `${usd(s.observed?.totals?.totalCents)} total, ${s.observed?.orders ?? "?"} orders, checkout reached: ${s.observed?.checkoutReached ?? "?"}`],
    ]) dl.append(el("dt", "", k), el("dd", "", v ?? "not recorded"));
    c.append(dl, tile("Verifier outcome", s.missionOutcome, outcomeTone(s.missionOutcome)));
    return c;
  };
  box.append(column(a, "ok"), column(b, "wrong"));
}

async function renderScenarios(rows) {
  const grid = $("scenario-grid");
  grid.replaceChildren();
  for (const r of rows) {
    const li = el("li");
    const a = el("a", "scenario-card");
    a.href = `#evidence/${r.runId}`;
    a.append(el("strong", "", r.title ?? "Unknown mission"), el("span", "small muted", plannerLabel(r.provider, r.model)), el("span", "small muted", `${r.steps} recorded steps`));
    const tiles = el("span", "card-tiles");
    tiles.append(tile("Mission outcome", r.missionOutcome, outcomeTone(r.missionOutcome)));
    const integrity = tile("Evidence integrity", "Checking…", "pending");
    tiles.append(integrity);
    a.append(tiles);
    li.append(a);
    grid.append(li);
    source.summary(r.runId).then((s) => check(s)).then((res) => {
      integrity.className = `status-tile ${integrityTone(res.status)}`;
      integrity.querySelector(".tile-value").textContent = res.status;
    }).catch(() => {
      integrity.className = "status-tile warn";
      integrity.querySelector(".tile-value").textContent = "INCOMPLETE";
    });
  }
}

// ---------- Library ----------
let library = [];
const labelOf = (r) => (r.evidenceClass === "FAIL" ? (r.designed ? "DESIGNED FAIL" : "FAIL") : r.evidenceClass);
function renderLibrary() {
  const q = $("lib-search").value.trim().toLowerCase();
  const out = $("lib-outcome").value;
  const integ = $("lib-integrity").value;
  const rows = library.filter((r) => (!out || labelOf(r) === out) && (!integ || r.integrity === integ)
    && (!q || `${r.mission} ${r.set} ${r.runId} ${r.code} ${labelOf(r)} ${r.integrity}`.toLowerCase().includes(q)));
  const body = $("lib-rows");
  body.replaceChildren();
  for (const r of rows) {
    const tr = el("tr");
    tr.dataset.run = r.runId;
    const mission = el("td");
    mission.append(el("div", "", r.mission), el("div", "small muted mono", r.runId.slice(-8)));
    if (r.reasons?.length && r.evidenceClass === "INCOMPLETE") mission.append(el("div", "small warn-text", r.reasons.join("; ")));
    const links = el("td");
    if (r.featured) {
      const here = el("a", "", "Inspect here");
      here.href = `#evidence/${r.runId}`;
      links.append(here, document.createTextNode(" · "));
    }
    const gh = el("a", "", "Files");
    gh.href = `${REPO}/${r.path}`;
    gh.rel = "noopener";
    links.append(gh);
    const outcomeCell = el("td");
    outcomeCell.append(el("span", `pill ${outcomeTone(labelOf(r))}`, labelOf(r)));
    const integrityCell = el("td");
    integrityCell.append(el("span", `pill ${r.integrity === "ANCHOR VERIFIED" ? "good" : r.integrity === "TAMPERED" ? "bad" : "warn"}`, r.integrity));
    tr.append(mission, outcomeCell, integrityCell, el("td", "", r.set), el("td", "mono", r.code ?? "not recorded"), el("td", "", String(r.files)), links);
    body.append(tr);
  }
  $("lib-empty").hidden = rows.length > 0;
}
async function loadLibrary() {
  if (!library.length) {
    try {
      library = await getJson("data/library.json");
    } catch {
      $("lib-tally").textContent = "The library couldn't be loaded.";
      return;
    }
    const n = (f) => library.filter(f).length;
    $("lib-tally").textContent = `${library.length} bundles: ${n((r) => r.evidenceClass === "PASS")} PASS, ${n((r) => r.evidenceClass === "FAIL" && r.designed)} designed FAIL, ${n((r) => r.evidenceClass === "FAIL" && !r.designed)} other FAIL, ${n((r) => r.evidenceClass === "INCOMPLETE")} INCOMPLETE, ${n((r) => r.evidenceClass === "TAMPERED")} TAMPERED. ${n((r) => r.integrity === "NO ANCHOR")} older bundles have no separately recorded anchor, so only their file hashes could be checked.`;
  }
  renderLibrary();
}
for (const id of ["lib-search", "lib-outcome", "lib-integrity"]) $(id).addEventListener("input", renderLibrary);
$("lib-filters").addEventListener("submit", (e) => e.preventDefault());

// ---------- Routing ----------
const VIEWS = ["story", "runs", "library", "method"];
function show(view, heading) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (heading) $(heading).focus({ preventScroll: true });
}
let firstRoute = true;
async function route() {
  const [head, a, b] = location.hash.replace(/^#/, "").split("/");
  const quiet = firstRoute;
  firstRoute = false;
  if (head === "library") { show("library", quiet ? null : "library-heading"); await loadLibrary(); return; }
  if (head === "method") { show("method", quiet ? null : "method-heading"); return; }
  if (head === "compare" && RUN_ID.test(a ?? "") && RUN_ID.test(b ?? "")) {
    show("runs");
    $("compare-a").value = a;
    $("compare-b").value = b;
    await openCompare(a, b);
    return;
  }
  if (head === "evidence") {
    show("runs", a ? null : quiet ? null : "evidence-heading");
    if (a) await openRun(a);
    return;
  }
  if (head === "" || head === "story") show("story", quiet ? null : "hero-h");
}
window.addEventListener("hashchange", route);
$("compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  location.hash = `#compare/${$("compare-a").value}/${$("compare-b").value}`;
});
$("compare-b").addEventListener("change", () => { $("compare-b").dataset.touched = "1"; });

await loadEvidenceList();
$("compare-a").value = CORRECT;
$("compare-b").value = WRONG;
await route();
try {
  renderScenarios(await source.history());
  renderSignature(await source.summary(CORRECT), await source.summary(WRONG));
} catch {
  $("signature").replaceChildren(el("p", "empty", "The recorded comparison couldn't be loaded."));
}
