// Evidence Explorer: the console's evidence views over published files, plus a checksum re-check in the visitor's
// browser. Nothing here contacts a server, a model or the live demo.
import { el, renderOutcome } from "./verdict.js";
import { loadEvidenceList, openCompare, openRun, source } from "./views.js";

const $ = (id) => document.getElementById(id);
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
async function check(summary, { flipByteIn = null } = {}) {
  const problems = [];
  let manifest = null;
  let manifestBytes = null;
  try {
    manifestBytes = await fetchBytes(`runs/${summary.runId}/manifest.json`);
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return { files: 0, problems: ["manifest.json is missing or unreadable"] };
  }
  if ((await sha256(manifestBytes)) !== summary.evidence.manifestSha256) problems.push("manifest.json doesn't match the recorded manifest hash");
  const entries = Object.entries(manifest.files ?? {});
  for (const [rel, expected] of entries) {
    try {
      const bytes = new Uint8Array(await fetchBytes(`runs/${summary.runId}/${rel}`));
      if (rel === flipByteIn && bytes.length) bytes[0] ^= 1; // in this browser's memory only; no file changes
      if ((await sha256(bytes)) !== expected) problems.push(`${rel}: content changed`);
    } catch {
      problems.push(`${rel}: missing`);
    }
  }
  return { files: entries.length, problems };
}

function showResult(box, banner, summary, result, simulated) {
  box.replaceChildren();
  if (result.problems.length === 0) {
    box.dataset.state = "match";
    box.append(el("p", "check-title", `All ${result.files} files match their checksums, and the manifest matches its recorded hash.`), el("p", "small muted", "This shows the published files are consistent with their recorded hashes. It doesn't show who produced them, because these are checksums, not signatures."));
    renderOutcome(banner, summary);
    return;
  }
  box.dataset.state = "mismatch";
  box.append(el("p", "check-title", simulated ? "Simulated change detected: one byte was flipped in your browser's memory." : "This run's evidence failed the check."));
  const ul = el("ul", "reasons");
  for (const p of result.problems.slice(0, 8)) ul.append(el("li", "", p));
  box.append(ul);
  if (simulated) box.append(el("p", "small muted", "No published file changed. Run the check again to see the real result."));
  renderOutcome(banner, { ...summary, outcomeClass: "evidence_integrity_failure", evidence: { ...summary.evidence, status: "TAMPERED", reasons: result.problems } });
  if (simulated) banner.querySelector(".outcome-label").textContent = "Simulated: evidence integrity failure";
}

document.addEventListener("proofops:run-opened", (e) => {
  const summary = e.detail;
  const out = $("evidence-detail");
  const banner = out.querySelector(".outcome");
  const panel = el("section", "panel check-panel");
  panel.append(el("h3", "", "Check it yourself"), el("p", "body-copy", "Your browser fetches this run's files, hashes them with SHA-256, and compares them with the manifest and its separately recorded hash."));
  const row = el("div", "check-actions");
  const run = el("button", "primary", "Run the check");
  run.type = "button";
  run.id = "check-run";
  const flip = el("button", "ghost", "Change one byte, then check");
  flip.type = "button";
  flip.id = "check-flip";
  row.append(run, flip);
  const result = el("div", "check-result");
  result.id = "check-result";
  result.setAttribute("role", "status");
  panel.append(row, result);
  const go = async (simulated) => {
    run.disabled = flip.disabled = true;
    result.dataset.state = "running";
    result.replaceChildren(el("p", "small muted", "Hashing files…"));
    const r = await check(summary, { flipByteIn: simulated ? "report.md" : null });
    showResult(result, banner, summary, r, simulated);
    run.disabled = flip.disabled = false;
  };
  run.addEventListener("click", () => go(false));
  flip.addEventListener("click", () => go(true));
  banner.after(panel);
});

async function route() {
  const [head, a, b] = location.hash.replace(/^#/, "").split("/");
  if (head === "compare" && a && b) {
    $("compare-a").value = a;
    $("compare-b").value = b;
    await openCompare(a, b);
  } else if (head === "evidence" && a) await openRun(a);
}
window.addEventListener("hashchange", route);
$("compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  location.hash = `#compare/${$("compare-a").value}/${$("compare-b").value}`;
});
$("compare-b").addEventListener("change", () => { $("compare-b").dataset.touched = "1"; });

await loadEvidenceList();
// Start the comparison on the pair that tells the story.
$("compare-a").value = "run_20261104154509_8ec3eec5addfeed1";
$("compare-b").value = "run_20261104154518_b6a586f4a0ec403d";
await route();
