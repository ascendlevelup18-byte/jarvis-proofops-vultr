import { useMemo, useState } from "react";
import { BASELINE_FILE } from "../../lib/baseline-result.ts";
import { formatMinor } from "../../lib/money.ts";
import { evidenceUrl } from "../../lib/recorded-amd-run.ts";
import { ALL, explainJarvis, filterRows, money, pickSelected, reasonLines, summarize, unique, type StressLabFilter } from "../../lib/stress-lab.ts";
import { STRESS_LAB_ROWS } from "../../lib/stress-lab-data.ts";

export const DATASET_FILE = "data/cases/duplicate-charge-eval.v1.json";
export const FIXTURE_RESULT_FILE = "evals/results/duplicate-charge-eval.v1.json";

const stateClass = (s: string) => (s === "RESOLVED" ? "st-ok" : s === "CLOSED_NO_ACTION" ? "st-neutral" : s === "ESCALATED" ? "st-review" : "st-fail");

/** Interactive view of the 30 pinned adversarial cases: JARVIS versus the same proposals with policy removed. Read-only. */
export function StressLab() {
  // The 30-case body mounts only when a judge opens the lab; closed, it costs one summary line.
  const [open, setOpen] = useState(false);
  return (
    <details className="stress-lab" id="judge-stress-lab" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="stress-title">Policy stress lab: open all {STRESS_LAB_ROWS.length} cases</span>
        <span className="stress-sub">
          See each case's records, the proposal, what JARVIS did and what the same proposal would have done without policy.
        </span>
      </summary>
      {open && <StressLabBody />}
    </details>
  );
}

function StressLabBody() {
  const [filter, setFilter] = useState<StressLabFilter>({ category: ALL, jarvis: ALL, unsafeOnly: false });
  const [selectedId, setSelectedId] = useState(STRESS_LAB_ROWS[0].id);
  const rows = useMemo(() => filterRows(STRESS_LAB_ROWS, filter), [filter]);
  const all = summarize(STRESS_LAB_ROWS);
  // The detail always shows a case that is in the filtered list (the first one if the choice was filtered out).
  const selected = pickSelected(rows, selectedId);
  const categories = unique(STRESS_LAB_ROWS.map((r) => r.category));
  const states = unique(STRESS_LAB_ROWS.map((r) => r.jarvis.finalState));

  return (
    <>
      <p className="amd-note" role="note">
        Offline comparison with a deliberately naive fixture proposer, not an AMD or real-model result. No-policy refunds are counterfactuals computed from
        each case's records and never sent to any gateway. Data: <a href={evidenceUrl(DATASET_FILE)}>pinned dataset</a> ·{" "}
        <a href={evidenceUrl(FIXTURE_RESULT_FILE)}>JARVIS fixture results</a> · <a href={evidenceUrl(BASELINE_FILE)}>no-policy results</a>
      </p>

      <div className="stress-filters" role="group" aria-label="Filter cases">
        <label>
          Category
          <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })}>
            <option value={ALL}>All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          JARVIS outcome
          <select value={filter.jarvis} onChange={(e) => setFilter({ ...filter, jarvis: e.target.value })}>
            <option value={ALL}>All outcomes</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="stress-check">
          <input type="checkbox" checked={filter.unsafeOnly} onChange={(e) => setFilter({ ...filter, unsafeOnly: e.target.checked })} />
          Only cases unsafe without policy ({all.noPolicyUnsafe})
        </label>
        <span className="muted" aria-live="polite">
          {rows.length} of {all.total} shown
        </span>
      </div>

      <div className="stress-body">
        <ul className="stress-list" aria-label="Cases">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" aria-pressed={r.id === selected?.id} className={r.id === selected?.id ? "stress-row stress-row-on" : "stress-row"} onClick={() => setSelectedId(r.id)}>
                <span className="mono">{r.id}</span>
                <span className="stress-row-title">{r.title}</span>
                <span className={`st ${stateClass(r.jarvis.finalState)}`}>JARVIS {r.jarvis.finalState}</span>
                {r.noPolicy.unsafe ? <span className="st st-fail">No policy: unsafe</span> : <span className="st st-neutral">No policy: same</span>}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="judge-empty">No case matches these filters.</li>}
        </ul>

        {selected && (
        <article className="stress-detail" aria-live="polite" aria-label={`Case ${selected.id}`}>
          <p className="verdict-order">
            {selected.id} · {selected.category} · risk {selected.risk}
            {selected.scriptedProposal && " · scripted hostile proposal"}
          </p>
          <h5>{selected.title}</h5>
          <blockquote className="verdict-quote">“{selected.message}”</blockquote>
          <p className="stress-label">Customer text is untrusted input; amounts in it carry no authority.</p>

          <h6>Records</h6>
          <ul className="stress-records">
            {selected.orderTotalMinor !== null && <li>Order total {formatMinor(selected.orderTotalMinor, selected.currency)}</li>}
            {selected.charges.map((c) => (
              <li key={c.id}>
                Charge <span className="mono">{c.id}</span> {formatMinor(c.amountMinor, selected.currency)} · {c.status}
              </li>
            ))}
            {selected.charges.length === 0 && <li>No charges recorded for this order</li>}
            {selected.priorRefunds.map((r) => (
              <li key={r.id}>
                Prior refund <span className="mono">{r.id}</span> {formatMinor(r.amountMinor, selected.currency)} on {r.transactionId}
              </li>
            ))}
          </ul>

          <h6>Proposal (same in both columns)</h6>
          <p className="mono">{selected.proposal}</p>

          <div className="stress-compare">
            <section className="baseline-jarvis">
              <h6>With JARVIS policy</h6>
              <p>
                <span className={`st ${stateClass(selected.jarvis.finalState)}`}>{selected.jarvis.finalState}</span>{" "}
                {selected.jarvis.finalState === selected.expected.finalState ? "matches ground truth" : `ground truth ${selected.expected.finalState}`}
              </p>
              <p>{money(selected.jarvis.moneyMoved, selected.currency)}{selected.jarvis.moneyMoved.length > 0 && " (simulated)"}</p>
              <p>{explainJarvis(selected)}</p>
              {selected.jarvis.reasons.length > 0 && (
                <ul>
                  {reasonLines(selected.jarvis.reasons).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </section>
            <section className={selected.noPolicy.unsafe ? "baseline-bare" : ""}>
              <h6>Same proposal, policy removed</h6>
              <p>
                <span className={`st ${stateClass(selected.noPolicy.finalState)}`}>{selected.noPolicy.finalState}</span>{" "}
                {selected.noPolicy.unsafe ? <strong className="danger">unsafe</strong> : "not unsafe"}
              </p>
              <p>{money(selected.noPolicy.moneyMoved, selected.currency)}{selected.noPolicy.moneyMoved.length > 0 && " (counterfactual, never executed)"}</p>
              {selected.noPolicy.unsafe && selected.noPolicy.moneyMoved.length === 0 && (
                <p>Unsafe because it finished the case on its own ({selected.noPolicy.finalState}) where ground truth requires {selected.expected.finalState}.</p>
              )}
              <p className="muted">Classified {selected.noPolicy.classification.replaceAll("_", " ").toLowerCase()}.</p>
            </section>
          </div>

          <h6>Why this is the right answer</h6>
          <p>{selected.rationale}</p>
        </article>
        )}
      </div>
    </>
  );
}
