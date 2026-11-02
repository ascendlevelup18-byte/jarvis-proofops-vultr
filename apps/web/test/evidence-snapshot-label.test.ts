import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The evidence bundle is gathered before any action. On a RESOLVED case its financial
// state still reads OVERPAID, so the panel must say the figures are the intake snapshot.
const src = readFileSync(join(import.meta.dirname, "../src/components/panels/EvidencePanel.tsx"), "utf8");

test("evidence panel labels its records as the intake snapshot (before any action)", () => {
  assert.match(src, /Financial state at intake/);
  assert.match(src, /before any action/);
});
