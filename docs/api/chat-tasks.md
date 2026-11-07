# Chat task API

For the chat frontend. Base is the same origin as the ProofOps server, because its CSP allows only `connect-src 'self'`, so serve the chat UI from `apps/proofops/ui/`. Local start: `node apps/proofops/src/server.ts --port 4317`.

## Rules for the client
- Every POST sends `content-type: application/json` and `x-proofops: 1`.
- `runToken` comes back only from the first `POST /api/tasks`. Keep it in `sessionStorage`, never in a URL. It's the only capability to read, approve, reject or cancel that run on a non-local server.
- Render all text with `textContent`. `userText` is untrusted, and the CSP blocks inline script.
- One task runs at a time. Nothing is queued.
- Only `result.outcome` may be shown as success. A status is never a result.
- Always show `planner.label`. Scripted runs must never look like live AI.

## 1. Submit: `POST /api/tasks`
Headers: optional `idempotency-key` (a fresh UUID per submission). Body: `{ "text": "..." }`, at most 500 characters.

**202**
```json
{ "runId": "run_20261107120000_a1b2c3d4e5f60718", "created": true, "runToken": "<48 hex>",
  "understood": ["Product: ProofOps Field Jacket × 2", "Code: SAVE10", "Total to check: $190.00, as you stated", "End: stop at the cart, no order", "Store: normal"],
  "plannerTask": "<sentence sent to the planner, for advanced views only>", "userText": "<what was typed>",
  "planner": { "live": false, "label": "Scripted planner, no live AI" } }
```
A repeat with the same key and same text returns `created: false` and the same `runId`, with **no** `runToken`. Show it as a duplicate. The same key with different text starts a new run.

| Status | `error` | Show the user |
|---|---|---|
| 422 | `needs_clarification` | `message`, then let them rephrase |
| 422 | `unsupported_task` | `message`, this is UNSUPPORTED TASK |
| 409 | `busy` | Another task is running |
| 429 | `rate_limited`, `daily_limit` | Try again later |
| 403 | `missing_ui_header` | Client bug |
| 400 | `bad_request` | Client bug or a body over 8 KiB |

Refusals start nothing and return no `runId`.

## 2. Follow: `GET /api/tasks/{runId}/events`
Server-Sent Events. Send `x-run-token: <runToken>`, so **use `fetch` and read the body stream, not `EventSource`**, which can't send headers. On reconnect send `last-event-id` with the last `seq`. The stream replays what's missed and closes after `result`.

| Event | Data |
|---|---|
| `status` | `{ "seq": 3, "at": "<ISO>", "phase": "starting\|acting\|awaiting_approval\|verifying\|finished", "message": "Clicked, now on the cart." }` |
| `approval` | `{ "cart": { "item": "ProofOps Field Jacket", "sku": "DEMO-001", "quantity": 2, "coupon": "SAVE10", "totalCents": 19000, "total": "$190.00" }, "payloadSha256": "<64 hex>", "expiresAt": "<ISO>" }` |
| `result` | See section 3. Last event |

Statuses come from real run events. Model text, typed values, URLs and session ids aren't in them.

## 3. Status and result: `GET /api/tasks/{runId}`
Send `x-run-token`. Use this after a reload.
```json
{ "runId": "...", "status": "running|awaiting_approval|completed|failed|timed_out|cancelled",
  "phase": "...", "message": "<latest status, or the result message>", "userText": "...", "understood": ["..."],
  "planner": { "live": false, "label": "..." }, "isolation": "gvisor|none (local development)",
  "statuses": [], "approval": null, "result": null }
```
`result`:
```json
{ "outcome": "VERIFIED_PASS|VERIFIED_FAIL|INCOMPLETE|EXECUTION_ERROR",
  "message": "The task ran, but the result didn't match: expected $90.00, the store recorded $95.00.",
  "facts": { "sku": "DEMO-001", "quantity": 1, "coupon": "SAVE10", "totalCents": 9500, "expectedTotalCents": 9000, "ordersPlaced": 0, "checkoutReached": true },
  "planner": { "live": false, "label": "..." },
  "evidence": { "integrity": "ANCHOR VERIFIED|INCOMPLETE|TAMPERED", "manifestSha256": "<hex>", "summaryPath": "/api/runs/{id}/summary", "filesPath": "/api/runs/{id}/evidence/" } }
```
Show `outcome` and `evidence.integrity` separately. UNSUPPORTED TASK is the 422 from section 1. A token works while the server keeps the run in memory (the last 50 runs, until restart), and afterwards this returns 403.

## 4. Approval and cancel
Each needs `x-proofops: 1` and `x-run-token`.

| Call | Body | Replies |
|---|---|---|
| `POST /api/runs/{id}/approve` | `{ "payloadSha256": "<from the approval event>" }` | 200 `{ok:true}`, 409 `no_pending_approval`, 409 `approval_payload_changed`, 403 `not_run_owner`, 503 `signer_unavailable` |
| `POST /api/runs/{id}/reject` | Same | 200, 409, 403 |
| `POST /api/runs/{id}/cancel` | `{}` | 202, 409 `not_running`, 403 |

Approval needs a real button on the exact cart shown. Never treat a typed "yes" as approval. Unanswered requests expire at `expiresAt` and place no order.

## 5. Advanced views only
Not for normal chat. These need `x-run-token`, or a direct local request to a local development server, or an operator's `PROOFOPS_OPEN_HISTORY=1`. Otherwise 403.

`GET /api/runs/{id}` (raw trace), `/stream`, `/summary`, `/verify-evidence`, `/evidence/{file}`. `GET /api/history` and `GET /api/compare` have no token path. Evidence images load with a plain `<img>` only on a local server. Elsewhere the header requires `fetch`, and the CSP doesn't yet allow `blob:` images.

## 6. Open to anyone
`GET /api/health`, `/api/trust`, `/api/scenarios`, and `/api/runs` (a hashed ref and outcome per run, no text).
