# Security

JARVIS ProofOps is a competition prototype running on one synthetic store. It's not a production security product, and no third party has audited it.

## Reporting a problem
Please report vulnerabilities privately through this repository's **Security** tab, using **Report a vulnerability**. If that isn't available, open an issue asking for a private channel, with no technical details.

Please test only against your own local copy or within the public demo's normal limits. Don't run load tests, and don't attempt to access the VM or anything beyond the application. This is a prototype, so no response time or bounty is promised.

## Threat model
**Assets:** the inference key, the approval signing key, integrity of verdicts and evidence, the host VM, and the demo's inference budget.

**Trusted:** the VM and its root user, the control plane, the signer, the verifier, Vultr, and the operator. **Untrusted:** the model's output, all page content, the browser worker, and public visitors.

| Threat | Control | Tested by | What remains |
|---|---|---|---|
| Hostile page instructs the agent | Page text marked untrusted; policy limits any action | Live hostile runs | Resistance is observed, not measured. Forced proposals tested separately |
| Malicious or manipulated model output | Five typed actions, pre-dispatch policy, stale-element checks | Forced-proposal tests under gVisor and local adversarial tests | Policies are fixed in code. No model has been seen being stopped by policy |
| Agent reports false success | Verifier compares frozen expectations with page and store records | Wrong-discount live run | The checks cover this store only |
| Browser or renderer exploit | gVisor, no network, non-root, no capabilities, resource caps, disposable worker | 24-point boundary probe | Shared host. gVisor flaws are out of scope of these tests. No penetration test |
| Exfiltration from the page | Gateway allows only the run's store session; WebRTC UDP locked down | Boundary probe, hostile runs, local tests | A real site with third-party domains would widen this |
| Cloud metadata access | No network; gateway refuses the metadata address | Boundary probe, hostile runs | |
| Unapproved order or approval replay | Ed25519 approval from a separate process, bound to run and cart, single-use, verified by the store | Live approved run, public safety test | Fixed demo identity. A compromised control plane could request approvals. Execution is at-most-once: a retry after a lost response is refused, with no stored receipt |
| One visitor controlling another's mission | Per-run owner token, UI header | Public safety test | No accounts. Any visitor with a run id can view that run |
| Spoofed client address | Client address taken from Caddy only | Public safety test | |
| Key exposure | Key file readable only by the service, never given to the worker, redacted from records | Boundary probe, key scan | Root on the VM can read it |
| Evidence changed after the fact | SHA-256 per file; manifest hash in the registry | Tamper tests | **Root can rewrite both. Not signed, not externally anchored** |
| Cost or denial of service | Per-run caps, 6 starts a minute per address, 150 a day, one worker | Daily-cap test, public safety test | One visitor can use up the shared cap, which blocks others until it rolls forward. No automatic stop on money |
| Failure of model, sandbox or service | Fails closed, with no silent fallback to the scripted planner | Failure-recovery tests | Provider 429, 5xx and timeouts tested on a mock only |

## Not defended
- Compromise of the VM, root, or the control plane.
- Compromise of Vultr's services or of the model provider.
- Vulnerabilities in gVisor, Chromium, Docker or the Linux kernel, beyond the isolation layers they provide.
- Real payments or real customer data, which this prototype doesn't handle and shouldn't be used for.

## Secrets
None belong in this repository. The inference key is installed on the VM through a hidden prompt into a file with mode 600. If you find anything resembling a real credential here, please report it privately.
