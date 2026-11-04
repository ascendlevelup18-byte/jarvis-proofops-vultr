# 4:30 recording sequence (https://45-63-82-115.sslip.io)

Before recording, run `node apps/proofops/worker/rehearse.mjs https://45-63-82-115.sslip.io proof/check`, wait 60 seconds, then open the site in a fresh window at 1440×900. The public limit is 6 mission starts a minute per address, so leave a pause between takes.

**Say out loud while the scripted planner is deployed:** "The planner in this take is scripted; the browser, sandbox, gateway and verifier are real." The header shows the same thing. Re-record with the live model if it gets approved, and don't reuse these words for it.

| Time | Click | What the screen shows |
|---|---|---|
| 0:00–0:25 | Nothing | Header: sandbox gVisor (runsc), code version. Six missions. The six stages from "Model proposes" to "Sandbox destroyed". |
| 0:25–1:05 | **Correct discount**, then **Run mission** | Steps appear with ALLOWED. Real screenshots. **VERIFIED PASS**, $90.00 expected and observed on the page and the server. |
| 1:05–1:45 | **Wrong discount**, then **Run mission** | Same steps, and the finish step reads "the planner's claim is not the verdict". **VERIFIED FAIL**. Point at `dom.total` and `server.total`: $90.00 vs $95.00. |
| 1:45–2:35 | **Hostile page**, then **Run mission** | The containment panel fills: image, fetch, WebSocket tunnel and metadata request, each "Gateway refused". **CONTAINED: 4 attempts blocked**, `orders.none` 0. |
| 2:35–3:20 | **Approved checkout**, then **Run mission**; pause on the card; **Approve this order** | Card: DEMO-001 × 1, SAVE10, $90.00, cart hash. Afterwards one order, and the containment panel shows the replay refused with HTTP 403. |
| 3:20–3:55 | **Hung page**, then **Run mission** | Takes 25 seconds, so cut or speed up the wait. **Timed out**, **VERIFIED FAIL**, "Sandbox destroyed" lit. |
| 3:55–4:15 | **Re-check evidence integrity**, then **Run report** | "Intact: N files match the anchored manifest". Report opens with the tier and assertions. |
| 4:15–4:30 | Show `proof/vultr-20261104/host-view-during-mission.txt` | `Runtime=runsc`, `runsc-sandbox`, `4.19.0-gvisor`. |

Tip: the containment moment the event asks for is the hostile-page mission.
