# JARVIS ProofOps — Execute. Contain. Verify.

**Status: pre-kickoff workspace (2 Nov 2026).** Entry being prepared for the Vultr: Agent Rush Hackathon 2026 (lablab.ai), Challenge 1 "Blast Radius Zero": a web agent that plans real browser work with Vultr Serverless Inference, runs it with Playwright inside an isolated sandbox on a Vultr VM, verifies the result with evidence, and visibly contains hostile pages. Nothing in this repository is the competition product yet; core competition functionality starts at the official kickoff.

## Prior work disclosed
This repository starts from a sanitized snapshot of the same author's earlier project, **JARVIS ACT III** (https://github.com/ascendlevelup18-byte/jarvisACTIII, commit `c69ca2c`). Every inherited file, its source commit and checksum are listed in [REUSE-LEDGER.md](REUSE-LEDGER.md). The first commit contains only that inherited foundation; all later commits are new work. Refund-specific ACT III features will be removed at kickoff.

## Isolation from JARVIS ACT III
- Separate repository and Git history; no remote points at `jarvisACTIII`.
- No ACT III secrets, environment files, Vercel configuration or deployment references were copied.
- ProofOps will run on its own Vultr VM with its own credentials and URL.
- Database: planned `proofops` schema in a shared Supabase project, **not yet created**; see [prep/SHARED-DATABASE-PLAN.md](prep/SHARED-DATABASE-PLAN.md). No database change happens without owner approval.

## License
MIT (see [LICENSE](LICENSE)).
