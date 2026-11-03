// UNIT tier: run registry (SQLite WAL), idempotency, legal transitions and crash recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/store.ts";

test("same idempotency key never creates a second run", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofops-store-"));
  const s = new RunStore(join(dir, "runs.db"));
  try {
    const a = s.create({ id: "run_a", idempotencyKey: "k1", mode: "normal", tier: "LOCAL_MODEL_STUB" });
    const b = s.create({ id: "run_b", idempotencyKey: "k1", mode: "normal", tier: "LOCAL_MODEL_STUB" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.run.id, "run_a");
    assert.equal(s.list().length, 1);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finished runs cannot be reopened; bad values are rejected by the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofops-store-"));
  const s = new RunStore(join(dir, "runs.db"));
  try {
    s.create({ id: "run_a", idempotencyKey: null, mode: "normal", tier: "LOCAL_MODEL_STUB" });
    s.update("run_a", { status: "running" });
    s.update("run_a", { status: "completed", verdict: "FAIL" });
    assert.throws(() => s.update("run_a", { status: "running" }), /already completed/);
    s.create({ id: "run_b", idempotencyKey: null, mode: "normal", tier: "LOCAL_MODEL_STUB" });
    assert.throws(() => s.update("run_b", { status: "completed", verdict: "MAYBE" }));
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart marks interrupted runs failed, never leaving them looking alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofops-store-"));
  const path = join(dir, "runs.db");
  const s1 = new RunStore(path);
  s1.create({ id: "run_live", idempotencyKey: null, mode: "normal", tier: "LIVE_VULTR_SANDBOX" });
  s1.update("run_live", { status: "running" });
  s1.create({ id: "run_done", idempotencyKey: null, mode: "normal", tier: "LIVE_VULTR_SANDBOX" });
  s1.update("run_done", { status: "running" });
  s1.update("run_done", { status: "completed", verdict: "PASS" });
  s1.close(); // simulated crash: no clean shutdown of run_live
  const s2 = new RunStore(path);
  try {
    assert.equal(s2.recoverInterrupted(), 1);
    assert.equal(s2.get("run_live")!.status, "failed");
    assert.match(s2.get("run_live")!.error!, /restarted/);
    assert.equal(s2.get("run_done")!.verdict, "PASS");
  } finally {
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
