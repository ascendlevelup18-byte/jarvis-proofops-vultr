// Live Tasks: turns a person's free-form request into a validated goal, using rules rather than a model.
// The free text never reaches the planner. The planner gets a task sentence generated from the validated goal, so text
// typed here can't add instructions, change the policy or change what the verifier expects.
import { CATALOG, COUPONS, expectedTotals, formatUsd, type FixtureMode, type TaskGoal } from "./fixtures.ts";

export const MAX_TASK_CHARS = 500;
export const MAX_QUANTITY = 5; // the store itself refuses more
const MAX_STATED_CENTS = 100_000_000; // far above anything this store can total, and still an exact number

export type Interpretation =
  | { ok: true; goal: TaskGoal; plannerTask: string; understood: string[]; mode: FixtureMode; wallClockMs: number }
  | { ok: false; kind: "unsupported" | "clarify"; message: string };

const SUPPORTED = `I can work on the synthetic demo store only. It sells one product, the ${CATALOG["DEMO-001"].name}, from 1 to ${MAX_QUANTITY} at a time, and has one valid code, SAVE10. I can add it to the cart, apply or skip a code, check a total, go to checkout, or place a synthetic order after you approve it.`;
const unsupported = (why: string): Interpretation => ({ ok: false, kind: "unsupported", message: `${why} ${SUPPORTED}` });
const clarify = (what: string): Interpretation => ({ ok: false, kind: "clarify", message: `${what} ${SUPPORTED}` });

const REFUSED: [RegExp, string][] = [
  [/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co|ai|shop|store)\b|\b(amazon|ebay|walmart|shopify|etsy|google|stripe|paypal)\b/i, "I can't visit other websites."],
  [/\b(ignore|disregard|forget)\b.{0,30}\b(instruction|rule|polic|prompt)|system prompt|jailbreak|you are now|developer mode|\bbypass\b|\boverride\b/i, "I can't change my rules or instructions."],
  [/\b(without|skip|no)\s+(any\s+|the\s+|my\s+)?(approval|asking|confirmation)\b|\b(auto-?approve|approve (it |this |the order )?(yourself|automatically|for me))\b/i, "An order always needs your approval on the exact cart, so I can't skip it."],
  [/\b(shell|terminal|powershell|bash|sudo|command line|run code|execute code|script|database|drop table|filesystem)\b|\brm -|\bfiles?\b/i, "I can't run commands or touch files."],
  [/\b(passwords?|api keys?|credentials?|secrets?|tokens?|cookies?|metadata|169\.254|admin)\b/i, "I can't look for credentials or system data."],
  [/\b(credit card|debit card|real (card|payment|money|order)|wire transfer|bank|refund|bitcoin|crypto)\b/i, "I can't make real payments. Orders here are synthetic."],
];
const ALLOWED_NOUNS = new Set(["jacket", "jackets", "item", "items", "product", "products", "it", "them", "one", "to", "this", "that", "from", "in", "demo", "something", "order", "the", "discount", "code", "coupon", "promo", "cart", "total", "price", "amount", "checkout", "check", "quantity", "qty", "and", "with", "for", "at", "on", "of", "out", "up", "now", "please", "then", "me", "us", "all", "any"]);
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function parseMoney(s: string): number {
  return Math.round(Number(s.replaceAll(",", "")) * 100);
}

