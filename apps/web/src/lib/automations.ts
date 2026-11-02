// Automation modules offered in onboarding. Only modules backed by working backend code
// are "operational"; everything else is explicitly a preview with nothing running.

export type ModuleStatus = "operational" | "preview";

export interface AutomationModule {
  id: "refunds" | "support" | "orders" | "inventory" | "analytics" | "risk";
  title: string;
  status: ModuleStatus;
  summary: string;
  /** What actually runs today (operational) or what is missing (preview). */
  reality: string;
  /** What it needs to run (operational) or would need before it could exist (preview). */
  requirements: string[];
}

export const AUTOMATION_MODULES: AutomationModule[] = [
  {
    id: "refunds",
    title: "Refunds and returns",
    status: "operational",
    summary: "Resolve duplicate-charge refunds end to end.",
    reality: "AI proposes a refund; policy checks it; simulated refunds are verified and logged.",
    requirements: ["Demo store order records (seeded)", "AI provider: fixture by default, or an OpenAI-compatible endpoint on the server", "Simulated payment gateway (no real money)"],
  },
  {
    id: "risk",
    title: "Risk and exceptions",
    status: "preview",
    summary: "Catch unsafe or contradictory requests before money moves.",
    reality: "Escalation of unsafe refund requests already runs inside Refunds; standalone risk scoring is not built.",
    requirements: ["A risk model or rules engine beyond the refund policy", "Signals data not present in the demo store"],
  },
  {
    id: "support",
    title: "Customer support",
    status: "preview",
    summary: "Turn support conversations into operational cases.",
    reality: "Demo support uses preset refund requests. Open-ended support is not automated.",
    requirements: ["Open-ended answer generation with its own safety policy", "Operator-token gated free text in production"],
  },
  {
    id: "orders",
    title: "Order operations",
    status: "preview",
    summary: "Cancellations, address changes, shipping exceptions.",
    reality: "Not built. Cancellation requests are currently escalated to a human.",
    requirements: ["Order-write APIs (cancel, address change) and their policies", "A store integration; none is connected"],
  },
  {
    id: "inventory",
    title: "Inventory alerts",
    status: "preview",
    summary: "Low-stock and oversell warnings.",
    reality: "Not built. No inventory data exists in the demo store.",
    requirements: ["Inventory and stock-level data", "A store integration; none is connected"],
  },
  {
    id: "analytics",
    title: "Store analytics",
    status: "preview",
    summary: "Trends across orders, refunds and support.",
    reality: "Not built for store sales. JARVIS shows case outcomes and benchmark results only.",
    requirements: ["Sales, traffic and fulfilment data from a real store"],
  },
];

export function validateModuleSelection(ids: readonly string[]): { ok: true } | { ok: false; error: string } {
  const known = new Set(AUTOMATION_MODULES.map((m) => m.id));
  if (ids.length === 0) return { ok: false, error: "Select at least one automation" };
  const unknown = ids.filter((id) => !known.has(id as AutomationModule["id"]));
  if (unknown.length) return { ok: false, error: `Unknown module: ${unknown.join(", ")}` };
  return { ok: true };
}

export const operationalSelected = (ids: readonly string[]) =>
  AUTOMATION_MODULES.filter((m) => ids.includes(m.id) && m.status === "operational");

/** Shape check for a store domain. Real store connections are not available in this build. */
export function checkStoreDomain(input: string): { valid: boolean; domain: string | null; connectable: false; message: string } {
  const domain = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const valid = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
  return {
    valid,
    domain: valid ? domain : null,
    connectable: false,
    message: valid
      ? `${domain} looks valid, but store-platform connections are not available in this build — no data is read from it. Use the demo store.`
      : "Enter a domain like yourstore.com",
  };
}
