import { useId, useState } from "react";
import type { DemoStoreSnapshot } from "../../lib/demo-store.ts";
import type { Route } from "../../lib/routes.ts";
import { searchRecords, type SearchHit as Hit } from "../../lib/search.ts";
import type { SessionCaseEntry } from "../../lib/session-store.ts";

export function GlobalSearch({ store, history, onSelect }: { store: DemoStoreSnapshot | null; history: SessionCaseEntry[]; onSelect: (r: Route) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const hits = searchRecords(q, store, history);
  const choose = (h: Hit) => {
    setQ("");
    setOpen(false);
    onSelect(h.route);
  };
  return (
    <div className="relative w-full max-w-sm">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search orders, customers and cases
      </label>
      <input
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={q}
        placeholder="Search orders, customers, cases"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, hits.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && hits[active]) choose(hits[active]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        className="w-full rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface-2)] px-3 py-1.5 text-sm text-[var(--color-jarvis-ink)] placeholder:text-[var(--color-jarvis-faint)] focus:border-[var(--color-deterministic-accent)] focus:bg-[var(--color-jarvis-surface)] focus:outline-none"
      />
      {open && q.trim() && (
        <ul id={listId} role="listbox" aria-label="Search results" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] py-1 shadow-raised">
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-jarvis-muted)]">No matching orders, customers or cases</li>
          ) : (
            hits.map((h, i) => (
              <li
                key={h.key}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(h);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${i === active ? "bg-[var(--color-deterministic)]" : ""}`}
              >
                <span className="w-16 shrink-0 text-[11px] text-[var(--color-jarvis-faint)]">{h.kind}</span>
                <span className="truncate font-medium text-[var(--color-jarvis-ink)]">{h.label}</span>
                <span className="ml-auto truncate text-xs text-[var(--color-jarvis-muted)]">{h.detail}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