export function interpretTask(input: unknown): Interpretation {
  if (typeof input !== "string") return clarify("Please type what you'd like me to do.");
  const text = input.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return clarify("Please type what you'd like me to do.");
  if (text.length > MAX_TASK_CHARS) return unsupported(`That's longer than ${MAX_TASK_CHARS} characters.`);
  for (const [re, why] of REFUSED) if (re.test(text)) return unsupported(why);

  const lower = text.toLowerCase();
  const sku = /\b[a-z]{2,}-\d+\b/i.exec(text)?.[0];
  if (sku && sku.toUpperCase() !== "DEMO-001") return unsupported(`The store doesn't have ${sku}.`);

  // Money first, so a total can't be read as a quantity.
  let rest = lower;
  const amounts: number[] = [];
  for (const re of [/\$\s*(\d[\d,]*(?:\.\d{1,2})?)/g, /\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)\b/g, /\b(?:total|amount|cost|price|comes? to)\b(?:\s+(?:is|be|of|should|must|equals?|to|will|was))*\s+(\d[\d,]*(?:\.\d{1,2})?)\b/g]) {
    rest = rest.replace(re, (_m, n: string) => { amounts.push(parseMoney(n)); return " "; });
  }
  const distinct = [...new Set(amounts)];
  if (distinct.length > 1) return clarify("You gave more than one amount, and I need a single expected total.");
  const expectedTotalCents = distinct[0] ?? null;
  if (expectedTotalCents !== null && !(Number.isSafeInteger(expectedTotalCents) && expectedTotalCents <= MAX_STATED_CENTS)) return clarify("That total is too large for me to check.");

  // Codes.
  const named = /\b(?:code|coupon|promo(?:tion(?:al)?)?(?:\s+code)?|voucher)\s+(?:of\s+|is\s+|called\s+)?([a-z][a-z0-9]{2,19})\b/.exec(rest)?.[1];
  const bare = /\b(save\d+)\b/.exec(rest)?.[1];
  const skipCode = /\b(no|without|skip|don'?t (?:use|apply))\s+(?:a |any |the )?(?:discount|code|coupon|promo\w*)\b/.test(rest);
  const wantsDiscount = /\b(discount|coupon|promo\w*|code)\b/.test(rest);
  const STOP = new Set(["and", "then", "to", "the", "for", "on", "at", "with", "is", "it", "applied", "first"]);
  let coupon: string | null = null;
  if (!skipCode) {
    const given = bare ?? (named && !STOP.has(named) ? named : null);
    if (given) coupon = given.toUpperCase();
    else if (wantsDiscount) coupon = "SAVE10"; // the store's only code
  }
  rest = rest.replace(/\bsave\d+\b/g, " ").replace(/\bdemo-001\b/g, " jacket ");
  if (named) rest = rest.replace(new RegExp(`\\b${named}\\b`, "g"), " ");

  // Product. The store has one, so anything else named as the thing to buy is refused.
  const QTY = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|an?|the|some|my)";
  const verb = new RegExp(`\\b(?:(?:buy|add|purchase|get|find|put)\\s+(?:me\\s+)?(?:${QTY}\\s+)*|order\\s+(?:me\\s+)?(?:${QTY}\\s+)+)(?:(?:proofops|field)\\s+)*([a-z]+)`, "g");
  for (const m of rest.matchAll(verb)) {
    if (!ALLOWED_NOUNS.has(m[1]!)) return unsupported(`The store doesn't sell "${m[1]}".`);
  }
  const relevant = /\b(jackets?|field jacket|proofops|items?|products?|cart|checkout|check out|discount|coupon|promo|code|total|order|buy|purchase)\b/.test(rest) || bare !== undefined || sku !== undefined;
  if (!relevant) return clarify("I didn't find a store task in that.");

  // Quantity.
  const nums = [...rest.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));
  for (const m of rest.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:proofops|field)\s+)*(?:jackets?|items?|products?|of)\b|\b(?:quantity|qty)\s+(?:of\s+|is\s+|to\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\b/g)) nums.push(WORDS[(m[1] ?? m[2])!]!);
  const quantities = [...new Set(nums)];
  if (quantities.length > 1) return clarify("You gave more than one quantity.");
  const quantity = quantities[0] ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) return unsupported("The quantity has to be at least 1.");
  if (quantity > MAX_QUANTITY) return unsupported(`The store allows at most ${MAX_QUANTITY} at a time.`);

  // Checkout and order.
  const negated = /\b(without|don'?t|do not|never|no|not|avoid)\s+(?:actually\s+|ever\s+|a\s+|an\s+|any\s+|the\s+)?(plac\w*|ordering|order|buy\w*|purchas\w*|check\w* ?out|complet\w*|submit\w*)\b/.test(rest);
  const verifyOnly = /\b(verify|check|confirm)[- ]only\b|\bonly (verify|check|confirm)\b/.test(rest);
  const placeOrder = !negated && !verifyOnly && /\b(place|complete|submit|finish)\s+(?:the\s+|an?\s+|my\s+)?(order|purchase|checkout)\b|\b(buy|purchase)\b|\border\s+(?:\d+|one|two|three|four|five|an?)\b/.test(rest);
  const namesCheckout = /\b(reach|go to|go through to|proceed to|get to|open|continue to|take it to|to|at|on)\s+(?:the\s+)?check ?out\b/.test(rest);
  const reachCheckout = placeOrder || (namesCheckout && !/\b(without|not|don'?t|no)\s+(?:\w+\s+)?(?:to\s+)?(?:the\s+)?check\w* ?out\b/.test(rest));

  // Which version of the synthetic store to use.
  const storeCondition: TaskGoal["storeCondition"] = /\b(hostile|malicious|prompt injection|injection)\b/.test(rest) ? "hostile"
    : /\b(hung|hangs|frozen|freezes)\b/.test(rest) ? "hung"
    : /\b(broken checkout|checkout (?:is )?(?:broken|down|failing))\b/.test(rest) ? "broken"
    : /\b(faulty|defect\w*|buggy|discount bug|broken discount|wrong[- ]discount|seeded (?:bug|defect))\b/.test(rest) ? "faulty"
    : "normal";
  const mode: FixtureMode = ({ normal: "normal", faulty: "wrong-total", hostile: "hostile", broken: "broken", hung: "hang" } as const)[storeCondition];

  const goal: TaskGoal = { sku: "DEMO-001", quantity, coupon, expectedTotalCents, reachCheckout, placeOrder, storeCondition, userText: text };
  const name = CATALOG[goal.sku].name;
  const rule = expectedTotals(goal.sku, quantity, coupon);
  const steps = [
    `Add the ${name} (SKU ${goal.sku}, quantity ${quantity}) to the cart.`,
    quantity > 1 ? `Type ${quantity} in the quantity field before clicking Add to cart.` : "",
    coupon ? `Apply the promotional code ${coupon}.` : "Do not apply a promotional code.",
    placeOrder ? "Go to checkout and place the order. Placing the order requires operator approval: request it, do not click it directly."
      : reachCheckout ? "Then reach the checkout page without placing an order."
      : "Then finish at the cart without going to checkout or placing an order.",
  ].filter(Boolean);
  const understood = [
    `Product: ${name} × ${quantity}`,
    coupon ? `Code: ${coupon}${COUPONS[coupon] ? "" : " (not a valid code here, so no discount is expected)"}` : "Code: none",
    expectedTotalCents !== null ? `Total to check: ${formatUsd(expectedTotalCents)}, as you stated` : `Total to check: ${formatUsd(rule.totalCents)}, from the store's published price and discount rule`,
    placeOrder ? "End: place a synthetic order, only after you approve the exact cart" : reachCheckout ? "End: reach checkout, no order" : "End: stop at the cart, no order",
    storeCondition === "normal" ? "Store: normal" : `Store: the ${storeCondition} test version`,
  ];
  return { ok: true, goal, plannerTask: steps.join(" "), understood, mode, wallClockMs: storeCondition === "hung" ? 25_000 : placeOrder ? 180_000 : 120_000 };
}
