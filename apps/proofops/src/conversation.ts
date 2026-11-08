// Decides whether a chat message is talk or a task, and answers talk directly.
// Talk never starts a run, a browser or a model call. Answers come only from facts this server holds: the store's
// catalog and codes, and what JARVIS can do. Nothing here can approve, order or change a task.
import { CATALOG, COUPONS, formatUsd } from "./fixtures.ts";
import { refusalFor } from "./tasks.ts";

export interface Answer { kind: "answer"; topic: string; message: string; examples: string[] }

const PRODUCT = CATALOG["DEMO-001"];
const CODES = Object.entries(COUPONS).map(([code, c]) => `${code} takes ${formatUsd(c.offCents)} off`).join(", ");
const EXAMPLES = [
  "Add 2 ProofOps Field Jackets to the cart, apply SAVE10, and confirm the total is $190 without placing an order.",
  "Using the faulty store, add one jacket, apply SAVE10, go to checkout, and check the total is $90 without placing an order.",
  "Buy one jacket with code SAVE10. Place the order after I approve it.",
];
const CAN_DO = `I work in a synthetic demo store. I can add the ${PRODUCT.name} to the cart, apply or skip a discount code, check a total you give me, go to checkout, or place a synthetic order after you approve the exact cart. A live model drives a sandboxed browser, and an independent check of the store's records decides whether the task really succeeded. No real payments are made.`;

const answer = (topic: string, message: string): Answer => ({ kind: "answer", topic, message, examples: EXAMPLES });

// A request to do something starts with an action, possibly after a polite opener.
const OPENER = String.raw`^(?:(?:ok(?:ay)?|hi|hey|jarvis|please)[,!.]?\s+)*(?:(?:can|could|would|will) you\s+(?:please\s+)?|please\s+|i(?:'d| would) like (?:you )?to\s+|i want (?:you )?to\s+|i need (?:you )?to\s+|let'?s\s+)?`;
const ACTION = String.raw`(?:add|buy|purchase|order|apply|put|place|check ?out|go to (?:the )?(?:cart|checkout)|reach|proceed|verify|confirm|check (?:that|the|if|whether)|use (?:code|the code|coupon|save\d+)|using the|on the (?:faulty|hostile|hung|broken)|try the|get me|add)`;
const TASK_START = new RegExp(`${OPENER}${ACTION}\\b`, "i");
const QUESTION_START = /^(?:what|what's|whats|which|who|why|how|when|where|is|are|do|does|did|was|were|should|tell me|show me|list|explain|describe)\b/i;

/** Returns an answer for talk, or null if the message asks JARVIS to do something. */
export function converse(input: unknown): Answer | null {
  if (typeof input !== "string") return null;
  const text = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text || text.length > 500) return null; // the task path explains these limits
  const refused = refusalFor(text);
  if (refused) return answer("refused", refused);
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  if (TASK_START.test(t) && !QUESTION_START.test(t)) return null;

  if (/\b(best[- ]?sell\w*|sells? (?:the )?most|(?:sell|buy|order|get|bought|sold)s? (?:the )?(?:most|best)|most (?:popular|sold|bought|ordered)|top[- ]sell\w*|popular|sales|revenue|bestseller|trending)\b/.test(t)) {
    return answer("sales", `I don't have sales records for this demo store, so I can't rank items by what sells most, and I won't guess. The store only sells one product, the ${PRODUCT.name} at ${formatUsd(PRODUCT.priceCents)}.`);
  }
  if (/\b(catalog(?:ue)?|products?|items?|inventory|what (?:do|can) (?:you|i) (?:sell|buy)|sell|stock|price|prices|cost|how much)\b/.test(t)) {
    return answer("catalog", `The demo store sells one product: the ${PRODUCT.name} (SKU DEMO-001), ${formatUsd(PRODUCT.priceCents)} each, 1 to 5 at a time. Its one valid code is ${CODES}.`);
  }
  if (/\b(codes?|coupons?|discounts?|promo\w*|vouchers?)\b/.test(t)) {
    return answer("codes", `The store has one valid code: ${CODES}. Any other code is rejected by the store, so no discount applies.`);
  }
  if (/\b(approv\w*|safe|safety|secure|security|verif\w*|sandbox|gvisor|trust|real money|payment)\b/.test(t)) {
    return answer("trust", "Every action the model proposes is checked by a fixed policy before the browser does it. The browser runs in a gVisor sandbox with no network except the demo store. An order needs you to press Approve on the exact cart, and afterwards the store's own records are checked against your goal. Typing \"yes\" doesn't approve anything.");
  }
  if (/^(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|greetings|yo)\b/.test(t)) {
    return answer("greeting", `Hello. ${CAN_DO}`);
  }
  if (/\b(what can you do|what do you do|who are you|what are you|help|how does (?:this|it) work|capabilit\w*|what is this)\b/.test(t)) {
    return answer("capabilities", CAN_DO);
  }
  if (/^(?:thanks|thank you|thx|cheers|great|nice|cool|ok(?:ay)?|got it)\b/.test(t)) {
    return answer("thanks", "You're welcome. Tell me a store task whenever you're ready.");
  }
  if (QUESTION_START.test(t) || t.endsWith("?")) {
    return answer("unknown_question", `I can only answer questions about this demo store and how I work. ${CAN_DO}`);
  }
  return null; // anything else goes to the task interpreter, which asks for clarification if it can't read it
}
