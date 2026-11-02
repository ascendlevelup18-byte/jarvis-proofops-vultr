// Adversarial figure check: one rule for boardroom findings, proposals, notes and private replies.
// An unsupported number is never displayed; the statement that carries it is withheld.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENTS } from "../src/team/agents.ts";
import { scopedContext } from "../src/team/context.ts";
import { unsupportedFigures, withholdUnsupported } from "../src/team/figures.ts";
import { runBoardroom } from "../src/team/orchestrator.ts";
import { FixtureTeamProvider, type TeamProvider } from "../src/team/provider.ts";
import { fixtureAnalysis, fixtureReply } from "../src/team/specialists.ts";

const cfo = scopedContext("cfo");
const gm = cfo.metrics.grossMarginPct!;
const rev = cfo.metrics.netRevenue!;

describe("figure formats", () => {
  test("supported values pass in their honest forms", () => {
    assert.deepEqual(unsupportedFigures(`Gross margin moved from ${gm.first}% to ${gm.last}%.`, cfo), []);
    assert.deepEqual(unsupportedFigures(`Net revenue was $${rev.last.toLocaleString("en-US")}.`, cfo), []);
    assert.deepEqual(unsupportedFigures("Six months of records, M-2026-04 to M-2026-09, 3 channels.", cfo), []);
  });

  const fabricated: [string, string][] = [
    ["percentage", "Margin is 61.4%."],
    ["money", "Refunds cost $48,213 last month."],
    ["scientific notation", "Profit rose 6.14e1% in September."],
    ["leading dot", "Conversion is .614 of target."],
    ["magnitude word", "We lost $1.2M to refunds."],
    ["thousand suffix", "Support costs rose by 75k."],
    ["full-width digits", "Margin is ６１.４%."],
    ["other-script digits", "Margin is ٦١٫٤ percent."],
    ["spelled out", "Margin fell by sixty one percent."],
    ["small percentage is not a free count", "Refunds fell 7%."],
    ["year-like percentage", "Revenue up 2026% year on year."],
    ["unsupported calculation", `Margin will recover to ${(gm.first + 9.3).toFixed(2)}% next month.`],
  ];
  for (const [name, text] of fabricated)
    test(`rejects ${name}`, () => assert.ok(unsupportedFigures(text, cfo).length > 0, text));
});

describe("withholding", () => {
  test("a reply keeps verified sentences and withholds the rest without repeating the figure", () => {
    const r = withholdUnsupported(`Gross margin is ${gm.last}% [grossMarginPct]. It will hit 61.4% soon! Refunds cost $9,999,999.\nPlan a review.`, cfo);
    assert.equal(r.withheld, 2);
    assert.match(r.text, new RegExp(String(gm.last).replace(".", "\\.")));
    assert.doesNotMatch(r.text, /61\.4|9,999,999/);
    assert.match(r.text, /2 statements withheld/);
    assert.deepEqual(r.figures.sort(), ["$9,999,999", "61.4%"].sort());
  });

  test("a reply made only of unsupported figures shows only the notice", () => {
    const r = withholdUnsupported("Margin is 99.9%.", cfo);
    assert.equal(r.text, "[JARVIS check: 1 statement withheld because it used a figure not in the data.]");
  });

  test("text without numbers is returned unchanged", () => {
    const t = "Line one.\nLine two.";
    assert.equal(withholdUnsupported(t, cfo).text, t);
  });

  test("every fixture reply already passes the rule (no withholding in the deterministic demo)", () => {
    for (const a of AGENTS) {
      const ctx = scopedContext(a.id);
      const r = fixtureReply(a.id, "What changed in margin, refunds and support?", ctx);
      assert.equal(withholdUnsupported(r.text, ctx).withheld, 0, a.id);
    }
  });
});

describe("boardroom uses the same rule for findings, proposals and notes", () => {
  test("malicious output: figures hidden in proposals, success metrics and notes are all withheld", async () => {
    const hostile: TeamProvider = {
      info: { kind: "live", name: "test", model: "test/model" },
      async analyze(agent, task, ctx) {
        const out = fixtureAnalysis(agent, task, ctx);
        out.recommendations = [
          { id: "h-1", action: "Raise prices 15% now", lever: "pricing", direction: "increase", successMetric: "margin", owner: agent, requiresApproval: true },
          { id: "h-2", action: "Review refunds", lever: "refunds", direction: "decrease", successMetric: "save $500,000", owner: agent, requiresApproval: true },
          ...out.recommendations.slice(0, 1),
        ];
        out.missingInformation = ["Competitor margin is 72%", "Carrier contract terms"];
        return { output: out, provider: this.info, latencyMs: 1, tokensIn: null, tokensOut: null, costUsd: null };
      },
      reply: new FixtureTeamProvider().reply,
    };
    const r = await runBoardroom("Margins are falling. Investigate.", hostile);
    const shown = JSON.stringify(r.report);
    assert.doesNotMatch(shown, /(?<![\d.])15%|\$500,000|72%/);
    assert.ok(!r.report.actions.some((a) => a.id.startsWith("h-")));
    assert.ok(r.report.missingInformation.includes("Carrier contract terms"));
    assert.ok(r.audit.filter((e) => e.type === "FIGURE_REJECTED").length >= 3);
  });

  test("the deterministic fixture boardroom loses nothing to the rule", async () => {
    const r = await runBoardroom("Our business is underperforming. Investigate the reasons and propose improvements.", new FixtureTeamProvider());
    assert.equal(r.audit.filter((e) => e.type === "FIGURE_REJECTED").length, 0);
    assert.ok(r.report.actions.length > 0);
  });
});

describe("live-run fixes (17–18 Oct evidence)", () => {
  test("free-text levers map onto the fixed vocabulary; the mission's refund lever is recognised", async () => {
    const { normalizeLever } = await import("../src/team/orchestrator.ts");
    assert.equal(normalizeLever("refunds", "x"), "refunds");
    assert.equal(normalizeLever("refund reduction", "Implement AI-driven quality check to reduce refunds"), "refunds");
    assert.equal(normalizeLever("refundCostSharePct", "Stricter return-policy controls"), "refunds");
    assert.equal(normalizeLever("lateShipmentPct", "Shipment tracking alerts"), "fulfilment");
    assert.equal(normalizeLever("firstResponseHours", "AI-driven ticket routing"), "supportAutomation");
    assert.equal(normalizeLever("marketing efficiency", "Run A/B tests on ad creatives"), "marketingSpend");
    assert.equal(normalizeLever("lower CAC", "x"), "acquisitionChannels");
    assert.equal(normalizeLever("leads", "x"), "leads");
    assert.equal(normalizeLever("lead quality", "x"), "productQuality");
    assert.equal(normalizeLever("COGS reduction", "Renegotiate supplier contracts"), "costs");
    assert.equal(normalizeLever("Something Else", "nothing matches here"), "something else");
  });

  test("a 100% bound is not treated as an invented figure", () => {
    assert.deepEqual(unsupportedFigures("Bring utilization below 100%.", cfo), []);
  });
});
