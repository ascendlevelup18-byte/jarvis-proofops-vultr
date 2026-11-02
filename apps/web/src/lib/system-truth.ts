// Navigation for the merchant command center. Runtime status labels come from
// /api/health (see runtime-truth.ts).

export type NavId =
  | "judge"
  | "command-center"
  | "assistant"
  | "team"
  | "dashboard"
  | "operations"
  | "orders"
  | "customers"
  | "inbox"
  | "automations"
  | "cases"
  | "approvals"
  | "benchmarks"
  | "activity"
  | "system"
  | "settings";

export type NavSection = "Overview" | "Commerce" | "Automations" | "Insights" | "System";

export interface NavItem {
  id: NavId;
  label: string;
  section: NavSection;
  /** URL slug for deep links (#/slug). */
  slug: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "judge", label: "Judge Mode", section: "Overview", slug: "judge" },
  { id: "command-center", label: "Command Center", section: "Overview", slug: "command-center" },
  { id: "assistant", label: "AI Assistant", section: "Overview", slug: "assistant" },
  { id: "team", label: "AI Team", section: "Overview", slug: "ai-team" },
  { id: "dashboard", label: "Home", section: "Overview", slug: "dashboard" },
  { id: "operations", label: "Proof Mode", section: "Overview", slug: "proof" },
  { id: "orders", label: "Orders", section: "Commerce", slug: "orders" },
  { id: "customers", label: "Customers", section: "Commerce", slug: "customers" },
  { id: "inbox", label: "Inbox", section: "Commerce", slug: "inbox" },
  { id: "automations", label: "Automation catalog", section: "Automations", slug: "automations" },
  { id: "cases", label: "Cases", section: "Automations", slug: "cases" },
  { id: "approvals", label: "Approvals", section: "Automations", slug: "approvals" },
  { id: "benchmarks", label: "Analytics", section: "Insights", slug: "analytics" },
  { id: "activity", label: "Activity", section: "System", slug: "audit" },
  { id: "system", label: "AI provider", section: "System", slug: "ai-provider" },
  { id: "settings", label: "Settings", section: "System", slug: "settings" },
];

export const NAV_SECTIONS: NavSection[] = ["Overview", "Commerce", "Automations", "Insights", "System"];

export const navLabel = (id: NavId) => NAV_ITEMS.find((n) => n.id === id)?.label ?? id;
