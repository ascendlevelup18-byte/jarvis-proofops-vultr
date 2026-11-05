# zod advisory assessment, 5 Nov 2026

**Result: not reachable through ProofOps' schema, from reading the code and from the test below. Not a release blocker. Disclosed, and the upgrade is held until after submission.**

| | |
|---|---|
| Advisory | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). **Published, not withdrawn,** read 5 Nov 2026, and `npm audit` still reports it |
| Linked CVE | CVE-2023-54404. **Rejected by its numbering authority, VulnCheck, on 28 Oct 2026** in the [CVE record](https://cveawg.mitre.org/api/cve/CVE-2023-54404); NVD also shows it as rejected. The stated reason: memory grows only in proportion to input `JSON.parse` already allocated, is reachable only without an application request-size limit, and is expected validator behavior. **The rejection doesn't remove the GitHub advisory, and we don't treat it as doing so** |
| Severity | High, CVSS 7.5, CWE-770, availability only |
| Affected, fixed | zod below 4.6.6; first patched 4.6.6 |
| Installed | zod 4.6.5, a direct dependency, at `d14d24c` and on `main` |
| Behavior | A failing array, set or map schema builds one validation issue per element, so a very large input can exhaust memory |
| Prerequisites | The attacker's oversized input must reach a schema containing a collection |

**In ProofOps:**
- zod is imported in one file, `apps/proofops/src/policy.ts`. It defines one schema, `Action`: five strict objects of strings and numbers. There is no `z.array`, `z.set`, `z.map`, `z.record` or `z.tuple` under `apps/`.
- That schema's only runtime input is the parsed model reply, in `checkAction`. Visitor HTTP bodies are not validated with zod. A page could only influence the input indirectly through the model, whose replies are requested with `max_tokens` 600.

**Measured on zod 4.6.5** with [`zod-advisory-test.mjs`](zod-advisory-test.mjs), including input far larger than a model reply:
```
zod 4.6.5
top-level array                            rejected issues=1 0.2ms heap+0.2MB
array in path                              rejected issues=2 2.3ms heap+0.1MB
array in reason                            rejected issues=2 0.5ms heap+0.0MB
array as tool                              rejected issues=1 0.3ms heap+0.0MB
500k extra keys                            rejected issues=1 179.3ms heap+22.5MB
5MB string                                 rejected issues=1 1.3ms heap+5.0MB
control: z.array(z.string().uuid()) 2M     rejected issues=2000000 974.0ms heap+642.2MB
```
The last line is a control showing the vulnerable shape does misbehave on this machine. The worst case for the ProofOps schema is the 500,000-key object, rejected with one issue.

**Limits of this assessment:** self-performed, one machine. The provider client also rejects any reply over 1 MiB before parsing (`readBodyLimited` in `apps/api/src/provider/openai-compatible-client.ts`), so the inputs tested above are larger than the schema can receive in production. The schema in the test is a copy of the one in `policy.ts`.

**Fix:** `zod` 4.6.6 is on branch `review/work-upgrade-patch`, where `npm audit` reports 0 and the local gate passes. It has not been deployed or tested on the VM, and production stays frozen.
