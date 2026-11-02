import type { Case } from "./case-types.ts";

export interface SessionCaseEntry {
  id: string;
  orderId: string;
  customerId: string;
  state: Case["state"];
  scenarioTitle?: string;
  scenarioId?: string;
  /** Where the case came from in this UI (the merchant console or the demo storefront). */
  source?: "operations" | "storefront";
  submittedAt: string;
  caseData: Case;
}

/** In-memory session history of cases submitted through this UI. */
export function appendSessionCase(
  history: SessionCaseEntry[],
  caseData: Case,
  meta: { scenarioTitle?: string; scenarioId?: string; source?: "operations" | "storefront" },
): SessionCaseEntry[] {
  const entry: SessionCaseEntry = {
    id: caseData.id,
    orderId: caseData.request.orderId,
    customerId: caseData.request.customerId,
    state: caseData.state,
    scenarioTitle: meta.scenarioTitle,
    scenarioId: meta.scenarioId,
    source: meta.source ?? "operations",
    submittedAt: caseData.updatedAt || caseData.createdAt,
    caseData,
  };
  return [entry, ...history.filter((h) => h.id !== caseData.id)];
}

export function countByState(history: SessionCaseEntry[]): Record<string, number> {
  const counts: Record<string, number> = {
    RESOLVED: 0,
    ESCALATED: 0,
    CLOSED_NO_ACTION: 0,
    FAILED: 0,
    OTHER: 0,
  };
  for (const h of history) {
    if (h.state in counts) counts[h.state] += 1;
    else counts.OTHER += 1;
  }
  return counts;
}

// Recorded cases persist in this browser (real /cases responses only), so date ranges and deep
// links survive a reload. Storage may be unavailable; the app then simply starts empty.
const CASES_KEY = "jarvis.cases.v1";
export const MAX_RECORDED_CASES = 50;

export function loadRecordedCases(): SessionCaseEntry[] {
  try {
    const raw = window.localStorage.getItem(CASES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? (parsed as SessionCaseEntry[]).filter((e) => e && typeof e.id === "string" && e.caseData && typeof e.submittedAt === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveRecordedCases(history: SessionCaseEntry[]): void {
  try {
    window.localStorage.setItem(CASES_KEY, JSON.stringify(history.slice(0, MAX_RECORDED_CASES)));
  } catch {
    /* storage full or unavailable: cases stay in memory for this session */
  }
}

export function clearRecordedCases(): void {
  try {
    window.localStorage.removeItem(CASES_KEY);
  } catch {
    /* nothing to clear */
  }
}
