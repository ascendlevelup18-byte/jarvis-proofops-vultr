// Verifies every committed evidence bundle against its recorded anchor. Run from a clone, with Node 24 and no install:
//   node --no-warnings proof/verify-all.mjs
// Prints each bundle's status. PASS and FAIL are the sealed verdicts, so a designed FAIL is not a problem.
// Exits non-zero if any bundle reads TAMPERED. These are checksums, not signatures: see README, Evidence integrity.
import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEvidence } from "../apps/proofops/src/evidence.ts";

const proof = dirname(fileURLToPath(import.meta.url));
const roots = ["vultr-live-20261104/runs-d14d24c", "vultr-live-20261104/forced-attack", "vultr-live-20261104/runs-e5300f9", "vultr-live-20261104/runs-550b51c", "vultr-20261104/runs-446dcb2", "vultr-20261104/runs"];
const tally = {};
let tampered = 0;
for (const root of roots) {
  const dir = join(proof, root);
  const anchorFile = join(dir, "ANCHORS.txt");
  const anchors = fs.existsSync(anchorFile) ? Object.fromEntries(fs.readFileSync(anchorFile, "utf8").trim().split("\n").map((l) => l.trim().split(" "))) : {};
  console.log(`\n${root} (${Object.keys(anchors).length ? "checked against anchors" : "no anchors recorded: file hashes against the manifest only"})`);
  for (const run of fs.readdirSync(dir).filter((d) => d.startsWith("run_"))) {
    const c = classifyEvidence(join(dir, run), anchors[run]);
    tally[c.status] = (tally[c.status] ?? 0) + 1;
    if (c.status === "TAMPERED") tampered++;
    console.log(`  ${c.status.padEnd(10)} ${run}  ${c.files} files${c.reasons.length ? `  (${c.reasons.join("; ")})` : ""}`);
  }
}
console.log(`\n${JSON.stringify(tally)}. ${tampered ? `${tampered} TAMPERED.` : "None TAMPERED."}`);
process.exit(tampered ? 1 : 0);
