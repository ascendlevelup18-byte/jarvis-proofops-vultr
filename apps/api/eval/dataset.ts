// Evaluation dataset contract: schema (shape) + semantic validation (integrity).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { CaseRequestSchema, CURRENCIES } from "../src/contracts.ts";

export const CATEGORY_COUNTS = { STRAIGHTFORWARD: 10, AMBIGUOUS: 10, CONTRADICTORY: 5, ADVERSARIAL_EDGE: 5 } as const;
export type Category = keyof typeof CATEGORY_COUNTS;
const CATEGORY_PREFIX: Record<Category, string> = { STRAIGHTFORWARD: "S", AMBIGUOUS: "A", CONTRADICTORY: "C", ADVERSARIAL_EDGE: "E" };
const HUMAN_STATES = new Set(["ESCALATED", "FAILED"]);

const Id = z.string().min(1).max(200);
const Minor = z.number().int().nonnegative();
const Currency = z.enum(CURRENCIES);

const WorldSchema = z
  .object({
    customers: z.array(z.object({ id: z.string().regex(/^CUST-\d{1,10}$/), name: z.string().min(1) }).strict()).min(1),
    orders: z.array(z.object({ id: Id, customerId: Id, totalMinor: Minor, currency: Currency }).strict()),
    transactions: z.array(
      z
        .object({
          id: Id,
          orderId: Id,
          customerId: Id,
          amountMinor: Minor,
          currency: Currency,
          status: z.enum(["SUCCEEDED", "FAILED", "PENDING"]),
          minutesAgo: z.number().nonnegative(),
        })
        .strict(),
    ),
    refunds: z
      .array(
        z
          .object({
            id: Id,
            transactionId: Id,
            amountMinor: Minor.positive(),
            currency: Currency,
            idempotencyKey: Id,
            minutesAgo: z.number().nonnegative(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const ExpectedSchema = z
  .object({
    finalState: z.enum(["RESOLVED", "ESCALATED", "FAILED", "CLOSED_NO_ACTION"]),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("REFUND"), transactionId: Id, amountMinor: Minor.positive() }).strict(),
      z.object({ type: z.literal("NONE") }).strict(),
    ]),
    humanEscalation: z.boolean(),
  })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^DC-[SACE]\d{2}$/),
    category: z.enum(["STRAIGHTFORWARD", "AMBIGUOUS", "CONTRADICTORY", "ADVERSARIAL_EDGE"]),
    title: z.string().min(1),
    world: WorldSchema,
    request: CaseRequestSchema,
    model: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixture") }).strict(),
        z.object({ kind: z.literal("raw"), output: z.string() }).strict(),
      ])
      .default({ kind: "fixture" }),
    setup: z
      .object({
        priorSubmissions: z.number().int().min(0).max(3).optional(),
        gatewayFault: z.enum(["TIMEOUT_BEFORE_COMMIT", "TIMEOUT_AFTER_COMMIT"]).optional(),
        midflightRefund: z.object({ transactionId: Id, amountMinor: Minor.positive() }).strict().optional(),
      })
      .strict()
      .default({}),
    expected: ExpectedSchema,
    risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    tags: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(10),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;

export const DatasetSchema = z
  .object({ datasetId: z.string().min(1), version: z.string().min(1), description: z.string(), cases: z.array(EvalCaseSchema) })
  .strict();
export type Dataset = z.infer<typeof DatasetSchema>;

// Integrity rules the schema cannot express. Returns human-readable errors (empty = valid).
export function validateDataset(d: Dataset): string[] {
  const errors: string[] = [];
  if (d.cases.length !== 30) errors.push(`expected exactly 30 cases, found ${d.cases.length}`);
  for (const [cat, n] of Object.entries(CATEGORY_COUNTS)) {
    const found = d.cases.filter((c) => c.category === cat).length;
    if (found !== n) errors.push(`expected ${n} ${cat} cases, found ${found}`);
  }
  const seen = new Set<string>();
  for (const c of d.cases) {
    const e = (msg: string) => errors.push(`${c.id}: ${msg}`);
    if (seen.has(c.id)) e("duplicate case id");
    seen.add(c.id);
    if (c.id[3] !== CATEGORY_PREFIX[c.category]) e(`id prefix does not match category ${c.category}`);

    const w = c.world;
    for (const [kind, list] of [
      ["customer", w.customers],
      ["order", w.orders],
      ["transaction", w.transactions],
      ["refund", w.refunds],
    ] as const) {
      const ids = list.map((x) => x.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) e(`duplicate ${kind} id ${dup}`);
    }
    const customers = new Set(w.customers.map((x) => x.id));
    const orders = new Set(w.orders.map((x) => x.id));
    const txs = new Set(w.transactions.map((x) => x.id));
    for (const o of w.orders) if (!customers.has(o.customerId)) e(`order ${o.id} references unknown customer ${o.customerId}`);
    for (const t of w.transactions) {
      if (!orders.has(t.orderId)) e(`transaction ${t.id} references unknown order ${t.orderId}`);
      if (!customers.has(t.customerId)) e(`transaction ${t.id} references unknown customer ${t.customerId}`);
    }
    for (const r of w.refunds) if (!txs.has(r.transactionId)) e(`refund ${r.id} references unknown transaction ${r.transactionId}`);
    if (c.setup.midflightRefund && !txs.has(c.setup.midflightRefund.transactionId)) e("midflightRefund references unknown transaction");

    const x = c.expected;
    if (x.humanEscalation !== HUMAN_STATES.has(x.finalState)) e("humanEscalation must be true iff finalState is ESCALATED or FAILED");
    if ((x.action.type === "REFUND") !== (x.finalState === "RESOLVED")) e("a REFUND action is expected iff finalState is RESOLVED");
    if (x.action.type === "REFUND" && !txs.has(x.action.transactionId)) e("expected refund references unknown transaction");
  }
  return errors;
}

// The locked v1 pin lives in the committed BASELINE-V1 result file.
export function readBaselinePin(baselinePath: string): string {
  const sha = (JSON.parse(readFileSync(baselinePath, "utf8")) as { benchmark?: { datasetSha256?: unknown } }).benchmark
    ?.datasetSha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new Error(`no valid datasetSha256 in ${baselinePath}`);
  return sha;
}

export function checkDatasetPin(actual: string, pinned: string): { ok: true } | { ok: false; message: string } {
  return actual === pinned
    ? { ok: true }
    : { ok: false, message: `LOCKED DATASET CHANGED: sha256 ${actual} does not match BASELINE-V1 pin ${pinned}` };
}

export interface LoadedDataset {
  dataset: Dataset;
  sha256: string;
}

export function loadDataset(path: string): LoadedDataset {
  const bytes = readFileSync(path);
  const parsed = DatasetSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`dataset schema invalid:\n${msg}`);
  }
  const errors = validateDataset(parsed.data);
  if (errors.length > 0) throw new Error(`dataset integrity invalid:\n${errors.join("\n")}`);
  return { dataset: parsed.data, sha256: createHash("sha256").update(bytes).digest("hex") };
}
