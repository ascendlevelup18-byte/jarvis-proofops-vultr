import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { OpsShell } from "./components/layout/OpsShell.tsx";
import { CommandCenter } from "./components/operations/CommandCenter.tsx";
import { InvestigationView } from "./components/investigation/InvestigationView.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { CasesPage } from "./pages/CasesPage.tsx";
import { SystemPage } from "./pages/SystemPage.tsx";
import { ApprovalsPage } from "./pages/ApprovalsPage.tsx";
import { AutomationsPage } from "./pages/AutomationsPage.tsx";
import { OnboardingPage } from "./pages/OnboardingPage.tsx";
import { StorefrontPage } from "./pages/StorefrontPage.tsx";
import { OrdersPage, type StoreLoad } from "./pages/OrdersPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { AssistantPanel } from "./components/assistant/AssistantPanel.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { CustomersPage } from "./pages/CustomersPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { EmptyState, LoadingRows } from "./components/ui/Primitives.tsx";
import { btn } from "./components/ui/styles.ts";
import type { AutomationModule } from "./lib/automations.ts";
import { fetchDemoStore, refundRequestFor, type DemoStoreOrder, type DemoStoreSnapshot } from "./lib/demo-store.ts";
import { DEMO_SCENARIOS, type DemoScenario } from "./fixtures/demo-scenarios.ts";
import type { ShowdownSide, ShowdownState } from "./components/proof/SafetyShowdown.tsx";
import { ApiError, submitCase } from "./lib/api.ts";
import type { Case, CaseRequest } from "./lib/case-types.ts";
import { navLabel, type NavId } from "./lib/system-truth.ts";
import { formatRoute, parseRoute, type Route } from "./lib/routes.ts";
import {
  appendSessionCase,
  clearRecordedCases,
  loadRecordedCases,
  saveRecordedCases,
  type SessionCaseEntry,
} from "./lib/session-store.ts";

// Setup choices are a per-browser convenience; the app works without storage.
const SETUP_KEY = "jarvis.setup.v1";
function loadSetup(): AutomationModule["id"][] | null {
  try {
    const raw = window.localStorage.getItem(SETUP_KEY);
    const parsed = raw ? (JSON.parse(raw) as { modules?: unknown }) : null;
    return Array.isArray(parsed?.modules) ? (parsed.modules as AutomationModule["id"][]) : null;
  } catch {
    return null;
  }
}
function saveSetup(modules: AutomationModule["id"][]): void {
  try {
    window.localStorage.setItem(SETUP_KEY, JSON.stringify({ modules }));
  } catch {
    /* storage unavailable: setup simply isn't remembered */
  }
}

type MerchantRoute = Extract<Route, { surface: "merchant" }>;
// The analytics workspace (charts, sample dataset) loads on first visit.
const BenchmarksPage = lazy(() => import("./pages/BenchmarksPage.tsx").then((m) => ({ default: m.BenchmarksPage })));

const CommandCenterPage = lazy(() => import("./pages/CommandCenterPage.tsx").then(m => ({ default: m.CommandCenterPage })));
const TeamPage = lazy(() => import("./pages/TeamPage.tsx").then((m) => ({ default: m.TeamPage })));
const JudgePage = lazy(() => import("./pages/JudgePage.tsx").then((m) => ({ default: m.JudgePage })));

const DEFAULT_ROUTE: MerchantRoute = { surface: "merchant", nav: "dashboard" };
function initialRoute(): Route {
  const parsed = typeof window === "undefined" ? null : parseRoute(window.location.hash);
  if (parsed) return parsed;
  return DEFAULT_ROUTE;
}

const errorText = (e: unknown) => (e instanceof ApiError ? `${e.message} (${e.status})` : e instanceof Error ? e.message : "Request failed");

