import { useMemo, useState, type ReactNode } from "react";
import { EmptyState, Pill, Segmented, type PillTone } from "../components/ui/Primitives.tsx";
import { btn, inputCls } from "../components/ui/styles.ts";
import { StateBadge } from "../components/ui/StateBadge.tsx";
import {
  buildInboxThreads,
  copilotBrief,
  filterThreads,
  INBOX_FILTER_LABELS,
  lifecycleOf,
  progressionOf,
  paymentStateOf,
  type InboxFilter,
  type InboxThread,
  type ThreadStatus,
} from "../lib/commerce.ts";
import { describeOrderBalance, type DemoStoreOrder, type DemoStoreSnapshot } from "../lib/demo-store.ts";
import { formatMinor } from "../lib/money.ts";
import { CHECK_LABELS } from "../lib/verdict.ts";
import { explainDecision } from "../lib/proof.ts";
import type { SessionCaseEntry } from "../lib/session-store.ts";

const STATUS_TONE: Record<ThreadStatus, PillTone> = {
  "Needs human": "warning",
  Resolved: "success",
  Closed: "neutral",
  Failed: "danger",
  "In progress": "info",
};

const REPLY_TONE = {
  success: "border-[var(--color-policy-border)] bg-[var(--color-policy-surface)]",
  info: "border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)]",
  review: "border-[var(--color-warning)]/30 bg-[var(--color-warning-surface)]",
  problem: "border-[var(--color-danger)]/30 bg-[var(--color-danger-surface)]",
} as const;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Support inbox: conversations exist only for requests this browser actually sent; no invented history. */
export function InboxPage({
  history,
  snapshot,
  onOpenCase,
  onOpenStore,
  onRerun,
}: {
  history: SessionCaseEntry[];
  snapshot: DemoStoreSnapshot | null;
  onOpenCase: (e: SessionCaseEntry) => void;
  onOpenStore: () => void;
  /** Re-sends the order's fixed customer request through POST /cases. */
  onRerun: (o: DemoStoreOrder) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const threads = useMemo(() => buildInboxThreads(history, snapshot), [history, snapshot]);
  const visible = filterThreads(threads, query, filter);
  const selected = threads.find((t) => t.orderId === selectedId) ?? visible[0] ?? null;

  if (threads.length === 0) {
    return (
      <div className="motion-fade-in space-y-4">
        <InboxHeader />
        <EmptyState
          title="No conversations yet"
          body="Request a refund in the demo store or run a Proof Mode scenario to start a conversation."
          action={
            <button type="button" className={btn.primary} onClick={onOpenStore}>
              Open demo store
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="motion-fade-in space-y-4">
      <InboxHeader />
      <div className="grid overflow-hidden rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] shadow-card lg:min-h-[640px] lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_360px]">
        {/* Left: queue */}
        <section aria-label="Conversation queue" className="flex min-w-0 flex-col border-b border-[var(--color-jarvis-border)] lg:border-b-0 lg:border-r">
          <div className="space-y-2 border-b border-[var(--color-jarvis-border)] p-3">
            <label htmlFor="inbox-search" className="sr-only">
              Search conversations
            </label>
            <input
              id="inbox-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customer, order…"
              className={inputCls}
            />
            <Segmented
              label="Conversation status"
              value={filter}
              onChange={setFilter}
              options={(Object.keys(INBOX_FILTER_LABELS) as InboxFilter[]).map((v) => ({ value: v, label: INBOX_FILTER_LABELS[v] }))}
            />
          </div>
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-[var(--color-jarvis-muted)]">No conversations match.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-[var(--color-jarvis-border)] overflow-y-auto lg:max-h-none lg:flex-1">
              {visible.map((t) => {
                const active = selected?.orderId === t.orderId;
                return (
                  <li key={t.orderId}>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setSelectedId(t.orderId)}
                      className={`block w-full px-3 py-2.5 text-left ${
                        active ? "bg-[var(--color-deterministic)]" : "hover:bg-[var(--color-jarvis-surface-2)]"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-[var(--color-jarvis-ink)]">{t.customerName}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-jarvis-faint)]">{time(t.lastAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-jarvis-muted)]">
                        #{t.orderId} · {t.lastText}
                      </span>
                      <span className="mt-1 block">
                        <Pill tone={STATUS_TONE[t.status]}>{t.status}</Pill>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected ? (
          <>
            <Conversation thread={selected} order={snapshot?.orders.find((o) => o.orderId === selected.orderId) ?? null} onOpenCase={onOpenCase} onRerun={onRerun} />
            <Copilot thread={selected} onOpenCase={onOpenCase} />
          </>
        ) : (
          <p className="p-6 text-sm text-[var(--color-jarvis-muted)]">Select a conversation.</p>
        )}
      </div>
    </div>
  );
}

function InboxHeader() {
  return (
    <header>
      <h2 className="text-xl font-semibold tracking-tight text-[var(--color-jarvis-ink)]">Support inbox</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--color-jarvis-muted)]">
        Customer requests and the replies JARVIS derived from each recorded case outcome. The Copilot panel is internal and never
        shown to the customer.
      </p>
    </header>
  );
}

function Conversation({
  thread,
  order,
  onOpenCase,
  onRerun,
}: {
  thread: InboxThread;
  order: DemoStoreOrder | null;
  onOpenCase: (e: SessionCaseEntry) => void;
  onRerun: (o: DemoStoreOrder) => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rerun = async () => {
    if (!order) return;
    setRunning(true);
    setError(null);
    try {
      await onRerun(order);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-label={`Conversation with ${thread.customerName}`} className="flex min-w-0 flex-col border-b border-[var(--color-jarvis-border)] xl:border-b-0 xl:border-r">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-jarvis-border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{thread.customerName}</h3>
          <p className="font-mono text-[11px] text-[var(--color-jarvis-faint)]">
            {thread.customerId} · order #{thread.orderId}
          </p>
        </div>
        <Pill tone={STATUS_TONE[thread.status]}>{thread.status}</Pill>
        <StateBadge state={thread.latest.state} />
      </header>

      {order && (
        <dl aria-label="Order context" className="grid grid-cols-2 gap-3 border-b border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] px-4 py-2.5 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[var(--color-jarvis-muted)]">Order total</dt>
            <dd className="font-medium tabular-nums">{formatMinor(order.totalMinor, order.currency)}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-jarvis-muted)]">Payment</dt>
            <dd className="font-medium">{paymentStateOf(order)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-[var(--color-jarvis-muted)]">Charges</dt>
            <dd className="font-medium">{describeOrderBalance(order)}</dd>
          </div>
        </dl>
      )}

      <div className="border-b border-[var(--color-jarvis-border)] px-4 py-2">
        <p className="text-[11px] font-medium text-[var(--color-jarvis-muted)]">Case progression · latest case</p>
        <ol aria-label="Case progression" className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
          {progressionOf(thread.latest.caseData).map((p, i, all) => (
            <li key={`${p.state}-${i}`} className="flex items-center gap-1">
              <span
                className={`rounded px-1.5 py-0.5 font-medium ${
                  i === all.length - 1 ? "bg-[var(--color-deterministic)] text-[var(--color-deterministic-accent)]" : "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-muted)]"
                }`}
              >
                {p.state.replaceAll("_", " ")}
              </span>
              {i < all.length - 1 && <span aria-hidden className="text-[var(--color-jarvis-faint)]">›</span>}
            </li>
          ))}
        </ol>
      </div>
      <ol aria-label="Message history" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {thread.messages.map((m, i) =>
          m.kind === "customer" ? (
            <li key={`${m.caseId}-c-${i}`} className="max-w-[85%]">
              <p className="mb-1 text-[11px] text-[var(--color-jarvis-faint)]">
                {thread.customerName} · {m.via === "storefront" ? "via demo store" : "demo request sent from the console"} · {time(m.at)}
              </p>
              <p className="rounded-lg rounded-tl-sm border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] px-3 py-2 text-sm text-[var(--color-jarvis-ink)]">
                {m.text}
              </p>
            </li>
          ) : (
            <li key={`${m.caseId}-r-${i}`} className="ml-auto max-w-[85%]">
              <p className="mb-1 text-right text-[11px] text-[var(--color-jarvis-faint)]">
                {m.delivered ? "Reply shown to customer in the demo store" : "Draft reply · not sent (case run from the console)"} · {time(m.at)}
              </p>
              <div className={`rounded-lg rounded-tr-sm border px-3 py-2 text-sm ${REPLY_TONE[m.reply.tone]}`}>
                <p className="font-semibold text-[var(--color-jarvis-ink)]">{m.reply.title}</p>
                <p className="mt-0.5 text-[var(--color-jarvis-muted)]">{m.reply.body}</p>
              </div>
            </li>
          ),
        )}
      </ol>

      <footer className="space-y-2 border-t border-[var(--color-jarvis-border)] p-3">
        <label htmlFor="inbox-reply" className="text-xs font-medium text-[var(--color-jarvis-muted)]">
          Reply to customer
        </label>
        <textarea
          id="inbox-reply"
          disabled
          rows={2}
          placeholder="Free-text replies are not available in the public demo"
          className={`${inputCls} cursor-not-allowed resize-none opacity-70`}
        />
        <p className="text-xs text-[var(--color-jarvis-faint)]">
          The public demo only accepts the four fixed customer requests. Free text (from customers or agents) needs an operator
          token held on the server, so model calls cannot be triggered anonymously. Replies above come only from recorded case
          outcomes.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn.secondary} onClick={() => onOpenCase(thread.latest)}>
            Open case evidence
          </button>
          {order && (
            <button type="button" className={btn.secondary} onClick={rerun} disabled={running}>
              {running ? "Running JARVIS…" : "Re-run JARVIS on this request"}
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </footer>
    </section>
  );
}

function Copilot({ thread, onOpenCase }: { thread: InboxThread; onOpenCase: (e: SessionCaseEntry) => void }) {
  const c = thread.latest.caseData;
  const brief = copilotBrief(c);
  return (
    <aside aria-label="JARVIS Copilot" className="min-w-0 space-y-4 bg-[var(--color-jarvis-surface-2)] p-4 lg:col-span-2 xl:col-span-1">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-jarvis-ink)]">JARVIS Copilot</h3>
        <p className="text-[11px] text-[var(--color-jarvis-faint)]">Internal · not visible to the customer · case {c.id}</p>
      </div>

      <CopilotSection title="Case summary">
        <p className="text-sm text-[var(--color-jarvis-ink)]">{explainDecision(c).title}</p>
        <p className="mt-0.5 text-xs text-[var(--color-jarvis-muted)]">{explainDecision(c).points[0]}</p>
      </CopilotSection>

      <CopilotSection title="Control-plane status">
        <ol aria-label="Control-plane status" className="space-y-1.5">
          {lifecycleOf(c).map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-xs">
              <span
                className={`mt-0.5 w-[74px] shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-bold tracking-wide ${
                  step.reached
                    ? step.key === "ESCALATED"
                      ? "bg-[var(--color-warning-surface)] text-[var(--color-warning)]"
                      : "bg-[var(--color-policy-surface)] text-[var(--color-policy-accent)]"
                    : "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-faint)]"
                }`}
              >
                {step.key}
              </span>
              <span className={step.reached ? "text-[var(--color-jarvis-ink)]" : "text-[var(--color-jarvis-muted)]"}>
                <span className="sr-only">{step.reached ? "Reached: " : "Not reached: "}</span>
                {step.detail}
              </span>
            </li>
          ))}
        </ol>
      </CopilotSection>

      <CopilotSection title="AI proposal" tag={<Pill tone="ai">No execution authority</Pill>}>
        {brief.proposal ? (
          <>
            <p className="font-mono text-xs font-semibold text-[var(--color-ai-accent)]">{brief.proposal.action}</p>
            <p className="mt-1 text-sm text-[var(--color-jarvis-ink)]">{brief.proposal.rationale}</p>
            <p className="mt-1 text-[11px] text-[var(--color-jarvis-faint)]">Model confidence {Math.round(brief.proposal.confidence * 100)}%</p>
          </>
        ) : (
          <p className="text-sm text-[var(--color-jarvis-muted)]">No proposal recorded (the case ended earlier).</p>
        )}
      </CopilotSection>

      <CopilotSection title="Policy decision" tag={<Pill tone="success">Deterministic</Pill>}>
        <p className="text-sm text-[var(--color-jarvis-ink)]">
          {c.authorization ? (
            <>
              <span className="font-semibold">{c.authorization.outcome}</span> · {brief.checks.passed} of {brief.checks.total} checks passed
            </>
          ) : (
            "Policy not evaluated"
          )}
        </p>
        {brief.checks.failed.length > 0 && (
          <ul className="mt-2 space-y-1">
            {brief.checks.failed.map((f) => (
              <li key={f.rule} className="text-xs text-[var(--color-warning)]">
                <span className="font-semibold">{CHECK_LABELS[f.rule] ?? f.rule}</span> — {f.detail}
              </li>
            ))}
          </ul>
        )}
        {brief.policyRefs.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-medium text-[var(--color-jarvis-muted)]">Policy sections cited</p>
            <ul className="mt-1 space-y-1">
              {brief.policyRefs.map((r) => (
                <li key={r.id} className="text-xs text-[var(--color-jarvis-muted)]">
                  <span className="font-mono font-semibold text-[var(--color-jarvis-ink)]">{r.id}</span> {r.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CopilotSection>

      <CopilotSection title="Evidence" tag={<Pill tone="neutral">System of record</Pill>}>
        {brief.evidence.length ? (
          <dl className="grid grid-cols-2 gap-2 text-xs">
            {brief.evidence.map((e) => (
              <div key={e.label} className="min-w-0">
                <dt className="text-[var(--color-jarvis-muted)]">{e.label}</dt>
                <dd className="break-words font-medium text-[var(--color-jarvis-ink)]">{e.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-[var(--color-jarvis-muted)]">No evidence gathered.</p>
        )}
      </CopilotSection>

      <CopilotSection title="Approval">
        <p className={`text-sm ${brief.approval.required ? "text-[var(--color-warning)]" : "text-[var(--color-jarvis-ink)]"}`}>
          {brief.approval.required ? "Human review required. " : ""}
          {brief.approval.text}
        </p>
      </CopilotSection>

      <CopilotSection title="Verification">
        <p className="text-sm text-[var(--color-jarvis-ink)]">
          {brief.verification === "Verified" && c.verification?.observedRefund
            ? `Verified: read-back observed refund ${c.verification.observedRefund.id} (${formatMinor(c.verification.observedRefund.amountMinor, c.verification.observedRefund.currency)}, simulated)`
            : brief.verification === "Not verified"
              ? "Not verified: the refund could not be confirmed, so the case is not resolved"
              : "Not executed: no refund was sent, so there is nothing to verify"}
        </p>
      </CopilotSection>

      <button type="button" className={`${btn.primary} w-full`} onClick={() => onOpenCase(thread.latest)}>
        Open audit trail ({c.audit.length} events)
      </button>
    </aside>
  );
}

function CopilotSection({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-jarvis-muted)]">{title}</h4>
        {tag}
      </div>
      {children}
    </section>
  );
}
