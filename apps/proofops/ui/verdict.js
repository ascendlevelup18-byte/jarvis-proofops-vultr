// One shared way to state a finished run's outcome, in the run view and in history. Text comes from recorded data.
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
export const usd = (cents) => (typeof cents === "number" ? `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}` : "not recorded");

export const OUTCOME = {
  verified_success: { label: "Verified success", tone: "good", sub: "Independent checks of the page and the store's records passed." },
  designed_negative: { label: "Designed negative test: failed as intended", tone: "designed", sub: "This mission exists to fail. The safety checks held, and this isn't a system fault." },
  unexpected_failure: { label: "Unexpected execution failure", tone: "bad", sub: "The run didn't end the way this mission is designed to." },
  unexpected_result: { label: "Unexpected result", tone: "bad", sub: "This mission is designed to fail, but it passed. The check may have missed something." },
  timed_out: { label: "Timed out", tone: "warn", sub: "The run hit its time limit, and this mission isn't designed to." },
  cancelled: { label: "Cancelled", tone: "warn", sub: "The operator stopped this run, so it has no complete result." },
  incomplete_evidence: { label: "Incomplete evidence", tone: "warn", sub: "The record is missing something, so this run can't be called verified." },
  evidence_integrity_failure: { label: "Evidence integrity failure", tone: "bad", sub: "The files no longer match their recorded checksums. Don't rely on this run's result." },
};

/** Who proposed the actions, from what the run recorded. Never inferred from the current deployment. */
export function plannerLabel(provider, model) {
  if (provider === "vultr-serverless-inference") return `Live model: ${model ?? "unknown"} on Vultr`;
  if (provider === "local-model-stub") return "Scripted planner, no live AI";
  return "Planner not recorded";
}

export function tierLabel(tier) {
  if (!tier) return "Tier not recorded";
  if (tier.startsWith("VULTR_GVISOR")) return "gVisor on Vultr";
  return "Local, no sandbox";
}

/** The one line that explains the result, taken from the failing checks or the recorded error. */
function headline(s) {
  const money = new Set(["dom.total", "server.total", "dom.discount", "server.discount"]);
  const failing = (s.checks ?? []).filter((c) => c.outcome === "FAIL");
  const total = failing.find((c) => c.name === "server.total") ?? failing.find((c) => money.has(c.name));
  if (total) return `Expected ${usd(total.expected)}, the store recorded ${usd(total.observed)} (${total.name}).`;
  if (s.error) return s.error;
  if (failing[0]) return `Failed check: ${failing[0].name}.`;
  return null;
}

export function renderOutcome(node, s) {
  const o = OUTCOME[s.outcomeClass] ?? OUTCOME.incomplete_evidence;
  node.hidden = false;
  node.className = `outcome ${o.tone}`;
  node.dataset.outcome = s.outcomeClass;
  const showReasons = s.outcomeClass === "incomplete_evidence" || s.outcomeClass === "evidence_integrity_failure";
  const reasons = showReasons && s.evidence?.reasons?.length ? s.evidence.reasons.slice(0, 3).join("; ") : null;
  const line = headline(s);
  node.replaceChildren(
    el("p", "outcome-label", o.label),
    el("p", "outcome-sub", reasons ?? line ?? o.sub),
  );
  if ((reasons || line) && s.outcomeClass !== "evidence_integrity_failure") node.append(el("p", "outcome-note", o.sub));
  const meta = el("ul", "outcome-meta");
  meta.setAttribute("aria-label", "Recorded facts");
  meta.append(
    el("li", "", `Sealed verdict: ${s.verdict ?? "none"}`),
    el("li", s.evidence?.status === "TAMPERED" ? "bad" : "", `Evidence: ${s.evidence?.status ?? "unknown"}${s.evidence && !s.evidence.anchored ? ", no recorded anchor" : ""}`),
    el("li", "", plannerLabel(s.model?.provider, s.model?.requested)),
    el("li", "", tierLabel(s.tier)),
  );
  node.append(meta);
}

/** Shown when the verdict exists but the summary could not be read. It never claims the evidence is fine. */
export function renderOutcomeUnavailable(node, verdict) {
  node.hidden = false;
  node.className = "outcome warn";
  node.dataset.outcome = "unavailable";
  node.replaceChildren(el("p", "outcome-label", `Verdict ${verdict ?? "not recorded"}, evidence status unknown`), el("p", "outcome-sub", "The evidence summary couldn't be read. Check the run's evidence files before relying on this result."));
}
