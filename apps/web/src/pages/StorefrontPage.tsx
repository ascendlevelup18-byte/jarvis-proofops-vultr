import { useEffect, useRef, useState } from "react";
import { btn, inputCls } from "../components/ui/styles.ts";
import type { Case, CaseRequest } from "../lib/case-types.ts";
import {
  customerReply,
  describeOrderBalance,
  fetchDemoStore,
  findOrder,
  refundRequestFor,
  type CustomerReply,
  type DemoStoreOrder,
  type DemoStoreSnapshot,
} from "../lib/demo-store.ts";
import { formatMinor } from "../lib/money.ts";

// Illustrative catalog for the storefront look only: not linked to orders or checkout.
const CATALOG = [
  { name: "Merino travel hoodie", price: 8999 },
  { name: "Canvas weekender bag", price: 18000 },
  { name: "Ceramic pour-over set", price: 4500 },
  { name: "Wool-blend throw", price: 6450 },
];

type ChatMessage =
  | { from: "bot"; text: string }
  | { from: "customer"; text: string }
  | { from: "pending"; text: string }
  | { from: "reply"; reply: CustomerReply; caseData: Case }
  | { from: "error"; text: string };

const REPLY_TONE: Record<CustomerReply["tone"], string> = {
  success: "border-[var(--color-policy-border)] bg-[var(--color-policy-surface)]",
  info: "border-[var(--color-jarvis-border-strong)] bg-[var(--color-jarvis-surface-2)]",
  review: "border-[var(--color-warning)]/50 bg-[var(--color-warning-surface)]",
  problem: "border-[var(--color-danger)]/50 bg-[var(--color-danger-surface)]",
};

