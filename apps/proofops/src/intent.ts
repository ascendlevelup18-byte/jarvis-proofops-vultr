// Intent router: decides what kind of request a chat message is, before any capability's parser sees it.
// It grants nothing. Each capability (website QA, commerce QA) still validates its own scope, policy and checks; the
// router only decides which validator may look at the text, and answers truthfully when no capability fits. It never
// starts a run, a browser or a model call, and it never answers an outside-world question from memory.
import { refusalFor } from "./tasks.ts";

export type Intent =
  | "CONVERSATION" | "GENERAL_QUESTION" | "RESEARCH_REQUEST" | "WEBSITE_QA_TASK" | "COMMERCE_TASK"
  | "UNSUPPORTED_CAPABILITY" | "AMBIGUOUS_REQUEST" | "UNSAFE_REQUEST";

/** What this version can execute. Only these two run tasks; everything else is answered without a run. */
export const CAPABILITIES = [
  { id: "site-qa", intent: "WEBSITE_QA_TASK", executes: true, scope: "the built-in staging website, read-only" },
  { id: "commerce-qa", intent: "COMMERCE_TASK", executes: true, scope: "the synthetic demo store, orders only after approval" },
] as const;

const CAN_RUN = "I can currently run two kinds of real task: auditing the built-in staging website for broken links, and synthetic commerce QA on the demo store.";
export const NO_WEB = `I understand the request, but this version of JARVIS doesn't have authorized access to YouTube or the open web, so I can't look that up, and I won't answer from memory as if I had checked. ${CAN_RUN}`;
const NO_ACTION = (what: string) => `I can't ${what} for you. This version of JARVIS doesn't act on outside accounts or services. ${CAN_RUN}`;
const AMBIGUOUS = `I'm not sure what you'd like me to do, so I didn't start anything. ${CAN_RUN} Try "Audit the staging site for broken links."`;

const QA_DOMAIN = /\b(audit|broken links?|dead links?|404s?|staging (?:site|website)|link check\w*|(?:docs|blog|support|pricing) section)\b/;
const STORE_DOMAIN = /\b(jackets?|proofops|cart|checkout|check out|coupons?|promo\w*|vouchers?|discount|codes?|save\d+|demo-001|sku|store|shop|orders?|ordering|buy|purchase|items?|products?|totals?|quantity|approv\w*|synthetic)\b/;
// Things that live outside this server: the router routes these away from the store parser.
const OUTSIDE = /\b(youtube|videos?|internet|online|the web|web search|websites? (?:other|outside)|news|weather|wikipedia|twitter|tweets?|reddit|tiktok|instagram|facebook|linkedin|spotify|netflix|music|songs?|movies?|films?|celebrit\w*|stock (?:price|market)|exchange rate|sports?|scores?)\b/;
const RESEARCH_VERB = /^(?:(?:can|could|would) you\s+|please\s+)?(?:research|look up|lookup|search|google|browse|find out|tell me about)\b/;
const OUTSIDE_ACTION: [RegExp, string][] = [
  [/\b(create|design|draw|generate|make|edit)\b.{0,40}\b(graphic|image|picture|logo|poster|banner|video|presentation|slides?|document|report|file)s?\b/, "create or edit graphics, media or files"],
  [/\b(publish|post|tweet|share)\b/, "publish or post anything"],
  [/\b(e-?mail|send (?:a |an |the )?(?:message|text|sms|dm)|text (?:him|her|them|my)|message (?:him|her|them|my))\b/, "send messages"],
  [/\b(book|reserve|schedule|calendar|meeting|call)\b/, "book, schedule or call"],
  [/\b(delete|remove|cancel) (?:my|the|this|all)\b/, "delete or cancel things"],
];

export interface Routed { intent: Intent; message?: string }

/** Classifies a message. When `message` is set, that is the whole reply: no capability runs. */
export function routeIntent(input: unknown): Routed {
  if (typeof input !== "string") return { intent: "AMBIGUOUS_REQUEST" };
  const text = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return { intent: "AMBIGUOUS_REQUEST" };
  const refused = refusalFor(text);
  if (refused) return { intent: "UNSAFE_REQUEST", message: refused };
  const t = text.toLowerCase().replace(/[‘’ʼ]/g, "'");
  const qa = QA_DOMAIN.test(t), store = STORE_DOMAIN.test(t);
  // Outside-world topics win over store words: "find the most viewed video" is never a product.
  if (!store && !qa) for (const [re, what] of OUTSIDE_ACTION) if (re.test(t)) return { intent: "UNSUPPORTED_CAPABILITY", message: NO_ACTION(what) };
  if (OUTSIDE.test(t) || (RESEARCH_VERB.test(t) && !qa && !store)) return { intent: "RESEARCH_REQUEST", message: NO_WEB };
  // Placed orders are synthetic and final here: nothing can cancel, refund or change one.
  if (/\b(cancel|refund|return|change|modify)\b.{0,30}\border\b/.test(t)) return { intent: "UNSUPPORTED_CAPABILITY", message: NO_ACTION("cancel, refund or change an order") };
  if (qa) return { intent: "WEBSITE_QA_TASK" };
  if (store) return { intent: "COMMERCE_TASK" };
  return { intent: "CONVERSATION" }; // talk, or a general question: the conversation layer answers or declines
}

/** The reply for a message no capability took and talk didn't answer. */
export const ambiguousAnswer = () => AMBIGUOUS;
