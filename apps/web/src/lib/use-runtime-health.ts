import { useEffect, useState } from "react";
import type { HealthPayload } from "./runtime-truth.ts";

// One /api/health request per page load, shared by every component that asks.
let pending: Promise<HealthPayload | null> | null = null;

export function loadHealth(): Promise<HealthPayload | null> {
  pending ??= fetch("/api/health")
    .then((res) => (res.ok ? (res.json() as Promise<HealthPayload>) : null))
    .catch(() => null);
  return pending;
}

/** undefined while loading, null if the backend did not answer. */
export function useRuntimeHealth(): HealthPayload | null | undefined {
  const [health, setHealth] = useState<HealthPayload | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return health;
}
