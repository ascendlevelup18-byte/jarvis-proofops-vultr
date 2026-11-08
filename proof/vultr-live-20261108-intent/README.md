# Intent routing on production, 8 Nov 2026

Recorded against https://45-63-82-115.sslip.io through the public chat API (`POST /api/tasks`), from outside the VM. The router shipped in `88bb4a6`, and the routing record below is from the current release `6cc0cdc`.

## The failure this fixes
Before `88bb4a6`, "find the most viewed video on youtube" got: "The store doesn't sell "most"."

The cause: talk detection didn't treat "find" as a task word, and the message had no question word, so it fell through to the commerce parser. That parser reads the word after "find", "buy" or "add" as the product name, so "most" became a product. A small intent router (`apps/proofops/src/intent.ts`) now classifies every message first. Research and unsupported actions get a truthful answer, and only store requests reach the store parser. The router grants nothing: website QA and commerce still validate their own scope.

## [`public-routing.json`](public-routing.json)
20 requests, each with the HTTP status, intent and the full reply.
- 9 research requests, including the exact YouTube request: answered that this version has no authorized YouTube or web access. Nothing was looked up, and nothing was answered from memory.
- 3 store questions ("most expensive product" in the demo store and so on): answered from the store's catalog.
- 3 unsupported actions (publish, create a graphic, cancel an order) and 3 unsafe requests: declined.
- The run count and model-call count were the same before and after. Nothing started a browser, a worker or a model call.

## [`public-docs-audit.json`](public-docs-audit.json)
One live website audit on `88bb4a6`, the first release with the router: "Find the broken links in the docs section." It ran with the live Vultr model, in gVisor, in 13 steps. The result was **VERIFIED PASS**: all 3 docs pages opened, the one in-scope broken link found, no false findings, 0 orders, and the worker destroyed.

The model also reported `/site/docs/changelog`. That link is genuinely broken on this run's site, but it isn't linked from a docs page, so the section's required set didn't include it. The verifier checks every reported link against the server's real broken list, so a false report would have failed the run.

## Not built
JARVIS can't do live research. A safe version needs an approved data source and its credentials, an allow-listed egress path with redirect and DNS checks, and source-attributed verification.

## Screenshots
- [`public-youtube-request-desktop.jpg`](public-youtube-request-desktop.jpg): the exact request typed into the public chat on `6cc0cdc`, and its answer.
- [`public-welcome-mobile.jpg`](public-welcome-mobile.jpg): the welcome screen at 375 px wide, with no horizontal scroll.

## Judge rehearsal
[`FINAL-JUDGE-REHEARSAL.md`](FINAL-JUDGE-REHEARSAL.md) records the rehearsal on `8ce8057`, including the three defects it found and fixed, and the rehearsal screenshots `rehearsal-*.jpg`.
