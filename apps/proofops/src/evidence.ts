// Evidence bundle integrity check.
// These are SHA-256 checksums, not signatures: they prove the bundle has not changed since the control plane
// sealed it, relative to the manifest hash anchored outside the bundle (in the run registry and the API).
// They do not prove that what a compromised worker observed was true; the verifier's server-side
// cross-check is what limits that.
//   node apps/proofops/src/evidence.ts <evidence-dir> [expected-manifest-sha256]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { specIntact, type FrozenSpec } from "./fixtures.ts";
import { fileURLToPath } from "node:url";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Hash of the manifest exactly as written; this is the anchor stored outside the bundle. */
export function manifestHash(dir: string): string {
  return sha256(readFileSync(join(dir, "manifest.json")));
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).replaceAll("\\", "/")];
  });
}

export function verifyEvidence(dir: string, anchoredManifestSha256?: string | null): { ok: boolean; problems: string[]; files: number } {
  const problems: string[] = [];
  let manifest: { runId?: string; files?: Record<string, string>; specSha256?: string };
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, problems: ["manifest.json missing or unreadable"], files: 0 };
  }
  if (anchoredManifestSha256 !== undefined) {
    if (!anchoredManifestSha256) problems.push("no anchored manifest hash to compare with");
    else if (manifestHash(dir) !== anchoredManifestSha256) problems.push("manifest.json does not match the anchored hash (manifest replaced or edited)");
  }
  const files = manifest.files ?? {};
  for (const [rel, expected] of Object.entries(files)) {
    try {
      if (sha256(readFileSync(join(dir, rel))) !== expected) problems.push(`${rel}: content changed`);
    } catch {
      problems.push(`${rel}: missing`);
    }
  }
  // Files that are not in the manifest are reported (substitution by addition).
  const unlisted = listFiles(dir).filter((f) => !(f in files) && f !== "manifest.json");
  for (const f of unlisted) problems.push(`${f}: not listed in manifest`);
  // The spec inside the bundle must be the one the manifest committed to.
  try {
    const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as { specSha256?: string };
    if (manifest.specSha256 && spec.specSha256 !== manifest.specSha256) problems.push("spec.json seal differs from the manifest's");
  } catch {
    problems.push("spec.json missing");
  }
  return { ok: problems.length === 0, problems, files: Object.keys(files).length };
}

export type EvidenceStatus = "PASS" | "FAIL" | "INCOMPLETE" | "TAMPERED";

const REQUIRED = ["spec.json", "scope.json", "assertions.json", "cleanup.json", "server-state.json", "policy-decisions.jsonl", "gateway.jsonl", "model-calls.jsonl", "events.jsonl", "report.md"];

/**
 * Independent verdict on a bundle, from the files alone:
 *   TAMPERED   - any file differs from the manifest, the manifest differs from its anchor, the run id or verdict
 *                disagree between files, or the frozen spec's seal is broken
 *   INCOMPLETE - a required record is absent, the verifier was inconclusive, or teardown is not proven
 *   PASS/FAIL  - the sealed verifier verdict
 * Without an anchor, a rewrite of both a file and the manifest cannot be detected; the result says so.
 */
export function classifyEvidence(dir: string, anchoredManifestSha256?: string | null) {
  const reasons: string[] = [];
  // A crash before sealing leaves no manifest: that is an unfinished run, unless one was anchored, which means removal.
  if (!existsSync(join(dir, "manifest.json"))) {
    return { status: (anchoredManifestSha256 ? "TAMPERED" : "INCOMPLETE") as EvidenceStatus,
      reasons: [anchoredManifestSha256 ? "sealed manifest was removed" : "bundle was never sealed (no manifest)"], runId: null, runStatus: null,
      integrity: "no manifest to check", files: 0 };
  }
  const integrity = verifyEvidence(dir, anchoredManifestSha256);
  let status: EvidenceStatus | null = integrity.ok ? null : "TAMPERED";
  reasons.push(...integrity.problems);
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } };
  const manifest = read("manifest.json") as { runId?: string; verdict?: string; status?: string; files?: Record<string, string> } | null;
  const assertions = read("assertions.json") as { verdict?: string; outcomes?: Record<string, string> } | null;
  const spec = read("spec.json") as FrozenSpec | null;
  const cleanup = read("cleanup.json") as { workerGone?: boolean | null } | null;
  if (manifest) {
    if (manifest.runId !== basename(dir)) { status = "TAMPERED"; reasons.push(`manifest runId ${manifest.runId} does not match the bundle ${basename(dir)}`); }
    if (assertions && manifest.verdict !== assertions.verdict) { status = "TAMPERED"; reasons.push("manifest verdict differs from the sealed verifier output"); }
    if (spec && !specIntact(spec)) { status = "TAMPERED"; reasons.push("frozen spec content no longer matches its seal"); }
    for (const f of REQUIRED) if (!(f in (manifest.files ?? {}))) { reasons.push(`${f} was never recorded`); status ??= "INCOMPLETE"; }
  }
  if (!status) {
    if (!assertions?.verdict || assertions.verdict === "INCONCLUSIVE") { status = "INCOMPLETE"; reasons.push("verifier result inconclusive"); }
    else if (cleanup?.workerGone !== true) { status = "INCOMPLETE"; reasons.push("worker teardown not proven"); }
    else status = assertions.verdict === "PASS" ? "PASS" : "FAIL";
  }
  return {
    status, reasons, runId: manifest?.runId ?? null, runStatus: manifest?.status ?? null,
    integrity: anchoredManifestSha256 ? "checked against anchored manifest hash (sha256 checksum, not a signature)"
      : "file hashes checked against the manifest only; without the anchor a rewritten manifest cannot be detected",
    files: integrity.files,
  };
}

/** Bounded retention: removes the oldest run bundles beyond keep. Run ids sort by time. Returns what was removed. */
export function pruneEvidence(root: string, keep: number): string[] {
  const runs = readdirSync(root).filter((n) => /^run_\d{14}_[0-9a-f]+$/.test(n)).sort();
  const old = runs.slice(0, Math.max(0, runs.length - keep));
  for (const n of old) rmSync(join(root, n), { recursive: true, force: true });
  return old;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node apps/proofops/src/evidence.ts <evidence-dir> [expected-manifest-sha256]");
    process.exit(2);
  }
  const r = classifyEvidence(dir, process.argv[3]);
  console.log(JSON.stringify({ dir, manifestSha256: existsSync(join(dir, "manifest.json")) ? manifestHash(dir) : null, ...r }, null, 2));
  process.exit(r.status === "PASS" || r.status === "FAIL" ? 0 : 1);
}
