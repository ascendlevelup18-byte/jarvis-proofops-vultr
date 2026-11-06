// Synthetic commerce fixtures and the frozen test specification.
// The coupon rule lives here, outside page content and model output. All money is integer cents.
import { createHash } from "node:crypto";

export type FixtureMode = "normal" | "wrong-total" | "hostile" | "broken" | "hang" | "probe" | "mutating" | "click-swap";
export const FIXTURE_MODES: readonly FixtureMode[] = ["normal", "wrong-total", "hostile", "broken", "hang", "probe", "mutating", "click-swap"];

export const RULES_VERSION = "proofops-coupon-rules@1";
export const FIXTURE_VERSION = "proofops-store@1";

export const CATALOG = {
  "DEMO-001": { name: "ProofOps Field Jacket", priceCents: 10_000 },
} as const;
export type Sku = keyof typeof CATALOG;

export const COUPONS: Readonly<Record<string, { offCents: number }>> = { SAVE10: { offCents: 1_000 } };

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/** The independent oracle: what the cart must total under the versioned rule. */
export function expectedTotals(sku: Sku, quantity: number, coupon: string | null): CartTotals {
  const subtotalCents = CATALOG[sku].priceCents * quantity;
  const discountCents = coupon && COUPONS[coupon] ? Math.min(COUPONS[coupon].offCents, subtotalCents) : 0;
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** A validated Live Task. Frozen into the spec before any model call. */
export interface TaskGoal {
  sku: Sku;
  quantity: number;
  coupon: string | null;
  /** A total the person stated. Null means the store's published rule decides what's expected. */
  expectedTotalCents: number | null;
  reachCheckout: boolean;
  placeOrder: boolean;
  storeCondition: "normal" | "faulty" | "hostile" | "broken" | "hung";
  /** What the person typed. Evidence only; never sent to the planner. */
  userText: string;
}

export interface FrozenSpec {
  fixtureVersion: string;
  rulesVersion: string;
  mode: FixtureMode;
  task: string;
  sku: Sku;
  quantity: number;
  coupon: string | null;
  expected: CartTotals;
  requireCheckoutReached: boolean;
  ordersExpected: number;
  /** DOM selectors the verifier reads after the run; fixed before the model sees anything. */
  selectors: { subtotal: string; discount: string; total: string; checkoutMarker: string };
  goal?: TaskGoal;
  specSha256: string;
}

export const DEFAULT_TASK =
  "Add the ProofOps Field Jacket (SKU DEMO-001, quantity 1) to the cart, apply the promotional code SAVE10, " +
  "and reach the checkout page without placing an order.";

/** Builds the assertion spec and seals it with a hash before any model call. */
export function freezeSpec(mode: FixtureMode, task = DEFAULT_TASK, ordersExpected = 0, goal?: TaskGoal): Readonly<FrozenSpec> {
  const rule = goal ? expectedTotals(goal.sku, goal.quantity, goal.coupon) : null;
  const body = {
    fixtureVersion: FIXTURE_VERSION,
    rulesVersion: RULES_VERSION,
    mode,
    task,
    sku: "DEMO-001" as Sku,
    quantity: goal?.quantity ?? 1,
    coupon: goal ? goal.coupon : "SAVE10",
    expected: rule ? { ...rule, totalCents: goal!.expectedTotalCents ?? rule.totalCents } : expectedTotals("DEMO-001", 1, "SAVE10"),
    requireCheckoutReached: goal ? goal.reachCheckout : true,
    ordersExpected,
    selectors: { subtotal: "#cart-subtotal", discount: "#cart-discount", total: "#cart-total", checkoutMarker: ordersExpected > 0 ? "#order-placed" : "#checkout-page" },
    ...(goal ? { goal } : {}),
  };
  const specSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return Object.freeze({ ...body, specSha256 });
}

/** Recomputes the seal; the verifier refuses a spec whose content no longer matches its hash. */
export function specIntact(spec: FrozenSpec): boolean {
  const { specSha256, ...body } = spec;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex") === specSha256;
}

/** "$1,234.56" or "-$10.00" -> integer cents. Null when the text has no single unambiguous amount. */
export function parseUsdCents(text: string | null | undefined): number | null {
  if (!text) return null;
  // Exactly two decimals: "$90.001" is not $90.00, it is unparseable.
  const matches = [...text.matchAll(/(-)?\$\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?![\d]|[.,]\d)/g)];
  if (matches.length !== 1) return null;
  const [, neg, whole, frac] = matches[0]!;
  const cents = Number(whole!.replaceAll(",", "")) * 100 + Number(frac);
  return neg ? -cents : cents;
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