export function StorefrontPage({
  snapshot: initial,
  onSubmit,
  onOpenCase,
  onExit,
}: {
  snapshot: DemoStoreSnapshot | null;
  onSubmit: (request: CaseRequest, order: DemoStoreOrder) => Promise<Case>;
  onOpenCase: (c: Case, order: DemoStoreOrder) => void;
  onExit: () => void;
}) {
  const [snapshot, setSnapshot] = useState<DemoStoreSnapshot | null>(initial);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<DemoStoreOrder | null>(null);
  const [lookupMiss, setLookupMiss] = useState(false);
  const [chatOrder, setChatOrder] = useState<DemoStoreOrder | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([
    { from: "bot", text: "Hi! I'm Northwind's support assistant, powered by JARVIS. Look up an order to get help with it." },
  ]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CustomerReply["tone"] | "error" | null>(null);
  const chatEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (snapshot) return;
    fetchDemoStore()
      .then(setSnapshot)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Store unavailable"));
  }, [snapshot]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [chat]);

  const lookup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!snapshot) return;
    const found = findOrder(snapshot, query);
    setOrder(found);
    setLookupMiss(!found);
  };

  const startSupport = (o: DemoStoreOrder) => {
    setChatOrder(o);
    setOutcome(null);
    setChat((c) => [
      ...c,
      { from: "bot", text: `I found order #${o.orderId} for ${o.customerName}: ${describeOrderBalance(o)}. What do you need help with?` },
    ]);
  };

  const sendRequest = async () => {
    if (!chatOrder || busy) return;
    const request = refundRequestFor(chatOrder);
    setBusy(true);
    setChat((c) => [...c, { from: "customer", text: request.message }, { from: "pending", text: "Sending your request to JARVIS…" }]);
    try {
      const result = await onSubmit(request, chatOrder);
      const reply = customerReply(result);
      setChat((c) => [...c.filter((m) => m.from !== "pending"), { from: "reply", reply, caseData: result }]);
      setOutcome(reply.tone);
    } catch (e) {
      setChat((c) => [
        ...c.filter((m) => m.from !== "pending"),
        { from: "error", text: `Sorry, I couldn't reach the support system: ${e instanceof Error ? e.message : "request failed"}` },
      ]);
      setOutcome("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-jarvis-bg)]">
      <header className="border-b border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-bg-elevated)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold tracking-tight text-[var(--color-jarvis-ink)]">Northwind Goods</p>
            <p className="mt-0.5 inline-block rounded-full border border-[var(--color-warning)]/30 bg-[var(--color-warning-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-warning)]">
              Demo storefront · synthetic data · simulated payments
            </p>
          </div>
          <button
            type="button"
            onClick={onExit}
            className={btn.secondary}
          >
            ← Merchant command center
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <section aria-labelledby="catalog-title">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="catalog-title" className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
                Shop
              </h2>
              <span className="text-[10px] text-[var(--color-jarvis-faint)]">Sample catalog · no checkout</span>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              {CATALOG.map((p) => (
                <li key={p.name} className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-3 shadow-card">
                  <div aria-hidden className="mb-2 grid h-20 place-items-center rounded-md bg-[var(--color-jarvis-surface-2)] text-lg font-semibold text-[var(--color-jarvis-border-strong)]">
                    {p.name.charAt(0)}
                  </div>
                  <p className="text-sm font-medium text-[var(--color-jarvis-ink)]">{p.name}</p>
                  <p className="font-mono text-xs text-[var(--color-jarvis-muted)]">{formatMinor(p.price, "USD")}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="orders-title" className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-4 shadow-card">
            <h2 id="orders-title" className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
              Track your order
            </h2>
            {loadError && (
              <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                {loadError}
              </p>
            )}
            {!snapshot && !loadError && <p className="mt-2 text-sm text-[var(--color-jarvis-muted)]">Loading orders…</p>}
            {snapshot && (
              <>
                <form onSubmit={lookup} className="mt-2 flex flex-wrap gap-2">
                  <label htmlFor="order-number" className="sr-only">
                    Order number
                  </label>
                  <input
                    id="order-number"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Order number, e.g. 48291"
                    className={`${inputCls} min-w-0 flex-1 basis-40`}
                  />
                  <button type="submit" className={btn.primary}>
                    Find order
                  </button>
                </form>
                <p className="mt-1.5 text-[11px] text-[var(--color-jarvis-faint)]">
                  Demo orders: {snapshot.orders.map((o) => `#${o.orderId}`).join(", ")}
                </p>
                {lookupMiss && <p className="mt-2 text-sm text-[var(--color-warning)]">No order with that number in the demo store.</p>}
                {order && (
                  <article aria-label={`Order ${order.orderId}`} className="mt-3 rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
                        Order #{order.orderId} · {order.customerName}
                      </p>
                      <p className="font-mono text-sm text-[var(--color-jarvis-ink)]">{formatMinor(order.totalMinor, order.currency)}</p>
                    </div>
                    <p className="text-xs text-[var(--color-jarvis-muted)]">Placed {order.placedAt.slice(0, 10)}</p>
                    <ul className="mt-2 space-y-1">
                      {order.charges.map((c) => (
                        <li key={c.id} className="flex flex-wrap justify-between gap-2 font-mono text-xs text-[var(--color-jarvis-muted)]">
                          <span>
                            Card charge {c.id.slice(-1)} · {c.status.toLowerCase()}
                          </span>
                          <span>
                            {formatMinor(c.amountMinor, c.currency)}
                            {c.refundedMinor > 0 && ` · refunded ${formatMinor(c.refundedMinor, c.currency)}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => startSupport(order)}
                        className={btn.primary}
                      >
                        Request a refund
                      </button>
                      <button
                        type="button"
                        onClick={() => startSupport(order)}
                        className={btn.secondary}
                      >
                        Contact support
                      </button>
                    </div>
                  </article>
                )}
              </>
            )}
          </section>
        </div>

        <aside aria-labelledby="support-title" className="flex max-h-[680px] flex-col rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-raised lg:sticky lg:top-4">
          <div className="border-b border-[var(--color-jarvis-border)] px-4 py-3">
            <h2 id="support-title" className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
              Support
            </h2>
            <p className="text-[11px] text-[var(--color-jarvis-faint)]">Replies reflect the recorded case outcome</p>
            <RequestProgress stage={!chatOrder ? 0 : busy ? 2 : outcome ? 3 : 1} outcome={outcome} />
          </div>
          <ol className="flex-1 space-y-2 overflow-y-auto px-4 py-3" aria-live="polite" aria-label="Support conversation">
            {chat.map((m, i) => (
              <li key={i} className={m.from === "customer" ? "flex justify-end" : ""}>
                {m.from === "bot" && <p className="max-w-[90%] rounded-lg rounded-tl-sm bg-[var(--color-jarvis-surface-2)] px-3 py-2 text-sm text-[var(--color-jarvis-ink)]">{m.text}</p>}
                {m.from === "customer" && (
                  <p className="max-w-[90%] rounded-lg rounded-tr-sm bg-[var(--color-deterministic)] px-3 py-2 text-sm text-[var(--color-jarvis-ink)]">{m.text}</p>
                )}
                {m.from === "pending" && <p className="text-xs italic text-[var(--color-jarvis-muted)]">{m.text}</p>}
                {m.from === "error" && (
                  <p role="alert" className="rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger-surface)] px-3 py-2 text-sm text-[var(--color-danger)]">
                    {m.text}
                  </p>
                )}
                {m.from === "reply" && (
                  <div className={`rounded-lg border px-3 py-2 ${REPLY_TONE[m.reply.tone]}`}>
                    <p className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{m.reply.title}</p>
                    <p className="mt-1 text-sm text-[var(--color-jarvis-ink)]/85">{m.reply.body}</p>
                    <p className="mt-2 font-mono text-[10px] text-[var(--color-jarvis-faint)]">{m.caseData.id}</p>
                    {chatOrder && (
                      <button
                        type="button"
                        onClick={() => onOpenCase(m.caseData, chatOrder)}
                        className="mt-1 text-xs text-[var(--color-deterministic-accent)] underline-offset-2 hover:underline"
                      >
                        View decision →
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
            <li ref={chatEnd} aria-hidden />
          </ol>
          <div className="space-y-2 border-t border-[var(--color-jarvis-border)] px-4 py-3">
            {chatOrder ? (
              <button
                type="button"
                disabled={busy}
                onClick={sendRequest}
                className="w-full rounded-md border border-[var(--color-deterministic-accent)] bg-[var(--color-deterministic)] px-3 py-2 text-left text-xs text-[var(--color-jarvis-ink)] disabled:cursor-wait disabled:opacity-60"
              >
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-deterministic-accent)]">
                  {busy ? "Sending…" : `Send for order #${chatOrder.orderId}`}
                </span>
                “{chatOrder.supportRequest.message}”
              </button>
            ) : (
              <p className="text-xs text-[var(--color-jarvis-muted)]">Find an order and choose “Request a refund”.</p>
            )}
            <label htmlFor="free-text" className="sr-only">
              Write your own message
            </label>
            <textarea
              id="free-text"
              disabled
              rows={2}
              placeholder="Custom messages require an operator token"
              className="w-full cursor-not-allowed resize-none rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] px-3 py-2 text-xs text-[var(--color-jarvis-faint)]"
            />
          </div>
        </aside>
      </main>
    </div>
  );
}

const STEPS = ["Find order", "Send request", "JARVIS reviews", "Outcome"] as const;

/** Where the customer is in the refund flow. The outcome step's label follows the recorded reply only. */
function RequestProgress({ stage, outcome }: { stage: 0 | 1 | 2 | 3; outcome: CustomerReply["tone"] | "error" | null }) {
  const outcomeLabel =
    outcome === "success" ? "Refund issued" : outcome === "review" ? "With our team" : outcome === "info" ? "Nothing to refund" : outcome ? "Not completed" : "Outcome";
  return (
    <ol aria-label="Request progress" className="mt-2 flex gap-1">
      {STEPS.map((label, i) => {
        const done = i < stage || (i === 3 && stage === 3);
        const current = i === stage && stage !== 3;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className="min-w-0 flex-1">
            <span
              aria-hidden
              className={`block h-1 rounded-full ${done ? "bg-[var(--color-deterministic-accent)]" : current ? "bg-[var(--color-deterministic-border)]" : "bg-[var(--color-jarvis-border)]"}`}
            />
            <span className={`mt-1 block truncate text-[10px] ${done || current ? "text-[var(--color-jarvis-ink)]" : "text-[var(--color-jarvis-faint)]"}`}>
              {i === 3 ? outcomeLabel : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
