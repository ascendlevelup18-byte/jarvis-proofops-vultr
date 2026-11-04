# 4:30 recording sequence (https://45-63-82-115.sslip.io)

Before recording, run `node apps/proofops/worker/rehearse.mjs https://45-63-82-115.sslip.io evidence-local/rehearsal`, wait 60 seconds, then open the site in a fresh window at 1440×900. The public limit is 6 mission starts a minute per address, so leave a pause between takes.

**Say out loud while the scripted planner is deployed:** "The planner in this take is scripted; the browser, sandbox, gateway and verifier are real." The header shows the same thing. Re-record with the live model if it gets approved, and don't reuse these words for it.

| Time | Click | What the screen shows |
|---|---|---|
| 0:00–0:25 | Nothing | Header: scripted planner, sandbox gVisor (runsc), code version. Six missions. The six stages from "Planner proposes" to "Sandbox destroyed". With a live model the first stage reads "Model proposes". |
| 0:25–1:05 | **Correct discount**, then **Run mission** | Steps appear with ALLOWED. Real screenshots. **VERIFIED PASS**, 9000 cents expected and observed on the page and the server. |
| 1:05–1:45 | **Wrong discount**, then **Run mission** | Same steps. The planner finishes with "checkout reached", and **VERIFIED FAIL** still appears. Point at `dom.total` and `server.total`: expected 9000, observed 9500 cents. |
| 1:45–2:35 | **Hostile page**, then **Run mission** | The containment panel fills with the page's own attempts: tracking image, fetch, a tunnel request to the canary host and a POST to the metadata address, each "Gateway refused". **CONTAINED: 4 attempts blocked**, `orders.count` expected 0, observed 0. |
| 2:35–3:20 | **Approved checkout**, then **Run mission**; pause on the card; **Approve this order** | Card: DEMO-001 × 1, SAVE10, $90.00, cart hash. Afterwards `orders.count` reads expected 1, observed 1, and the containment panel shows the replay refused with HTTP 403. |
| 3:20–3:55 | **Hung page**, then **Run mission** | Takes 25 seconds, so cut or speed up the wait. **Timed out**, **VERIFIED FAIL**, a LIMIT row saying the worker was destroyed, "Sandbox destroyed" lit. The timeline stays empty because the page hangs before any step finishes. |
| 3:55–4:15 | **Re-check evidence integrity**, then **Run report** | "Intact: N files match the anchored manifest". Report opens with the tier and assertions. |
| 4:15–4:30 | Show `proof/vultr-20261104/host-view-during-mission.txt` | `Runtime=runsc`, `runsc-sandbox`, `4.19.0-gvisor`. |

Tip: the containment moment the event asks for is the hostile-page mission.
