// Evidence bundle integrity check.
// These are SHA-256 checksums, not signatures: they prove the bundle has not changed since the control plane
// sealed it, relative to the manifest hash anchored outside the bundle (in the run registry and the API).
// They do not prove that what a compromised worker observed was true; the verifier's server-side
// cross-check is what limits that.
//   node apps/proofops/src/evidence.ts <evidence-dir> [expected-manifest-sha256]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
  // Files that are not in the manifest are reported (substitution by addition), except the two written after it.
  const unlisted = listFiles(dir).filter((f) => !(f in files) && !["manifest.json", "report.md", "events.jsonl"].includes(f));
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node apps/proofops/src/evidence.ts <evidence-dir> [expected-manifest-sha256]");
    process.exit(2);
  }
  const r = verifyEvidence(dir, process.argv[3]);
  console.log(JSON.stringify({ dir, manifestSha256: manifestHash(dir), ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}
