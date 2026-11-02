// Deterministic intent cues read from the raw customer text. Deliberately small:
// the safety backstop only needs to recognise affirmative duplicate-charge wording
// and clear requests for a different remedy. It never grants autonomy on its own;
// it can only withhold it when the understanding adapter disagrees with the text.

const DUPLICATE_CHARGE =
  /\b(?:charged|billed|charge[sd]?)\b.{0,60}?\b(?:twice|two times|three times|double)\b|\bdouble[- ]?charged\b|\btwo (?:charges|payments)\b|\bduplicate (?:charge|payment)s?\b/i;

export const OUT_OF_SCOPE_CUES = [
  { cue: "cancellation", kind: "FULL_ORDER_CANCELLATION", re: /\bcancel(?:l?ed|l?ing|lation)?\b/i },
  { cue: "whole order", kind: "FULL_ORDER_CANCELLATION", re: /\b(?:whole|entire) order\b/i },
  { cue: "everything back", kind: "FULL_ORDER_CANCELLATION", re: /\beverything back\b/i },
  { cue: "full refund", kind: "GENERAL_REFUND", re: /\bfull refund\b|\brefund (?:it )?all\b|\brefund everything\b/i },
] as const;

export interface IntentCues {
  duplicateCharge: boolean;
  outOfScope: string[]; // cue labels found, e.g. ["cancellation", "whole order"]
}

export function findIntentCues(text: string): IntentCues {
  return {
    duplicateCharge: DUPLICATE_CHARGE.test(text),
    outOfScope: OUT_OF_SCOPE_CUES.filter((c) => c.re.test(text)).map((c) => c.cue),
  };
}
