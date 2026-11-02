// Proof Mode logic against real engine output (see real-cases.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Case } from "../src/lib/case-types.ts";
import { deriveProofChain, describeAuditEvent, explainDecision, showdownRows, type ProofStage } from "../src/lib/proof.ts";
import { deriveRuntimeTruth } from "../src/lib/runtime-truth.ts";
import { presentsFalseSuccess } from "../src/lib/outcome-guards.ts";
import {
  demoCase,
  failedVerificationCase,
  malformedProposalCase,
  missingEvidenceCase,
  providerFailureCase,
} from "./real-cases.ts";

const stage = (c: Case, id: ProofStage["id"]) => deriveProofChain(c).find((s) => s.id === id)!;
const statuses = (c: Case) => Object.fromEntries(deriveProofChain(c).map((s) => [s.id, s.status]));

describe("proof chain on the four canonical demos (real engine output)", () => {
  test("valid duplicate: every stage done, refund allowed and verified", async () => {
    const c = await demoCase("valid-duplicate");
    assert.equal(c.state, "RESOLVED");
    assert.deepEqual(statuses(c), {
      complaint: "done",
      understanding: "done",
      evidence: "done",
      proposal: "done",
      policy: "done",
      execution: "done",
      verification: "done",
    });
    assert.match(stage(c, "policy").detail, /Authorized \$89\.99 on CHARGE-48291-B \(amount from records\)/);
    assert.match(stage(c, "verification").headline, /Read-back confirmed/);
    const why = explainDecision(c);
    assert.equal(why.kind, "allowed");
    assert.match(why.points.join("\n"), /derived from the payment records/);
    assert.match(why.points.join("\n"), /simulated/);
  });

  test("conflicting amount: AI proposed a refund, policy blocked it, nothing executed", async () => {
    const c = await demoCase("conflicting-amount");
    assert.equal(c.state, "ESCALATED");
    const s = statuses(c);
    assert.equal(s.evidence, "blocked");
    assert.equal(s.proposal, "done");
    assert.equal(s.policy, "blocked");
    assert.equal(s.execution, "skipped");
    assert.equal(s.verification, "skipped");
    assert.match(stage(c, "evidence").detail, /contradiction/);
    const why = explainDecision(c);
    assert.equal(why.kind, "blocked");
    assert.ok(why.points.includes("The AI proposed a refund; deterministic policy overrode it"));
    assert.ok(why.points.some((p) => p.startsWith("EVIDENCE CONTRADICTION")));
    assert.equal(why.points.at(-1), "$0.00 dispatched — routed to a human");
  });

  test("already refunded: policy NO_ACTION, execution gate locked", async () => {
    const c = await demoCase("already-refunded");
    assert.equal(c.state, "CLOSED_NO_ACTION");
    assert.match(stage(c, "policy").headline, /^NO_ACTION/);
    assert.equal(stage(c, "execution").status, "skipped");
    assert.match(stage(c, "execution").detail, /gate locked \(NO_ACTION\)/);
    assert.equal(explainDecision(c).kind, "no-action");
  });

  test("prompt injection: escalated, no refund, never presented as success", async () => {
    const c = await demoCase("prompt-injection");
    assert.equal(c.state, "ESCALATED");
    assert.equal(stage(c, "policy").status, "blocked");
    assert.equal(c.action, null);
    assert.equal(presentsFalseSuccess(c), false);
    assert.match(explainDecision(c).points.join("\n"), /\$0\.00 dispatched/);
  });

  test("execution and verification are never 'done' without recorded data", async () => {
    for (const id of ["conflicting-amount", "already-refunded", "prompt-injection"] as const) {
      const c = await demoCase(id);
      assert.notEqual(stage(c, "execution").status, "done", id);
      assert.notEqual(stage(c, "verification").status, "done", id);
    }
  });
});

describe("proof chain on failure paths (real engine output)", () => {
  test("failed verification: execution failed, read-back did not confirm, never RESOLVED", async () => {
    const c = await failedVerificationCase();
    assert.equal(c.state, "FAILED");
    assert.equal(stage(c, "execution").status, "failed");
    assert.equal(stage(c, "verification").status, "failed");
    assert.match(stage(c, "verification").headline, /did NOT confirm/);
    const why = explainDecision(c);
    assert.equal(why.kind, "failed");
    assert.ok(why.points.includes("Never marked RESOLVED: the refund could not be confirmed"));
  });

  test("provider failure: understanding failed with the real error; later stages not reached", async () => {
    const c = await providerFailureCase();
    assert.equal(c.state, "FAILED");
    const u = stage(c, "understanding");
    assert.equal(u.status, "failed");
    assert.equal(u.headline, "UNDERSTANDING_ERROR");
    assert.match(u.detail, /503/);
    for (const id of ["evidence", "proposal", "policy", "execution", "verification"] as const) {
      assert.equal(stage(c, id).status, "not-reached", id);
    }
    assert.ok(explainDecision(c).points.includes("$0.00 dispatched — no refund was attempted"));
  });

  test("missing proposal: malformed model output fails the proposal stage; nothing executed", async () => {
    const c = await malformedProposalCase();
    assert.equal(c.state, "FAILED");
    assert.equal(c.proposal, null);
    assert.equal(stage(c, "evidence").status, "done");
    assert.equal(stage(c, "proposal").status, "failed");
    assert.equal(stage(c, "proposal").headline, "MODEL_OUTPUT_INVALID");
    assert.equal(stage(c, "execution").status, "not-reached");
  });

  test("missing evidence: unknown order is blocked at evidence with the engine's reason", async () => {
    const c = await missingEvidenceCase();
    assert.equal(c.state, "ESCALATED");
    assert.equal(c.evidence, null);
    const e = stage(c, "evidence");
    assert.equal(e.status, "blocked");
    assert.equal(e.headline, "ORDER NOT FOUND");
    assert.equal(stage(c, "proposal").status, "not-reached");
  });
});

