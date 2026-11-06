// Builds the Evidence Explorer: a static, read-only site of sealed runs, with no server and no model calls.
//   node apps/proofops/src/build-explorer.ts [--out dist/explorer] [--runs proof/vultr-live-20261104/runs-d14d24c]
// Evidence files are copied byte for byte, so a visitor's browser can re-hash the same files a clone would.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, readRunSummary, type RunSummary } from "./run-summary.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
};
const OUT = resolve(ROOT, arg("out", "dist/explorer"));
const RUNS = resolve(ROOT, arg("runs", "proof/vultr-live-20261104/runs-d14d24c"));
const UI = join(ROOT, "apps/proofops/ui");
const EXPLORER = join(ROOT, "apps/proofops/explorer");
const RUN_DIR = /^run_\d{14}_[0-9a-f]{8,16}$/;

const anchors = new Map<string, string>();
for (const line of readFileSync(join(RUNS, "ANCHORS.txt"), "utf8").split("\n")) {
  const [id, hash] = line.trim().split(/\s+/);
  if (id && hash) anchors.set(id, hash);
}
const ids = readdirSync(RUNS).filter((n) => RUN_DIR.test(n)).sort();
if (ids.length === 0) throw new Error(`no runs in ${RUNS}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "data", "runs"), { recursive: true });
mkdirSync(join(OUT, "data", "compare"), { recursive: true });
for (const f of ["styles.css", "verdict.js", "views.js"]) cpSync(join(UI, f), join(OUT, f));
for (const f of ["index.html", "explorer.js", "explorer.css"]) cpSync(join(EXPLORER, f), join(OUT, f));
writeFileSync(join(OUT, ".nojekyll"), ""); // serve every file exactly as written

const summaries: RunSummary[] = [];
for (const id of ids) {
  const dir = join(RUNS, id);
  const s = readRunSummary({ runId: id, dir, anchor: anchors.get(id), source: "archive" });
  if (s.evidence.status === "TAMPERED") throw new Error(`${id} fails its integrity check; refusing to publish it`);
  summaries.push(s);
  writeFileSync(join(OUT, "data", "runs", `${id}.json`), JSON.stringify(s));
  cpSync(dir, join(OUT, "runs", id), { recursive: true });
}
for (const a of summaries) {
  for (const b of summaries) {
    if (a.runId !== b.runId) writeFileSync(join(OUT, "data", "compare", `${a.runId}__${b.runId}.json`), JSON.stringify(compareRuns(a, b)));
  }
}
const STORY = ["Wrong discount", "Correct discount", "Hostile page", "Approved checkout", "Broken checkout", "Hung page"];
const rank = (s: RunSummary) => { const i = STORY.indexOf(s.mission?.title ?? ""); return i === -1 ? STORY.length : i; };
writeFileSync(join(OUT, "data", "history.json"), JSON.stringify([...summaries].sort((x, y) => rank(x) - rank(y)).map((x) => ({
  runId: x.runId, source: x.source, title: x.mission?.title ?? x.mode, tier: x.tier, status: x.status, verdict: x.verdict, outcomeClass: x.outcomeClass,
  evidenceStatus: x.evidence.status, provider: x.model?.provider ?? null, model: x.model?.requested ?? null, at: x.startedAt,
}))));
if (!existsSync(join(OUT, "index.html"))) throw new Error("explorer page missing");
console.log(`Evidence Explorer: ${summaries.length} runs written to ${OUT}`);
