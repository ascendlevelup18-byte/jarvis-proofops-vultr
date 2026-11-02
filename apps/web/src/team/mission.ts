// Commerce Recovery Mission: the link from an AI Team recommendation to a real JARVIS case.
// The team only proposes; a human chooses to send the canonical duplicate-charge request to JARVIS, where the
// existing engine (model understanding + proposal, deterministic policy, simulated gateway, read-back) decides.
import type { Case } from "../lib/case-types.ts";
import type { PlanAction } from "./orchestrator.ts";

/** Levers whose recommendation JARVIS can act on today: duplicate-charge refunds. */
export const ACTIONABLE_LEVERS = new Set(["refunds", "supportAutomation"]);

export const MISSION_LINK_NOTE =
  "Illustrative link: the synthetic store's refund problem is represented by JARVIS's canonical duplicate-charge order #48291. They are separate synthetic records; the team's data did not create this case.";

export const isActionable = (a: Pick<PlanAction, "lever">) => ACTIONABLE_LEVERS.has(a.lever);

/** Provenance of a finished case, read from the adapters recorded in its own audit (never from today's settings). */
export function caseProvenance(c: Case): { kind: "live" | "fixture" | "unconfirmed"; label: string; adapters: string[] } {
  const adapters = c.audit
    .filter((e) => e.type === "UNDERSTANDING_CALL" || e.type === "MODEL_CALL")
    .map((e) => {
      const d = e.data as { adapter?: unknown } | null;
      return typeof d?.adapter === "string" ? d.adapter : "";
    });
  if (adapters.length >= 2 && adapters.every((a) => a.startsWith("vllm:"))) return { kind: "live", label: `LIVE MODEL INFERENCE · ${[...new Set(adapters)].join(" + ")}`, adapters };
  if (adapters.length > 0 && adapters.every((a) => a.startsWith("fixture"))) return { kind: "fixture", label: "DETERMINISTIC FIXTURE · no model call", adapters };
  return { kind: "unconfirmed", label: "Inference provenance not confirmed", adapters };
}
