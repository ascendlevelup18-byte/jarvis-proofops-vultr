# JARVIS API: duplicate-charge vertical slice

This is the backend slice for the duplicate-charge workflow. It runs on the following, all of which are simulated:

- a **deterministic fixture model**, not a real LLM;
- a **simulated payment gateway**, so no real money moves;
- **synthetic commerce data** (fictional customers and orders).

It has no AMD, Evolus, UI, database or auth yet.

```bash
npm install
npm run api:check
npm run api:start
```

`api:check` runs the typecheck and the tests. `api:start` serves `POST http://localhost:3000/cases`.

```bash
curl -s -X POST localhost:3000/cases -H 'content-type: application/json' \
  -d '{"customerId":"CUST-1001","orderId":"48291","message":"I was charged twice for order #48291."}'
```

## Flow

`RECEIVED → EVIDENCE_GATHERING → ANALYZING → DECISION_PROPOSED → POLICY_VALIDATION → APPROVED → EXECUTING → VERIFYING → RESOLVED`

The terminal exits are `ESCALATED`, `FAILED` and `CLOSED_NO_ACTION`.

| File | Role |
|---|---|
| `src/contracts.ts` | Types, plus zod schemas for HTTP input and model output |
| `src/fixtures.ts` | Synthetic company, refund policy and the 4 scenarios |
| `src/evidence.ts` | Deterministic evidence: ownership, duplicate groups, amounts mentioned in the message, contradictions |
| `src/model-adapter.ts` | `ModelAdapter` interface and `FixtureModelAdapter`. The adapter is deliberately naive, so the policy gate is what blocks |
| `src/policy-engine.ts` | Deterministic authorization. The refund amount is derived from the transaction record |
| `src/state-machine.ts` | Legal transitions, plus guards: APPROVED/EXECUTING need APPROVE, and RESOLVED needs verified read-back |
| `src/gateway.ts` | Simulated provider: idempotent, with timeout fault injection and read-back |
| `src/case-engine.ts` | Orchestration, pre-execution revalidation and the audit trail |
| `src/server.ts` | `POST /cases` |

## Fixture scenarios (seeded)

| Scenario | Request | Outcome |
|---|---|---|
| Valid duplicate | `CUST-1001` / `48291` | `RESOLVED`: $89.99 refunded and verified |
| Conflicting amount | `CUST-1002` / `48292` | `ESCALATED`: $250 requested vs a verified $180 |
| Already refunded | `CUST-1003` / `48293` | `ESCALATED`: `NOT_ALREADY_REFUNDED` |
| Prompt injection | `CUST-1004` / `48294` | `ESCALATED`: the injected $5,000 conflicts with the records |
