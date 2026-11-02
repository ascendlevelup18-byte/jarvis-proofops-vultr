// Proof-chain "Details" must never change the URL hash: the hash router treats "#evidence-panel"
// as an unknown route and redirects to the dashboard (seen in Judge Mode media QA, 17 Oct).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { followProofStep } from "../src/lib/proof.ts";

describe("proof step navigation", () => {
  test("scrolls to the panel when it is on the page", () => {
    let scrolled = 0;
    let opened = 0;
    const result = followProofStep("evidence-panel", (id) => (id === "evidence-panel" ? { scrollIntoView: () => scrolled++ } : null), () => opened++);
    assert.equal(result, "scrolled");
    assert.equal(scrolled, 1);
    assert.equal(opened, 0);
  });

  test("opens the case elsewhere when the panel is not on the page (Judge Mode)", () => {
    const seen: string[] = [];
    assert.equal(followProofStep("authorization-gate", () => null, (a) => seen.push(a)), "opened");
    assert.deepEqual(seen, ["authorization-gate"]);
  });

  test("does nothing rather than navigate when there is nowhere to go", () => {
    assert.equal(followProofStep("execution-panel", () => null), "none");
  });

  test("the step link prevents the default hash navigation and Judge Mode supplies a fallback", () => {
    const chain = readFileSync(new URL("../src/components/proof/ProofChain.tsx", import.meta.url), "utf8");
    assert.match(chain, /e\.preventDefault\(\);\s*followProofStep\(/);
    const judge = readFileSync(new URL("../src/pages/JudgePage.tsx", import.meta.url), "utf8");
    assert.match(judge, /<ProofChain caseData=\{selectedSlot\.result\} onOpenStep=/);
  });
});