describe("audit trail and safety showdown", () => {
  test("every audit line comes from a recorded event, with real adapter, policy and gateway content", async () => {
    const c = await demoCase("valid-duplicate");
    const lines = c.audit.map(describeAuditEvent);
    assert.equal(lines.length, c.audit.length);
    assert.ok(lines.every((l) => l.title.length > 0));
    const text = lines.map((l) => `${l.title} | ${l.detail}`).join("\n");
    assert.match(text, /Understanding call · fixture-understanding \| output recorded · \d+ ms/);
    assert.match(text, /Decision call · fixture-model/);
    assert.match(text, /Policy evaluated \| APPROVE · \d+\/\d+ checks passed/);
    assert.match(text, /Pre-execution revalidation \| APPROVE/);
    assert.match(text, /Refund sent to simulated gateway \| ACCEPTED/);
    assert.match(text, /Read-back verification \| verified/);
    assert.equal(lines.filter((l) => l.origin === "ai").length, 2);
  });

  test("a failed AI call shows its recorded error", async () => {
    const c = await providerFailureCase();
    const call = c.audit.map(describeAuditEvent).find((l) => l.title.startsWith("Understanding call"))!;
    assert.match(call.detail, /error: provider HTTP 503/);
  });

  test("showdown: safe duplicate moves $89.99 verified; injected case moves nothing", async () => {
    const rows = Object.fromEntries(
      showdownRows(await demoCase("valid-duplicate"), await demoCase("prompt-injection")).map((r) => [r.label, [r.a, r.b]]),
    );
    assert.deepEqual(rows["AI proposal"], ["REFUND DUPLICATE", "REFUND DUPLICATE"]);
    assert.deepEqual(rows["Policy outcome"], ["APPROVE", "DENY"]);
    assert.deepEqual(rows["Refund executed"], ["ACCEPTED (simulated)", "Not executed"]);
    assert.deepEqual(rows["Money observed moving"], ["$89.99", "$0.00"]);
    assert.deepEqual(rows["Read-back verified"], ["Yes", "Not applicable"]);
    assert.deepEqual(rows["Final state"], ["RESOLVED", "ESCALATED"]);
  });

  test("session isolation: the same demo run twice resolves twice in separate cases", async () => {
    const a = await demoCase("valid-duplicate");
    const b = await demoCase("valid-duplicate");
    assert.notEqual(a.id, b.id);
    assert.equal(a.state, "RESOLVED");
    assert.equal(b.state, "RESOLVED");
  });
});

describe("runtime truth labels", () => {
  test("fixture health: fixture AI, simulated payments, AMD not verified, Evolus not connected", () => {
    const t = deriveRuntimeTruth({ ok: true, deployment: "vercel", aiMode: "fixture", remoteModel: false, paymentGateway: "simulated" });
    assert.equal(t.ai.value, "FIXTURE AI");
    assert.equal(t.gateway.value, "SIMULATED");
    assert.equal(t.amdHardware.value, "NOT VERIFIED");
    assert.equal(t.evolus.value, "NOT CONNECTED");
    assert.equal(t.deployment.value, "VERCEL");
  });

  test("a working vLLM endpoint still does not prove AMD hardware", () => {
    const t = deriveRuntimeTruth({ ok: true, deployment: "node-server", aiMode: "vllm", model: "qwen2.5-7b-instruct", remoteModel: true });
    assert.equal(t.ai.value, "MODEL · qwen2.5-7b-instruct");
    assert.equal(t.amdHardware.value, "NOT VERIFIED");
    assert.match(t.amdHardware.detail, /does not prove/);
  });

  test("no health answer: nothing is claimed", () => {
    const t = deriveRuntimeTruth(null);
    assert.equal(t.ai.value, "UNKNOWN");
    assert.equal(t.deployment.value, "UNKNOWN");
    assert.equal(t.gateway.value, "SIMULATED");
  });
});
