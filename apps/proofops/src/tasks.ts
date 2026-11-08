// Live Tasks: turns a person's free-form request into a validated goal, using rules rather than a model.
// The free text never reaches the planner. The planner gets a task sentence generated from the validated goal, so text
// typed here can't add instructions, change the policy or change what the verifier expects.
//
// The rules are deliberately strict. A verified pass on a misread request would be worse than a refusal, so every word
// has to be understood, negation counts only in phrases the parser knows, and anything else asks the person to rephrase.
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

/** Every word of a task has to be one of these, or be part of a phrase already understood and removed. */
const VOCABULARY = new Set(`
  a an the my me i you it them this that some all any of to in into at on for from with and then but when after once if as through first now only please also just so ok okay thanks
  want wants would like need needs can could will shall let let's lets try i'd
  add adding buy buying purchase purchasing get getting find finding put putting place placing order ordering orders complete completing submit submitting finish finishing make sure ensure
  check checking confirm confirming verify verifying validate see
  jacket jackets field proofops item items unit units product products one two three four five six seven eight nine ten quantity qty
  cart checkout out go going reach reaching proceed proceeding continue continuing take stop stopping stay end
  apply applying applied use using code coupon promo promotional discount voucher
  total amount cost costs price comes come is are be should must equals equal was
  synthetic demo approve approved approval ask asking
  store page version site faulty defective buggy broken hostile malicious injection hung hanging frozen seeded bug defect
`.trim().split(/\s+/));

const RANKING = new Set("most least best worst top cheapest priciest biggest smallest newest latest oldest popular viewed highest lowest".split(" "));
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUMBER = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
const QTY = `(?:${NUMBER}|an?|the|some|my)`;

