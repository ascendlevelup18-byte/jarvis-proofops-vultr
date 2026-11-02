// Deployment config invariants for the public fixture demo (Vercel + Netlify).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("../../../", import.meta.url);
const vercel = JSON.parse(readFileSync(new URL("vercel.json", ROOT), "utf8")) as {
  rewrites: { source: string; destination: string }[];
  git?: { deploymentEnabled?: Record<string, boolean> };
  env?: unknown;
  build?: { env?: unknown };
};

test("vercel.json: /cases goes to the function, and the SPA fallback never swallows /api", () => {
  assert.deepEqual(vercel.rewrites[0], { source: "/cases", destination: "/api/cases" });
  const spa = vercel.rewrites.find((r) => r.destination === "/index.html");
  assert.ok(spa);
  const re = new RegExp(`^${spa.source}$`);
  for (const p of ["/", "/cases-view", "/operations"]) assert.ok(re.test(p), p);
  for (const p of ["/api/cases", "/api/health"]) assert.ok(!re.test(p), p);
});

test("vercel.json: no inline env (no model keys); commit-triggered master deploys disabled (only once this file is on master)", () => {
  assert.equal(vercel.env, undefined);
  assert.equal(vercel.build?.env, undefined);
  assert.equal(vercel.git?.deploymentEnabled?.master, false);
  assert.equal(vercel.git?.deploymentEnabled?.['post-submission/audit-hardening-2026-10-16'], false);
});

test("web source never references model credentials or server-only env", () => {
  const files: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const u = new URL(`${name}`, dir);
      if (statSync(u).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(ts|tsx)$/.test(name)) files.push(readFileSync(u, "utf8"));
    }
  };
  walk(new URL("apps/web/src/", ROOT));
  assert.ok(files.length > 10);
  for (const src of files) {
    assert.doesNotMatch(src, /JARVIS_MODEL|JARVIS_CASES_TOKEN|API_KEY/);
    assert.doesNotMatch(src, /import\.meta\.env\.VITE_[A-Z_]*(KEY|TOKEN|SECRET)/);
  }
});
