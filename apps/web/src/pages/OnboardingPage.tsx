import { useState } from "react";
import { btn, inputCls } from "../components/ui/styles.ts";
import { AUTOMATION_MODULES, checkStoreDomain, validateModuleSelection, type AutomationModule } from "../lib/automations.ts";
import { describeOrderBalance, fetchDemoStore, type DemoStoreSnapshot } from "../lib/demo-store.ts";

export interface OnboardingResult {
  modules: AutomationModule["id"][];
  store: DemoStoreSnapshot;
}

/** First run: choose automations, then connect the demo store (real seeded backend data). */
export function OnboardingPage({ onComplete }: { onComplete: (r: OnboardingResult) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<AutomationModule["id"][]>(["refunds"]);
  const [domain, setDomain] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [store, setStore] = useState<DemoStoreSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selection = validateModuleSelection(selected);
  const domainCheck = domain.trim() ? checkStoreDomain(domain) : null;

  const toggle = (id: AutomationModule["id"]) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const connectDemo = async () => {
    setConnecting(true);
    setError(null);
    try {
      setStore(await fetchDemoStore());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the demo store");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col px-4 py-10 sm:px-6">
      <p className="text-xs font-medium text-[var(--color-jarvis-faint)]">
        JARVIS Automations · setup · step {step} of 2
      </p>

      {step === 1 ? (
        <section aria-labelledby="ob-modules" className="motion-fade-in mt-3">
          <h1 id="ob-modules" className="text-3xl font-semibold tracking-tight text-[var(--color-jarvis-ink)]">
            What do you want to automate?
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-jarvis-muted)]">
            Choose an automation. Active modules can run; preview modules are planned.
          </p>
          <fieldset className="mt-6">
            <legend className="sr-only">Automation modules</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {AUTOMATION_MODULES.map((m) => {
                const on = selected.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-4 shadow-card transition-colors ${
                      on
                        ? "border-[var(--color-deterministic-accent)] bg-[var(--color-deterministic)]"
                        : "border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] hover:border-[var(--color-jarvis-border-strong)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(m.id)}
                      className="mt-1 h-4 w-4 accent-[var(--color-deterministic-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--color-jarvis-ink)]">{m.title}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                            m.status === "operational"
                              ? "bg-[var(--color-policy-accent)]/15 text-[var(--color-policy-accent)]"
                              : "bg-[var(--color-jarvis-surface-2)] text-[var(--color-jarvis-muted)]"
                          }`}
                        >
                          {m.status === "operational" ? "Operational" : "Preview"}
                        </span>
                      </span>
                      <span className="mt-1 block text-sm text-[var(--color-jarvis-ink)]/85">{m.summary}</span>
                      <span className="mt-1 block text-xs text-[var(--color-jarvis-muted)]">{m.reality}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!selection.ok}
              onClick={() => setStep(2)}
              className={btn.primary}
            >
              Continue
            </button>
            {!selection.ok && <span className="text-xs text-[var(--color-warning)]">{selection.error}</span>}
          </div>
        </section>
      ) : (
        <section aria-labelledby="ob-store" className="motion-fade-in mt-3 space-y-5">
          <h1 id="ob-store" className="text-3xl font-semibold tracking-tight text-[var(--color-jarvis-ink)]">
            Connect your store
          </h1>

          <div className="rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-4 shadow-card">
            <label htmlFor="store-domain" className="text-sm font-semibold text-[var(--color-jarvis-ink)]">
              Your store domain
            </label>
            <p className="mt-0.5 text-xs text-[var(--color-jarvis-muted)]">
              Store integrations are not available yet. Entering a domain does not connect a store.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                id="store-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="yourstore.com"
                autoComplete="off"
                className={`${inputCls} min-w-0 flex-1 basis-48`}
              />
              <button
                type="button"
                disabled
                className={`${btn.secondary} cursor-not-allowed`}
              >
                Coming soon
              </button>
            </div>
            {domainCheck && (
              <p className={`mt-2 text-xs ${domainCheck.valid ? "text-[var(--color-jarvis-muted)]" : "text-[var(--color-warning)]"}`}>
                {domainCheck.message}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-[var(--color-deterministic-border)] bg-[var(--color-deterministic)] p-4">
            <p className="text-sm font-semibold text-[var(--color-jarvis-ink)]">Use the demo store</p>
            <p className="mt-0.5 text-xs text-[var(--color-jarvis-muted)]">
              A seeded store on the JARVIS backend: synthetic customers and orders, simulated payments.
            </p>
            {!store && (
              <button
                type="button"
                onClick={connectDemo}
                disabled={connecting}
                className={`${btn.secondary} mt-3`}
              >
                {connecting ? "Connecting…" : "Connect demo store"}
              </button>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
                {error}
              </p>
            )}
            {store && (
              <div className="mt-3" aria-live="polite">
                <p className="text-sm font-semibold text-[var(--color-policy-accent)]">
                  Connected: {store.store.name} · {store.orders.length} orders read from the backend
                </p>
                <ul className="mt-2 space-y-1 text-xs text-[var(--color-jarvis-muted)]">
                  {store.orders.map((o) => (
                    <li key={o.orderId} className="font-mono">
                      #{o.orderId} · {o.customerName} · {describeOrderBalance(o)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              className={btn.secondary}
            >
              Back
            </button>
            <button
              type="button"
              disabled={!store}
              onClick={() => store && onComplete({ modules: selected, store })}
              className={btn.primary}
            >
              Open command center
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
