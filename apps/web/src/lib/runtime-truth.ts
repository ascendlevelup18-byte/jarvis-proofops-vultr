// Status labels driven by the backend's own /api/health answer.
// Rules: a responding model endpoint is NOT proof of AMD hardware, so AMD hardware is
// never shown as verified from health alone; Evolus has no integration in this build.

export interface HealthPayload {
  ok?: boolean;
  deployment?: string;
  aiMode?: string;
  model?: string | null;
  remoteModel?: boolean;
  paymentGateway?: string;
  data?: string;
  freeText?: string;
  note?: string;
}

export type TruthTone = "ok" | "info" | "warn" | "unknown";

export interface TruthItem {
  label: string;
  value: string;
  tone: TruthTone;
  detail: string;
}

export interface RuntimeTruth {
  ai: TruthItem;
  amdHardware: TruthItem;
  evolus: TruthItem;
  gateway: TruthItem;
  deployment: TruthItem;
}

export function deriveRuntimeTruth(health: HealthPayload | null): RuntimeTruth {
  let ai: TruthItem;
  if (!health) {
    ai = { label: "AI", value: "UNKNOWN", tone: "unknown", detail: "Health endpoint unavailable — mode not confirmed by the backend" };
  } else if (health.aiMode === "fixture") {
    ai = { label: "AI", value: "FIXTURE AI", tone: "info", detail: "Deterministic fixture adapters; no remote model is called" };
  } else if (health.aiMode === "vllm") {
    ai = {
      label: "AI",
      value: health.model ? `MODEL · ${health.model}` : "OPENAI-COMPATIBLE MODEL",
      tone: "ok",
      detail: "Backend passed its startup checks against an OpenAI-compatible endpoint",
    };
  } else {
    ai = { label: "AI", value: "UNKNOWN", tone: "unknown", detail: `Unrecognised aiMode ${JSON.stringify(health.aiMode)}` };
  }

  return {
    ai,
    amdHardware: {
      label: "AMD hardware",
      value: "NOT VERIFIED",
      tone: "warn",
      detail:
        health?.aiMode === "vllm"
          ? "A responding endpoint does not prove it runs on AMD GPUs — see docs/AMD_EVIDENCE.md"
          : "No real-model endpoint in use",
    },
    evolus: { label: "Evolus", value: "NOT CONNECTED", tone: "warn", detail: "No Evolus integration in this build" },
    gateway: {
      label: "Payments",
      value: "SIMULATED",
      tone: "warn",
      detail:
        health?.paymentGateway === "simulated"
          ? "Backend reports a simulated gateway — no real money moves"
          : "Only a simulated gateway exists in this build — no real money moves",
    },
    deployment: {
      label: "Deployment",
      value: health?.deployment ? health.deployment.toUpperCase() : "UNKNOWN",
      tone: health?.deployment ? "info" : "unknown",
      detail: health?.ok === false ? (health.note ?? "Backend reports a degraded state") : "From /api/health",
    },
  };
}
