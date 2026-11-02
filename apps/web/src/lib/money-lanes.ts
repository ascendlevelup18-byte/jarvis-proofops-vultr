import type { Case } from "./case-types.ts";
import { formatMinor } from "./money.ts";

export interface MoneyLane {
  label: string;
  value: string;
  emphasize?: boolean;
  muted?: boolean;
}

/** Authoritative money only from understanding mentions (requested), evidence, authorization.action, verification. */
export function moneyLanes(caseData: Case): MoneyLane[] {
  const currency =
    caseData.evidence?.order.currency ??
    caseData.authorization?.action?.currency ??
    caseData.verification?.observedRefund?.currency ??
    "USD";

  const requested = caseData.evidence?.mentionedAmounts?.[0] ?? caseData.understanding?.mentionedAmounts?.[0];
  const verifiedOrder = caseData.evidence
    ? formatMinor(caseData.evidence.financial.orderTotalMinor, caseData.evidence.order.currency)
    : "—";
  const verifiedCharge =
    caseData.evidence?.transactions.find((t) => t.status === "SUCCEEDED") != null
      ? formatMinor(
          caseData.evidence.transactions.find((t) => t.status === "SUCCEEDED")!.amountMinor,
          caseData.evidence.order.currency,
        )
      : null;

  const blocked =
    caseData.authorization?.outcome === "DENY" ||
    caseData.state === "ESCALATED" ||
    (caseData.state === "CLOSED_NO_ACTION" && caseData.action == null);

  const executed =
    caseData.verification?.observedRefund != null
      ? formatMinor(caseData.verification.observedRefund.amountMinor, caseData.verification.observedRefund.currency)
      : caseData.authorization?.outcome === "APPROVE" && caseData.authorization.action && caseData.action?.status === "ACCEPTED"
        ? formatMinor(caseData.authorization.action.amountMinor, caseData.authorization.action.currency)
        : blocked || caseData.action == null
          ? formatMinor(0, currency)
          : "—";

  const afterAction =
    caseData.verification?.observedRefund != null
      ? formatMinor(caseData.verification.observedRefund.amountMinor, caseData.verification.observedRefund.currency)
      : caseData.verification
        ? "Not confirmed"
        : blocked || caseData.state === "CLOSED_NO_ACTION"
          ? formatMinor(0, currency)
          : "—";

  return [
    {
      label: "Requested",
      value:
        requested != null
          ? requested.currency
            ? formatMinor(requested.amountMinor, requested.currency)
            : `${(requested.amountMinor / 100).toFixed(2)} (no currency)`
          : "None stated",
      muted: requested == null,
    },
    {
      label: "Verified (records)",
      value: verifiedCharge ? `${verifiedCharge} charge · order ${verifiedOrder}` : verifiedOrder,
      emphasize: true,
    },
    {
      label: "Executed",
      value: executed,
      emphasize: !blocked && caseData.state === "RESOLVED",
      muted: blocked || executed === formatMinor(0, currency),
    },
    {
      label: "Verified after action",
      value: afterAction,
      emphasize: caseData.verification?.verified === true,
      muted: !caseData.verification?.verified,
    },
  ];
}
