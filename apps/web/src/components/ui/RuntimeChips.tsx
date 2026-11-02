import { deriveRuntimeTruth, type TruthTone } from '../../lib/runtime-truth.ts';
import { useRuntimeHealth } from '../../lib/use-runtime-health.ts';

const TONE:Record<TruthTone,string>={ok:'text-[var(--color-policy-accent)]',info:'text-[var(--color-ai-accent)]',warn:'text-[var(--color-warning)]',unknown:'text-[var(--color-jarvis-muted)]'};
export function RuntimeChips() {
 const health=useRuntimeHealth();const t=deriveRuntimeTruth(health??null);
 const api=health===undefined?'Connecting…':health===null?'Connection unavailable':health.ok===false?'Connection needs attention':'Connected';
 const ai=health?.aiMode==='fixture'?'Demo AI (fixture)':health?.aiMode==='vllm'?'Live AI model':'AI mode unconfirmed';
 return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]" aria-label="Runtime status">
  <span className={health?.ok===false?'text-[var(--color-warning)]':'text-[var(--color-jarvis-muted)]'}>{api}</span>
  <span title={t.ai.detail} className={TONE[t.ai.tone]}>{ai}</span>
  <span className="text-[var(--color-warning)]">Payments simulated</span>
  <details className="relative"><summary className="text-[var(--color-jarvis-muted)]">Connection details</summary><div className="absolute right-0 top-6 z-40 w-64 rounded-lg border border-[var(--color-jarvis-border)] bg-[var(--color-jarvis-surface)] p-3 text-xs shadow-raised"><p>{t.ai.value}</p><p className="mt-1">{t.ai.detail}</p><p className="mt-2">AMD hardware: {t.amdHardware.value}</p><p>Evolus: {t.evolus.value}</p><p className="mt-2">Synthetic store data. {t.gateway.detail}</p></div></details>
 </div>;
}
