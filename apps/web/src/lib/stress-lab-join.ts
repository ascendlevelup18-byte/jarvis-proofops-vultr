// Policy Stress Lab: joins the pinned dataset with the two committed result files, field for field.
// Pure and copy-only: nothing here computes an outcome, it only reports what the files record.

export interface StressLabMoney {
  transactionId: string;
  amountMinor: number;
}

export interface StressLabRow {
  id: string;
  category: string;
  title: string;
  risk: string;
  tags: string[];
  rationale: string;
  message: string;
  currency: string;
  orderTotalMinor: number | null;
  charges: { id: string; amountMinor: number; status: string }[];
  priorRefunds: { id: string; transactionId: string; amountMinor: number }[];
  /** The dataset supplies the decision output instead of the fixture proposer (deliberately hostile). */
  scriptedProposal: boolean;
  proposal: string;
  expected: { finalState: string; action: { type: string; transactionId?: string; amountMinor?: number } | null };
  jarvis: { finalState: string; classification: string; moneyMoved: StressLabMoney[]; reasons: string[] };
  noPolicy: { finalState: string; classification: string; moneyMoved: StressLabMoney[]; unsafe: boolean };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function buildStressLabRows(dataset: Json, fixtureEval: Json, baseline: Json): StressLabRow[] {
  const evalById = new Map<string, Json>(fixtureEval.cases.map((c: Json) => [c.id, c]));
  const baseById = new Map<string, Json>(baseline.cases.map((c: Json) => [c.id, c]));
  return dataset.cases.map((c: Json): StressLabRow => {
    const ev = evalById.get(c.id);
    const b = baseById.get(c.id);
    if (!ev || !b) throw new Error(`case ${c.id} missing from a result file`);
    const order = c.world.orders?.find((o: Json) => o.id === c.request.orderId) ?? null;
    const money = (m: Json[]): StressLabMoney[] => m.map((x) => ({ transactionId: x.transactionId, amountMinor: x.amountMinor }));
    return {
      id: c.id,
      category: c.category,
      title: c.title,
      risk: c.risk,
      tags: c.tags ?? [],
      rationale: c.rationale,
      message: c.request.message,
      currency: order?.currency ?? c.world.transactions?.[0]?.currency ?? "USD",
      orderTotalMinor: order?.totalMinor ?? null,
      charges: (c.world.transactions ?? []).filter((t: Json) => t.orderId === c.request.orderId).map((t: Json) => ({ id: t.id, amountMinor: t.amountMinor, status: t.status })),
      priorRefunds: (c.world.refunds ?? []).map((r: Json) => ({ id: r.id, transactionId: r.transactionId, amountMinor: r.amountMinor })),
      scriptedProposal: Boolean(b.scriptedProposal),
      proposal: b.proposal,
      expected: { finalState: c.expected.finalState, action: c.expected.action ?? null },
      jarvis: { finalState: ev.actual.finalState, classification: ev.classification, moneyMoved: money(ev.actual.moneyMoved), reasons: [...ev.actual.reasons] },
      noPolicy: { finalState: b.noPolicy.finalState, classification: b.noPolicy.classification, moneyMoved: money(b.noPolicy.moneyMoved), unsafe: Boolean(b.noPolicy.unsafe) },
    };
  });
}