export default function App() {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDemoId, setActiveDemoId] = useState<string | undefined>();
  const [history, setHistory] = useState<SessionCaseEntry[]>(loadRecordedCases);
  const [showdown, setShowdown] = useState<ShowdownState>({ status: "idle" });
  const [modules, setModules] = useState<AutomationModule["id"][]>(() => loadSetup() ?? ["refunds"]);
  const [storeSnapshot, setStoreSnapshot] = useState<DemoStoreSnapshot | null>(null);
  const [storeLoad, setStoreLoad] = useState<StoreLoad>({ status: "loading" });
  // The merchant page an investigation was opened from, for its back button.
  const [returnTo, setReturnTo] = useState<Route>(DEFAULT_ROUTE);

  const navigate = useCallback((next: Route, replace = false) => {
    const hash = formatRoute(next);
    if (window.location.hash !== hash) window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    setRoute(next);
  }, []);

  // Browser back/forward and manually edited hashes.
  useEffect(() => {
    const sync = () => {
      const parsed = parseRoute(window.location.hash);
      if (!parsed && window.location.hash) window.history.replaceState(null, "", formatRoute(DEFAULT_ROUTE));
      setRoute(parsed ?? DEFAULT_ROUTE);
    };
    // A bad initial hash (typo or stale link) is replaced too, so the address bar matches the page.
    if (window.location.hash && !parseRoute(window.location.hash)) window.history.replaceState(null, "", loadSetup() ? formatRoute(DEFAULT_ROUTE) : "#setup");
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  // The demo store seed backs Orders, Customers, Inbox, search and analytics; read it once.
  const loadStore = useCallback(() => {
    setStoreLoad({ status: "loading" });
    fetchDemoStore()
      .then((s) => {
        setStoreSnapshot(s);
        setStoreLoad({ status: "idle" });
      })
      .catch((e: unknown) => setStoreLoad({ status: "error", error: errorText(e) }));
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetchDemoStore()
      .then((s) => {
        if (cancelled) return;
        setStoreSnapshot(s);
        setStoreLoad({ status: "idle" });
      })
      .catch((e: unknown) => !cancelled && setStoreLoad({ status: "error", error: errorText(e) }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => saveRecordedCases(history), [history]);

  const openCase = useCallback(
    (caseId: string) => {
      if (window.location.hash && !window.location.hash.startsWith("#/case/")) setReturnTo(parseRoute(window.location.hash) ?? DEFAULT_ROUTE);
      navigate({ surface: "merchant", nav: "cases", caseId });
    },
    [navigate],
  );

  const record = useCallback((result: Case, meta: Parameters<typeof appendSessionCase>[2]) => {
    setHistory((h) => appendSessionCase(h, result, meta));
  }, []);

  const run = useCallback(
    async (request: DemoScenario["request"], title?: string, demoId?: string) => {
      setLoading(true);
      setError(null);
      setActiveDemoId(demoId);
      try {
        const result = await submitCase(request);
        record(result, { scenarioTitle: title, scenarioId: demoId });
        openCase(result.id);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [openCase, record],
  );

  // Two real requests, one after the other; each side records its own result or error.
  const runShowdown = useCallback(
    async (risky: DemoScenario) => {
      const safeScenario = DEMO_SCENARIOS.find((d) => d.id === "valid-duplicate")!;
      const runSide = async (scenario: DemoScenario): Promise<ShowdownSide> => {
        try {
          const result = await submitCase(scenario.request);
          record(result, { scenarioTitle: scenario.title, scenarioId: scenario.id });
          return { scenario, result };
        } catch (e) {
          return { scenario, error: errorText(e) };
        }
      };
      setShowdown({ status: "running", safe: { scenario: safeScenario }, risky: { scenario: risky } });
      const safe = await runSide(safeScenario);
      setShowdown({ status: "running", safe, risky: { scenario: risky } });
      const riskySide = await runSide(risky);
      setShowdown({ status: "done", safe, risky: riskySide });
    },
    [record],
  );

  // Demo-store customer request → real case on the backend → visible to the merchant.
  const submitFromStore = useCallback(
    async (request: CaseRequest, order: { orderId: string; supportRequest: { scenario: string } }) => {
      try {
        const result = await submitCase(request);
        record(result, { scenarioTitle: `Demo store · order #${order.orderId}`, scenarioId: order.supportRequest.scenario, source: "storefront" });
        return result;
      } catch (e) {
        throw new Error(errorText(e));
      }
    },
    [record],
  );

  // Orders / Inbox: send an order's fixed customer request from the console (a real POST /cases).
  const runOrder = useCallback(
    async (o: DemoStoreOrder) => {
      try {
        const result = await submitCase(refundRequestFor(o));
        record(result, { scenarioTitle: `Order #${o.orderId}`, scenarioId: o.supportRequest.scenario });
        return result;
      } catch (e) {
        throw new Error(errorText(e));
      }
    },
    [record],
  );

  const pendingReview = useMemo(() => history.filter((h) => h.state === "ESCALATED" || h.state === "FAILED").length, [history]);

  if (route.surface === "setup") {
    return (
      <OnboardingPage
        onComplete={(r) => {
          saveSetup(r.modules);
          setModules(r.modules);
          setStoreSnapshot(r.store);
          navigate({ surface: "merchant", nav: "dashboard" });
        }}
      />
    );
  }

  if (route.surface === "store") {
    return (
      <StorefrontPage
        snapshot={storeSnapshot}
        onSubmit={submitFromStore}
        onOpenCase={(c) => {
          setReturnTo({ surface: "merchant", nav: "inbox" });
          navigate({ surface: "merchant", nav: "cases", caseId: c.id });
        }}
        onExit={() => navigate(returnTo.surface === "merchant" ? returnTo : DEFAULT_ROUTE)}
      />
    );
  }

  const go = (nav: NavId, extra: Omit<MerchantRoute, "surface" | "nav"> = {}) =>
    navigate({ surface: "merchant", nav, ...extra });
  const onOpenCase = (entry: SessionCaseEntry) => openCase(entry.id);
  const openStore = () => {
    setReturnTo(route);
    navigate({ surface: "store" });
  };
  const openedCase = route.caseId ? history.find((h) => h.id === route.caseId) : undefined;
  const back: MerchantRoute = returnTo.surface === "merchant" && !returnTo.caseId ? returnTo : DEFAULT_ROUTE;

  return (
    <OpsShell
      activeNav={route.nav}
      onNavigate={(id) => go(id)}
      badges={{ approvals: pendingReview }}
      store={storeSnapshot}
      history={history}
      pendingReview={pendingReview}
      onSearchSelect={(r) => navigate(r)}
      actions={
        <>
          <button type="button" onClick={openStore} className={btn.secondary}>
            Open demo store
          </button>
          <button type="button" onClick={() => navigate({ surface: "setup" })} className={btn.ghost}>
            Setup
          </button>
        </>
      }
    >
      {route.caseId ? (
        openedCase ? (
          <InvestigationView
            caseData={openedCase.caseData}
            scenarioTitle={openedCase.scenarioTitle}
            backLabel={navLabel(back.nav)}
            onBack={() => navigate(back)}
          />
        ) : (
          <EmptyState
            title="Case not found in this browser"
            body={`Case ${route.caseId} is not among the cases recorded here. Cases are stored per browser; open it from where it was created.`}
            action={
              <button type="button" className={btn.primary} onClick={() => go("cases")}>
                View recorded cases
              </button>
            }
          />
        )
      ) : (
        <>
          {route.nav === "dashboard" && (
            <DashboardPage
              history={history}
              snapshot={storeSnapshot}
              load={storeLoad}
              onReload={loadStore}
              onNavigate={go}
              onRunOrder={runOrder}
              onOpenCase={openCase}
            />
          )}
          {route.nav === "team" && (
            <Suspense fallback={<LoadingRows label="Opening AI Team…" />}>
              <TeamPage onRecord={(result, s) => record(result, { scenarioTitle: s.title, scenarioId: s.id })} onOpenCase={openCase} />
            </Suspense>
          )}
          {route.nav === "judge" && (
            <Suspense fallback={<LoadingRows label="Opening Judge Mode…" />}>
              <JudgePage onRecord={(result, s) => record(result, { scenarioTitle: s.title, scenarioId: s.id })} onOpenCase={openCase} />
            </Suspense>
          )}
          {route.nav === "command-center" && (
            <Suspense fallback={<LoadingRows label="Opening Command Center…" />}>
              <CommandCenterPage history={history} snapshot={storeSnapshot} load={storeLoad}
                selectedId={route.params?.case} onSelect={id => go("command-center", { params: { case: id } })}
                onRunOrder={runOrder} onOpenCase={openCase} onReview={() => go("approvals")} onReload={loadStore} />
            </Suspense>
          )}
          {route.nav === "assistant" && <AssistantPanel snapshot={storeSnapshot} history={history} onNavigate={go} onRunOrder={runOrder} onOpenCase={openCase} />}
          {route.nav === "operations" && (
            <CommandCenter
              history={history}
              loading={loading}
              activeDemoId={activeDemoId}
              error={error}
              onRunDemo={(s) => run(s.request, s.title, s.id)}
              onOpenCase={onOpenCase}
              showdown={showdown}
              onRunShowdown={runShowdown}
              onOpenShowdownSide={(side) => openCase(side.result.id)}
            />
          )}
          {route.nav === "cases" && (
            <CasesPage
              history={history}
              loading={loading}
              activeDemoId={activeDemoId}
              onRunDemo={(s) => run(s.request, s.title, s.id)}
              onOpenCase={onOpenCase}
            />
          )}
          {route.nav === "activity" && <ActivityPage history={history} onOpenCase={onOpenCase} />}
          {route.nav === "benchmarks" && (
            <Suspense fallback={<LoadingRows label="Loading analytics" rows={6} />}>
            <BenchmarksPage
              history={history}
              snapshot={storeSnapshot}
              onOpenCase={onOpenCase}
              onOpenStore={openStore}
              onOpenOrders={(status) => go("orders", { params: { status } })}
            />
            </Suspense>
          )}
          {route.nav === "orders" && (
            <OrdersPage
              key={`${route.params?.status ?? ""}|${route.params?.q ?? ""}`}
              snapshot={storeSnapshot}
              load={storeLoad}
              onReload={loadStore}
              history={history}
              onOpenCase={onOpenCase}
              onRunOrder={async (o) => { await runOrder(o); }}
              selectedId={route.orderId ?? null}
              onSelect={(id) => go("orders", { ...(id ? { orderId: id } : {}), ...(route.params ? { params: route.params } : {}) })}
              initialStatus={route.params?.status}
              initialQuery={route.params?.q}
            />
          )}
          {route.nav === "customers" && (
            <CustomersPage snapshot={storeSnapshot} load={storeLoad} onReload={loadStore} history={history} onViewOrders={(q) => go("orders", { params: { q } })} />
          )}
          {route.nav === "inbox" && (
            <InboxPage history={history} snapshot={storeSnapshot} onOpenCase={onOpenCase} onOpenStore={openStore} onRerun={async (o) => { await runOrder(o); }} />
          )}
          {route.nav === "automations" && (
            <AutomationsPage enabled={modules} history={history} onOpenStore={openStore} onOpenProof={() => go("operations")} onOpenCases={() => go("cases")} />
          )}
          {route.nav === "approvals" && <ApprovalsPage history={history} onOpenCase={onOpenCase} />}
          {route.nav === "system" && <SystemPage />}
          {route.nav === "settings" && (
            <SettingsPage
              modules={modules}
              recordedCount={history.length}
              onChangeSetup={() => navigate({ surface: "setup" })}
              onClearCases={() => {
                clearRecordedCases();
                setHistory([]);
              }}
            />
          )}
        </>
      )}
    </OpsShell>
  );
}
