import { useState } from "react";
import { evidenceUrl } from "../../lib/recorded-amd-run.ts";
import { BUSINESS_CASE_FILE, DEFAULT_ASSUMPTIONS, LIMITS, PILOT_MEASURES, PILOT_STEPS, clampNote, computeImpact, usedValue, type ImpactAssumptions } from "../../lib/merchant-impact.ts";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n !== 0 && Math.abs(n) < 100 ? 2 : 0 });
const num = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });

const FIELDS: { key: keyof ImpactAssumptions; label: string; step: number; suffix?: string; note: string }[] = [
  { key: "casesPerMonth", label: "Duplicate-charge tickets per month", step: 50, note: "Ask the merchant" },
  { key: "minutesPerCase", label: "Agent minutes per case today", step: 1, suffix: "min", note: "Time it in the pilot" },
  { key: "autoResolvedPct", label: "Closed by JARVIS with no human", step: 5, suffix: "%", note: "Benchmark rate on an adversarial set; real traffic unmeasured" },
  { key: "loadedCostPerHour", label: "Loaded agent cost per hour", step: 1, suffix: "USD", note: "Assumption" },
  { key: "feePerResolved", label: "JARVIS fee per resolved case", step: 0.05, suffix: "USD", note: "Pricing hypothesis" },
  { key: "feePerEscalation", label: "JARVIS fee per escalation", step: 0.05, suffix: "USD", note: "Pricing hypothesis" },
  { key: "monthlyMinimum", label: "Monthly minimum", step: 1, suffix: "USD", note: "Pricing hypothesis" },
  { key: "modelCostPerCase", label: "Model cost per case", step: 0.001, suffix: "USD", note: "Not measured for JARVIS; enter your provider's price" },
];

/** Editable value model from the business case. All outputs are hypotheses, never observed savings. */
export function MerchantImpact() {
  const [a, setA] = useState<ImpactAssumptions>(DEFAULT_ASSUMPTIONS);
  const r = computeImpact(a);
  const set = (key: keyof ImpactAssumptions, v: string) => setA({ ...a, [key]: v === "" ? 0 : Number(v) });

  return (
    <section id="judge-impact" aria-labelledby="judge-impact-title" className="judge-section">
      <div className="judge-section-head">
        <div>
          <h3 id="judge-impact-title">6 · Merchant impact studio (hypothesis)</h3>
          <p>
            Change the assumptions to see what one merchant's duplicate-charge queue could be worth. These are estimates from the{" "}
            <a href={evidenceUrl(BUSINESS_CASE_FILE)}>business case</a>, not observed savings or ROI: JARVIS has no customers or measured merchant data.
          </p>
        </div>
        <button type="button" className="impact-reset" onClick={() => setA(DEFAULT_ASSUMPTIONS)}>
          Reset to business-case defaults
        </button>
      </div>

      <div className="impact-grid">
        <fieldset className="impact-inputs">
          <legend>Assumptions (all editable)</legend>
          {FIELDS.map((f) => {
            const clamped = clampNote(f.key, a[f.key]);
            return (
              <label key={f.key}>
                <span>{f.label}</span>
                <span className="impact-input">
                  <input type="number" inputMode="decimal" min={LIMITS[f.key][0]} max={LIMITS[f.key][1]} step={f.step} value={a[f.key]} aria-invalid={clamped ? true : undefined} onChange={(e) => set(f.key, e.target.value)} />
                  {f.suffix && <span className="muted">{f.suffix}</span>}
                </span>
                {clamped && <small className="impact-clamp" role="status">{clamped}</small>}
                <small>{f.note}</small>
              </label>
            );
          })}
        </fieldset>

        <div className="impact-out" aria-live="polite">
          <dl className="impact-metrics">
            <div><dt>Handling hours saved / month</dt><dd>{num(r.hoursSaved, 1)} h</dd></div>
            <div><dt>Labor capacity value / month</dt><dd>{usd(r.laborValue)}</dd></div>
            <div><dt>Processing cost / month{a.modelCostPerCase === 0 ? " (model cost not included)" : ""}</dt><dd>{usd(r.processingCost)}</dd></div>
            <div className={r.netHypothesis >= 0 ? "impact-net" : "impact-net impact-neg"}><dt>Net value hypothesis / month</dt><dd>{usd(r.netHypothesis)}</dd></div>
          </dl>
          <p className="impact-formula">
            Hours = tickets × closed share × minutes ÷ 60 = {num(usedValue("casesPerMonth", a.casesPerMonth))} × {num(usedValue("autoResolvedPct", a.autoResolvedPct), 1)}% × {num(usedValue("minutesPerCase", a.minutesPerCase), 1)} ÷ 60. Processing = JARVIS fee{" "}
            {usd(r.jarvisFee)}
            {r.minimumApplies ? " (monthly minimum applies)" : ""} + model cost{" "}
            {a.modelCostPerCase === 0 ? "not included: JARVIS model cost per case has not been measured, so it stays $0 until you enter your provider's price" : usd(r.modelCost)}. {num(r.escalated)} escalations a month still go to people, with the evidence assembled;
            that time is not counted.
          </p>
          <p className="amd-note">Not counted either: prevented wrong or double refunds, chargeback fees. Their real frequency at a merchant is unknown.</p>
        </div>
      </div>

      <div className="impact-pilot">
        <div>
          <h4>Proposed 30-day shadow-mode pilot</h4>
          <ol>
            {PILOT_STEPS.map((s) => (
              <li key={s.when}>
                <strong>{s.when}.</strong> {s.what}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h4>What the merchant must measure</h4>
          <ul>
            {PILOT_MEASURES.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
