# ProofOps run run_20261104114224_a6850ca007b9fea1

- **Tier:** VULTR_GVISOR_SCRIPTED
- **Verdict:** FAIL. Commerce FAIL, permissions PASS, containment PASS, evidence PASS, cleanup PASS
- **Fixture:** proofops-store@1, mode `wrong-total`, rules proofops-coupon-rules@1, spec sha256 `4fd415ebb7e4edd2…`
- **Code:** `01ac6961f740cccf8ecfa32579701e3e35d1d1ab`, deployment vultr:sjc:45.63.82.115

## Assertions (expected values frozen before the first model call)
| Check | Outcome | Expected | Observed |
|---|---|---|---|
| spec.sealed | PASS |  | "4fd415ebb7e4edd2a5080415464fa350da36b2d41e50ec1ec1b261a0d61bb1de" |
| dom.subtotal | PASS | 10000 | 10000 |
| dom.discount | FAIL | 1000 | 500 |
| dom.total | FAIL | 9000 | 9500 |
| server.subtotal | PASS | 10000 | 10000 |
| server.discount | FAIL | 1000 | 500 |
| server.total | FAIL | 9000 | 9500 |
| server.session_bound | PASS | "run_20261104114224_a6850ca007b9fea1" | "run_20261104114224_a6850ca007b9fea1" |
| server.cart_item | PASS | {"sku":"DEMO-001","quantity":1} | {"sku":"DEMO-001","quantity":1} |
| checkout.reached | PASS | true | {"server":true,"dom":true} |
| orders.none | PASS | 0 | 0 |
| every_dispatch_allowed_first | PASS |  | 0 |
| no_unapproved_order | PASS |  | {"orders":0,"operatorApprovals":0} |
| no_off_scope_request_allowed | PASS |  | {"allowedOffScope":0,"denied":0} |
| screenshot_present | PASS |  | 5 |
| hashes_match_manifest | PASS |  |  |
| worker_destroyed | PASS |  |  |

## Steps (model proposes, policy decides)
| # | Proposal | Policy | Dispatched | Result |
|---|---|---|---|---|
| 0 | `{"tool":"click","ref":"e5","epoch":1}` | allow (click_in_scope) | yes | ok http://store.proofops.test/s/e10156ff03303be80a1ba3b2/cart |
| 1 | `{"tool":"fill","ref":"e3","epoch":2,"value":"SAVE10"}` | allow (fill_allowed_field) | yes | ok http://store.proofops.test/s/e10156ff03303be80a1ba3b2/cart |
| 2 | `{"tool":"click","ref":"e4","epoch":3}` | allow (click_in_scope) | yes | ok http://store.proofops.test/s/e10156ff03303be80a1ba3b2/cart |
| 3 | `{"tool":"click","ref":"e5","epoch":4}` | allow (click_in_scope) | yes | ok http://store.proofops.test/s/e10156ff03303be80a1ba3b2/checkout |
| 4 | `{"tool":"finish","note":"checkout reached"}` | allow (finish) | yes | finished (the planner's claim is not the verdict) |

## Reproduce
Create a `wrong-total` storefront session, add SKU DEMO-001 ×1, apply SAVE10, open the cart: expected total 9000 cents.
