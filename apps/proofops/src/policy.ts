// Typed model actions and the deterministic pre-dispatch policy.
// The model can only propose one of five actions. Every proposal is checked here, against the run's fixed scope
// and the CURRENT observation, before anything reaches the browser. A denied action is recorded as
// attempted -> denied -> not dispatched.
import { z } from "zod";

export const Action = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("navigate"), path: z.string().max(256), reason: z.string().max(300).optional() }).strict(),
  z.object({ tool: z.literal("click"), ref: z.string().regex(/^e\d{1,4}$/), epoch: z.number().int().nonnegative(), reason: z.string().max(300).optional() }).strict(),
  z.object({ tool: z.literal("fill"), ref: z.string().regex(/^e\d{1,4}$/), epoch: z.number().int().nonnegative(), value: z.string().max(64), reason: z.string().max(300).optional() }).strict(),
  z.object({ tool: z.literal("request_approval"), ref: z.string().regex(/^e\d{1,4}$/), epoch: z.number().int().nonnegative(), reason: z.string().max(300).optional() }).strict(),
  z.object({ tool: z.literal("finish"), note: z.string().max(500).optional() }).strict(),
]);
export type Action = z.infer<typeof Action>;

export interface ObservedElement {
  ref: string;
  tag: string; // a, button, input, select, textarea
  type?: string; // input/button type
  name?: string; // input name
  text: string; // visible label, trimmed
  href?: string; // absolute URL for links
  formAction?: string; // absolute URL a submit button posts to
  consequential?: boolean;
}

export interface Observation {
  epoch: number;
  url: string;
  title: string;
  text: string;
  elements: ObservedElement[];
}

export interface RunScope {
  /** Origin + session prefix, e.g. http://store.proofops.test/s/<sid>/ */
  base: string;
  /** Paths relative to base that navigate may open. */
  navigablePaths: readonly string[];
  /** Input names the model may type into. */
  fillableInputs: readonly string[];
  /** Absolute URL path suffixes that are consequential and need operator approval. */
  consequentialPaths: readonly string[];
  maxSteps: number;
}

export type PolicyDecision =
  | { decision: "allow"; rule: string; dispatch: Dispatch }
  | { decision: "deny"; rule: string; detail: string }
  | { decision: "needs_approval"; rule: string; detail: string };

export type Dispatch =
  | { op: "navigate"; url: string }
  | { op: "click"; ref: string; epoch: number }
  | { op: "fill"; ref: string; epoch: number; value: string }
  | { op: "finish" };

function insideScope(absUrl: string, scope: RunScope): boolean {
  try {
    const u = new URL(absUrl);
    const b = new URL(scope.base);
    return u.origin === b.origin && u.pathname.startsWith(b.pathname);
  } catch {
    return false;
  }
}

function isConsequential(el: ObservedElement, scope: RunScope): boolean {
  if (el.consequential) return true;
  const target = el.formAction ?? el.href;
  if (!target) return false;
  try {
    const p = new URL(target).pathname;
    return scope.consequentialPaths.some((c) => p.endsWith(c));
  } catch {
    return false;
  }
}

/** The single policy gate. Pure: same inputs, same decision. The model's wording never matters. */
export function checkAction(raw: unknown, obs: Observation | null, scope: RunScope, stepIndex: number): PolicyDecision {
  if (stepIndex >= scope.maxSteps) return { decision: "deny", rule: "step_budget", detail: `step ${stepIndex} >= ${scope.maxSteps}` };
  const parsed = Action.safeParse(raw);
  if (!parsed.success) return { decision: "deny", rule: "schema", detail: parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300) };
  const a = parsed.data;

  if (a.tool === "finish") return { decision: "allow", rule: "finish", dispatch: { op: "finish" } };

  if (a.tool === "navigate") {
    const p = a.path;
    if (!p.startsWith("/") || p.startsWith("//") || /[\\\s]|%2e|%2f|%5c|\.\.|:/i.test(p)) {
      return { decision: "deny", rule: "navigate_path_syntax", detail: "only plain relative paths are allowed" };
    }
    if (!scope.navigablePaths.includes(p)) return { decision: "deny", rule: "navigate_out_of_scope", detail: `path ${p} is not in the approved scope` };
    const url = new URL(p.slice(1), scope.base).toString();
    if (!insideScope(url, scope)) return { decision: "deny", rule: "navigate_out_of_scope", detail: "resolved outside the run's store" };
    return { decision: "allow", rule: "navigate_in_scope", dispatch: { op: "navigate", url } };
  }

  // Element actions: the reference must come from the current observation, same epoch.
  if (!obs) return { decision: "deny", rule: "no_observation", detail: "no current observation" };
  if (a.epoch !== obs.epoch) return { decision: "deny", rule: "stale_reference", detail: `epoch ${a.epoch} != current ${obs.epoch}` };
  const el = obs.elements.find((e) => e.ref === a.ref);
  if (!el) return { decision: "deny", rule: "unknown_reference", detail: `${a.ref} not in current observation` };

  if (a.tool === "fill") {
    const fillable = (el.tag === "input" && (!el.type || ["text", "search"].includes(el.type))) || el.tag === "textarea";
    if (!fillable) return { decision: "deny", rule: "fill_not_text_input", detail: `${el.tag}` };
    if (!el.name || !scope.fillableInputs.includes(el.name)) return { decision: "deny", rule: "fill_field_not_allowed", detail: `field ${el.name ?? "(unnamed)"}` };
    if (!/^[\x20-\x7e]*$/.test(a.value)) return { decision: "deny", rule: "fill_value_charset", detail: "printable ASCII only" };
    return { decision: "allow", rule: "fill_allowed_field", dispatch: { op: "fill", ref: a.ref, epoch: a.epoch, value: a.value } };
  }

  // click and request_approval
  const clickable = el.tag === "a" || el.tag === "button" || (el.tag === "input" && ["submit", "button"].includes(el.type ?? ""));
  if (!clickable) return { decision: "deny", rule: "click_not_clickable", detail: el.tag };
  if (el.href && !insideScope(el.href, scope)) return { decision: "deny", rule: "click_link_out_of_scope", detail: `link to ${el.href.slice(0, 120)}` };
  if (el.formAction && !insideScope(el.formAction, scope)) return { decision: "deny", rule: "click_form_out_of_scope", detail: "form posts outside the store" };
  if (isConsequential(el, scope)) {
    return { decision: "needs_approval", rule: "consequential_action", detail: `${el.text || a.ref} requires operator approval` };
  }
  if (a.tool === "request_approval") return { decision: "deny", rule: "approval_not_needed", detail: "element is not consequential" };
  return { decision: "allow", rule: "click_in_scope", dispatch: { op: "click", ref: a.ref, epoch: a.epoch } };
}