const MONEY = /(-\s*)?\$\s*([\d.,]+)|(-\s*)?\b(\d[\d.,]*)\s*(?:dollars?|usd|bucks)\b|\b(?:total|amount|cost|price|comes? to)\b(?:\s+(?:is|be|of|should|must|equals?|to|will|was))*\s+(-\s*)?(\d[\d.,]*)\b(?:\s*(?:dollars?|usd|bucks)\b)?/g;
const MONEY_FORM = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
const NOT_EXACT_BEFORE = /\b(?:not|isn't|isnt|never|under|over|below|above|less than|more than|at most|at least|around|about|roughly|approximately|nearly|almost|up to|within)\s+(?:(?:is|be|the|of|total|price)\s+)*$/;
const NOT_EXACT_AFTER = /^\s*(?:each|per\b|apiece|a piece|or less|or more|or so|ish\b|\+)/;

const NEGATE = "(?:don't|dont|do not|does not|never|without|not|no|avoid|skip|shouldn't|must not)";
const CODE_WORD = "(?:promo(?:tional)?(?: code)?|coupon(?: code)?|discount(?: code)?|voucher(?: code)?|code)";
const CODE_FORM = /^[a-z]{1,8}\d{1,4}$/; // also keeps this one channel to the planner very narrow
const ORDER_VERB = "(?:place|placing|complete|completing|submit|submitting|buy|buying|purchase|purchasing|order|ordering)";

function cut(text: string, re: RegExp): { rest: string; hit: boolean } {
  let hit = false;
  const rest = text.replace(re, () => { hit = true; return " "; });
  return { rest, hit };
}

/** The refusal for a request outside the boundary, or null. Used for talk as well as tasks. */
export function refusalFor(text: string): string | null {
  for (const [re, why] of REFUSED) if (re.test(text)) return `${why} ${SUPPORTED}`;
  return null;
}

export function interpretTask(input: unknown): Interpretation {
  if (typeof input !== "string") return clarify("Please type what you'd like me to do.");
  const text = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return clarify("Please type what you'd like me to do.");
  if (text.length > MAX_TASK_CHARS) return unsupported(`That's longer than ${MAX_TASK_CHARS} characters.`);
  for (const [re, why] of REFUSED) if (re.test(text)) return unsupported(why);

  let rest = text.toLowerCase().replace(/[‘’ʼ]/g, "'");
  if (/[^\x00-\x7f]/.test(rest.replace(/[^\p{L}\p{N}]/gu, ""))) return clarify("I can only read plain English for now, so I didn't guess.");
  const sku = /\b[a-z]{2,}-\d+\b/.exec(rest)?.[0];
  if (sku && sku !== "demo-001") return unsupported(`The store doesn't have ${sku.toUpperCase()}.`);
  rest = rest.replace(/\bdemo-001\b/g, " jacket ").replace(/([a-z])-([a-z])/g, "$1 $2").replace(/\bwrong discount\b/g, "faulty discount");

  // Money first, so a total can't be read as a quantity. Only an exact, plainly written amount counts.
  const amounts: number[] = [];
  let moneyProblem: string | null = null;
  rest = rest.replace(MONEY, (m: string, neg1: string | undefined, a1: string | undefined, neg2: string | undefined, a2: string | undefined, neg3: string | undefined, a3: string | undefined, offset: number, whole: string) => {
    const raw = ((a1 ?? a2 ?? a3) as string).replace(/[.,]+$/, "");
    const before = whole.slice(0, offset) + m.slice(0, m.lastIndexOf(raw));
    if (neg1 || neg2 || neg3 || !MONEY_FORM.test(raw)) moneyProblem ??= `I couldn't read "${raw}" as an amount.`;
    if (NOT_EXACT_BEFORE.test(before) || NOT_EXACT_AFTER.test(whole.slice(offset + m.length))) moneyProblem ??= "I can only check one exact total, not a limit or a price per item.";
    amounts.push(Math.round(Number(raw.replaceAll(",", "")) * 100));
    return a3 !== undefined ? " total " : " ";
  });
  if (moneyProblem) return clarify(moneyProblem);
  const distinct = [...new Set(amounts)];
  if (distinct.length > 1) return clarify("You gave more than one amount, and I need a single expected total.");
  const expectedTotalCents = distinct[0] ?? null;
  if (expectedTotalCents !== null && !(Number.isSafeInteger(expectedTotalCents) && expectedTotalCents <= MAX_STATED_CENTS)) return clarify("That total is too large for me to check.");

  // Conditional approval is a request to order, not a refusal to.
  const afterApproval = cut(rest, /\b(?:don't|dont|do not|never)\s+(?:place|complete|submit|buy|purchase|order)\s+(?:(?:the|an?|my)\s+)?(?:(?:order|purchase|it)\s+)?(?:until|unless|before)\s+i\s+(?:approve|confirm)(?:\s+it)?\b/g);
  rest = afterApproval.rest;

  // Stopping points.
  const beforeCheckout = cut(rest, /\bstop\s+before\s+(?:you\s+|i\s+)?(?:(?:go|going|get|getting|reach|reaching|proceed|proceeding)\s+)?(?:to\s+)?(?:the\s+)?(?:checkout|check\s+out|checking\s+out)\b/g);
  rest = beforeCheckout.rest;
  const beforeOrder = cut(rest, new RegExp(`\\bstop\\s+before\\s+(?:you\\s+|i\\s+)?${ORDER_VERB}\\b(?:\\s+(?:the|an?|my))?(?:\\s+(?:order|purchase|it))?`, "g"));
  rest = beforeOrder.rest;
  const atCart = cut(rest, /\b(?:stop|stay|end|finish|finishing|stopping)\s+(?:at|in|on|with)\s+(?:the\s+|my\s+)?cart\b/g);
  rest = atCart.rest;

  // Negated phrases. Any negation left afterwards is one the parser doesn't understand.
  const noCode = cut(rest, new RegExp(`\\b${NEGATE}\\s+(?:with\\s+)?(?:(?:use|using|apply|applying|enter|entering|add|adding)\\s+)?(?:(?:any|an?|the|my)\\s+)?(?:${CODE_WORD}|save\\d+)\\b(?:\\s+[a-z]{1,8}\\d{1,4}\\b)?`, "g"));
  rest = noCode.rest;
  const noCheckout = cut(rest, new RegExp(`\\b${NEGATE}\\s+(?:(?:actually|ever|to)\\s+)*(?:(?:(?:go|going|get|getting|reach|reaching|proceed|proceeding|continue|continuing)\\s+(?:to\\s+)?(?:the\\s+)?)?checkout|checking\\s+out|check\\s+out)\\b`, "g"));
  rest = noCheckout.rest;
  const noOrder = cut(rest, new RegExp(`\\b${NEGATE}\\s+(?:(?:actually|ever|to)\\s+)*(?:${ORDER_VERB}\\b(?:\\s+(?:the|an?|any|my))?(?:\\s+(?:synthetic\\s+)?(?:order|purchase|it|anything|them)\\b)?|(?:(?:an?|any|the)\\s+)?(?:order|purchase)\\b)`, "g"));
  rest = noOrder.rest;
  const verifyOnly = cut(rest, /\b(?:verify|check|confirm)[- ]only\b|\bonly\s+(?:verify|check|confirm)\b/g);
  rest = verifyOnly.rest;

  const leftoverNegation = /\b(?:don't|dont|do not|does not|doesn't|never|without|not|no|avoid|skip|isn't|isnt|shouldn't|before|until|unless|except|instead)\b/.exec(rest);
  if (leftoverNegation) return clarify(`I couldn't tell what "${leftoverNegation[0]}" applies to, so I didn't guess. Please rephrase it.`);

  // Codes. A word after "code" counts as a code only if it looks like one.
  let namedCode: string | null = null;
  let codeProblem: string | null = null;
  rest = rest.replace(new RegExp(`\\b${CODE_WORD}\\s+(?:of\\s+|is\\s+|called\\s+|named\\s+)?([a-z][a-z0-9]*)\\b`, "g"), (m: string, tok: string) => {
    if (VOCABULARY.has(tok)) return m;
    if (!CODE_FORM.test(tok)) codeProblem ??= `"${tok.toUpperCase()}" doesn't look like a discount code.`;
    namedCode = tok;
    return " code ";
  });
  if (codeProblem) return clarify(codeProblem);
  const bare = [...rest.matchAll(/\bsave\d+\b/g)].map((m) => m[0]);
  rest = rest.replace(/\bsave\d+\b/g, " code ");
  const codes = new Set<string>([...(namedCode ? [namedCode as string] : []), ...bare]);
  if (codes.size > 1) return clarify("You gave more than one code.");
  const wantsCode = /\b(?:coupon|promo\w*|voucher|code)\b/.test(rest) || /\bdiscount\b/.test(rest.replace(/\bfaulty discount\b|\bbroken discount\b|\bdiscount bug\b/g, " "));
  if (noCode.hit && wantsCode) return clarify("You both asked for a code and asked not to use one.");
  const coupon: string | null = noCode.hit ? null : codes.size ? [...codes][0]!.toUpperCase() : wantsCode ? "SAVE10" : null;

  // Product. The store has one, so anything else named as the thing to buy is refused.
  const verb = new RegExp(`\\b(?:(?:buy|add|purchase|get|find|put)\\s+(?:me\\s+)?(?:${QTY}\\s+)*|order\\s+(?:me\\s+)?(?:for\\s+)?(?:${QTY}\\s+)*)(?:(?:proofops|field)\\s+)*([a-z]+)`, "g");
  for (const m of rest.matchAll(verb)) {
    if (VOCABULARY.has(m[1]!)) continue;
    // A ranking word is not a product name: say what the store can do instead of "doesn't sell most".
    if (RANKING.has(m[1]!)) return clarify(`I can't rank or search for items. The store has one product.`);
    return unsupported(`The store doesn't sell "${m[1]}".`);
  }

  // Every remaining word has to be understood.
  if (/(?:^|\s)-\s*\d|\d\.\d/.test(rest)) return clarify(`A quantity has to be a whole number from 1 to ${MAX_QUANTITY}.`);
  const words = rest.match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
  const unknown = words.find((w) => !/^\d+$/.test(w) && !VOCABULARY.has(w));
  if (unknown) return clarify(`I didn't understand "${unknown}", so I didn't guess.`);
  const relevant = /\b(?:jackets?|proofops|items?|products?|units?|cart|checkout|check out|discount|coupon|promo\w*|code|total|order|buy|purchase|add)\b/.test(rest) || noCode.hit || noOrder.hit || noCheckout.hit || atCart.hit;
  if (!relevant) return clarify("I didn't find a store task in that.");

  // Quantity: any number left is a quantity, because money has already been taken out.
  const quantities = [...new Set(words.flatMap((w) => (/^\d+$/.test(w) ? [Number(w)] : NUMBER_WORDS[w] ? [NUMBER_WORDS[w]!] : [])))];
  if (quantities.length > 1) return clarify("You gave more than one quantity.");
  const quantity = quantities[0] ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) return unsupported("The quantity has to be at least 1.");
  if (quantity > MAX_QUANTITY) return unsupported(`The store allows at most ${MAX_QUANTITY} at a time.`);

  // Checkout and order.
  const forbidOrder = noOrder.hit || noCheckout.hit || verifyOnly.hit || beforeOrder.hit || beforeCheckout.hit || atCart.hit;
  const asksOrder = afterApproval.hit
    || /\b(?:place|placing|complete|completing|submit|submitting|finish|finishing)\s+(?:(?:the|an?|my)\s+)?(?:synthetic\s+)?(?:order|purchase|checkout)\b/.test(rest)
    || /\b(?:buy|buying|purchase|purchasing)\b/.test(rest)
    || new RegExp(`\\border\\s+(?:me\\b|${NUMBER}\\b|an?\\b|the\\b|some\\b|proofops\\b|field\\b|jackets?\\b|items?\\b)`).test(rest);
  if (asksOrder && forbidOrder) return clarify("You both asked for an order and asked me to stop before one.");
  if (!asksOrder && /\b(?:order|orders|ordering)\b/.test(rest)) return clarify("I couldn't tell whether you want an order placed. Please say so plainly.");
  const placeOrder = asksOrder;
  const forbidCheckout = noCheckout.hit || beforeCheckout.hit || atCart.hit;
  const namesCheckout = /\bcheck ?out\b/.test(rest);
  if (forbidCheckout && namesCheckout) return clarify("You both named checkout and asked me not to go there.");
  const reachCheckout = !forbidCheckout && (placeOrder || namesCheckout || beforeOrder.hit);

  // Which version of the synthetic store to use.
  const storeCondition: TaskGoal["storeCondition"] = /\b(hostile|malicious|injection)\b/.test(rest) ? "hostile"
    : /\b(hung|hanging|frozen)\b/.test(rest) ? "hung"
    : /\b(broken checkout|checkout (?:is )?broken)\b/.test(rest) ? "broken"
    : /\b(faulty|defective|defect|buggy|bug|broken discount|seeded)\b/.test(rest) ? "faulty"
    : "normal";
  if (/\bbroken\b/.test(rest) && storeCondition === "normal") return clarify("I couldn't tell which part is broken. Please say the checkout or the discount.");
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
