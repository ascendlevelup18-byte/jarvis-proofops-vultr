// Builds the Evidence Explorer: a static, read-only site of recorded runs, with no server and no model calls.
//   node apps/proofops/src/build-explorer.ts [--out dist/explorer] [--proof proof] [--featured vultr-live-20261104/runs-d14d24c]
// Only files named in a run's manifest are copied, byte for byte, so a visitor's browser can re-hash what a clone would.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEvidence, verifyEvidence } from "./evidence.ts";
import { classifyOutcome, compareRuns, readRunSummary, type RunSummary } from "./run-summary.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
};
const OUT = resolve(ROOT, arg("out", "dist/explorer"));
const PROOF = resolve(ROOT, arg("proof", "proof"));
const FEATURED = arg("featured", "vultr-live-20261104/runs-d14d24c");
const SETS: { path: string; label: string; forced?: boolean }[] = [
  { path: "vultr-live-20261104/runs-d14d24c", label: "Live model, release d14d24c" },
  { path: "vultr-live-20261104/runs-e5300f9", label: "Live model, earlier build e5300f9" },
  { path: "vultr-live-20261104/runs-550b51c", label: "Live model, earlier build 550b51c" },
  { path: "vultr-live-20261104/forced-attack", label: "Scripted forced-proposal test", forced: true },
  { path: "vultr-20261104/runs-446dcb2", label: "Scripted on Vultr, build 446dcb2" },
  { path: "vultr-20261104/runs", label: "Scripted on Vultr, first deployment" },
];
const UI = join(ROOT, "apps/proofops/ui");
const EXPLORER = join(ROOT, "apps/proofops/explorer");
const RUN_DIR = /^run_\d{14}_[0-9a-f]{8,16}$/;
const SAFE_FILE = /^(?:[A-Za-z0-9._-]{1,100}\/)?[A-Za-z0-9._-]{1,100}\.(json|jsonl|md|png|txt)$/;

function anchorsIn(dir: string): Map<string, string> {
  const anchors = new Map<string, string>();
  const file = join(dir, "ANCHORS.txt");
  if (!existsSync(file)) return anchors;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [id, hash] = line.trim().split(/\s+/);
    if (id && hash) anchors.set(id, hash);
  }
  return anchors;
}
const runsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => RUN_DIR.test(n)).sort() : []);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "data", "runs"), { recursive: true });
mkdirSync(join(OUT, "data", "compare"), { recursive: true });
for (const f of ["styles.css", "verdict.js", "views.js"]) cpSync(join(UI, f), join(OUT, f));
for (const f of ["index.html", "explorer.js", "explorer.css"]) cpSync(join(EXPLORER, f), join(OUT, f));
writeFileSync(join(OUT, ".nojekyll"), ""); // serve every file exactly as written

// ---- The six featured runs: full summaries and their evidence files ----
const featuredDir = join(PROOF, FEATURED);
const featuredAnchors = anchorsIn(featuredDir);
const summaries: RunSummary[] = [];
for (const id of runsIn(featuredDir)) {
  const dir = join(featuredDir, id);
  const s = readRunSummary({ runId: id, dir, anchor: featuredAnchors.get(id), source: "archive" });
  if (s.evidence.status === "TAMPERED") throw new Error(`${id} fails its integrity check; refusing to publish it`);
  summaries.push(s);
  writeFileSync(join(OUT, "data", "runs", `${id}.json`), JSON.stringify(s));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: Record<string, string> };
  for (const rel of [...Object.keys(manifest.files), "manifest.json"].sort()) {
    if (!SAFE_FILE.test(rel)) throw new Error(`${id}: refusing to publish ${rel}`);
    const src = join(dir, rel);
    if (!lstatSync(src).isFile()) throw new Error(`${id}: ${rel} is not a regular file`);
    const dest = join(OUT, "runs", id, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}
if (summaries.length === 0) throw new Error(`no runs in ${featuredDir}`);
for (const a of summaries) {
  for (const b of summaries) {
    if (a.runId !== b.runId) writeFileSync(join(OUT, "data", "compare", `${a.runId}__${b.runId}.json`), JSON.stringify(compareRuns(a, b)));
  }
}
const STORY = ["Wrong discount", "Correct discount", "Hostile page", "Approved checkout", "Broken checkout", "Hung page"];
const rank = (s: RunSummary) => { const i = STORY.indexOf(s.mission?.title ?? ""); return i === -1 ? STORY.length : i; };
writeFileSync(join(OUT, "data", "history.json"), JSON.stringify([...summaries].sort((x, y) => rank(x) - rank(y)).map((x) => ({
  runId: x.runId, source: x.source, title: x.mission?.title ?? x.mode, tier: x.tier, status: x.status, verdict: x.verdict, outcomeClass: x.outcomeClass, missionOutcome: x.missionOutcome,
  evidenceStatus: x.evidence.status, integrityStatus: x.evidence.integrity_status, provider: x.model?.provider ?? null, model: x.model?.requested ?? null, at: x.startedAt, steps: x.steps.length,
}))));

// ---- The whole library: one summary row per bundle, linked to the evidence tag ----
const library: Record<string, unknown>[] = [];
for (const set of SETS) {
  const dir = join(PROOF, set.path);
  const anchors = anchorsIn(dir);
  for (const id of runsIn(dir)) {
    const bundle = join(dir, id);
    const anchor = anchors.get(id);
    const c = classifyEvidence(bundle, anchor);
    const s = readRunSummary({ runId: id, dir: bundle, anchor, source: "archive" });
    const filesOk = verifyEvidence(bundle, anchor).ok;
    const cls = classifyOutcome({ status: s.status, verdict: s.verdict, outcomes: s.outcomes, evidenceStatus: c.status, expected: set.forced ? null : s.mission?.expected ?? null });
    library.push({
      runId: id, set: set.label, path: `${set.path}/${id}`,
      mission: set.forced ? "Forced-proposal test" : s.mission?.title ?? s.mode, tier: s.tier, planner: s.model?.provider ?? null, code: s.codeSha?.slice(0, 7) ?? null,
      recordedVerdict: s.verdict, evidenceClass: c.status, designed: cls === "designed_negative", reasons: c.reasons.slice(0, 3),
      integrity: !filesOk ? "TAMPERED" : anchor ? "ANCHOR VERIFIED" : "NO ANCHOR", files: c.files, featured: summaries.some((x) => x.runId === id), at: s.startedAt,
    });
  }
}
writeFileSync(join(OUT, "data", "library.json"), JSON.stringify(library));
console.log(`Evidence Explorer: ${summaries.length} featured runs and ${library.length} library rows written to ${OUT}`);
