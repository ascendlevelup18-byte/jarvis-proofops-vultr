// Run registry on VM-local SQLite (node:sqlite, built into Node 24). WAL mode, small bounded rows.
// Evidence files live on disk; the database only indexes runs. On startup, any run left "running" by a crash
// is marked failed, so a restart can never leave a run looking alive or successful.
import { DatabaseSync } from "node:sqlite";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface RunRow {
  id: string;
  idempotency_key: string | null;
  mode: string;
  tier: string;
  status: RunStatus;
  verdict: string | null;
  error: string | null;
  evidence_dir: string | null;
  manifest_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export class RunStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY CHECK (length(id) <= 64),
        idempotency_key TEXT UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 128),
        mode TEXT NOT NULL CHECK (length(mode) <= 32),
        tier TEXT NOT NULL CHECK (length(tier) <= 32),
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','timed_out','cancelled')),
        verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','FAIL','INCONCLUSIVE')),
        error TEXT CHECK (error IS NULL OR length(error) <= 300),
        evidence_dir TEXT CHECK (evidence_dir IS NULL OR length(evidence_dir) <= 300),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC);
    `);
    // Additive migration: the evidence manifest anchor (SHA-256 checksum of manifest.json).
    const cols = (this.#db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("manifest_sha256")) {
      this.#db.exec("ALTER TABLE runs ADD COLUMN manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR length(manifest_sha256) = 64)");
    }
  }

  /** Marks runs interrupted by a crash or restart as failed. Returns how many were recovered. */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const r = this.#db
      .prepare(`UPDATE runs SET status = 'failed', error = 'control plane restarted during the run', updated_at = ? WHERE status IN ('queued','running')`)
      .run(now);
    return Number(r.changes);
  }

  /** Idempotent create: the same key returns the existing run instead of starting a second one. */
  create(row: { id: string; idempotencyKey: string | null; mode: string; tier: string }): { run: RunRow; created: boolean } {
    if (row.idempotencyKey) {
      const existing = this.#db.prepare(`SELECT * FROM runs WHERE idempotency_key = ?`).get(row.idempotencyKey) as RunRow | undefined;
      if (existing) return { run: existing, created: false };
    }
    const now = new Date().toISOString();
    this.#db
      .prepare(`INSERT INTO runs (id, idempotency_key, mode, tier, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
      .run(row.id, row.idempotencyKey, row.mode, row.tier, now, now);
    return { run: this.get(row.id)!, created: true };
  }

  get(id: string): RunRow | undefined {
    return this.#db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  list(limit = 50): RunRow[] {
    return this.#db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as unknown as RunRow[];
  }

  /** Only legal forward transitions; a finished run is never reopened. */
  update(id: string, patch: { status: RunStatus; verdict?: string | null; error?: string | null; evidenceDir?: string | null; manifestSha256?: string | null }): void {
    const terminal = ["completed", "failed", "timed_out", "cancelled"];
    const cur = this.get(id);
    if (!cur) throw new Error(`unknown run ${id}`);
    if (terminal.includes(cur.status)) throw new Error(`run ${id} is already ${cur.status}`);
    this.#db
      .prepare(`UPDATE runs SET status = ?, verdict = COALESCE(?, verdict), error = ?, evidence_dir = COALESCE(?, evidence_dir), manifest_sha256 = COALESCE(?, manifest_sha256), updated_at = ? WHERE id = ?`)
      .run(patch.status, patch.verdict ?? null, patch.error?.slice(0, 300) ?? null, patch.evidenceDir ?? null, patch.manifestSha256 ?? null, new Date().toISOString(), id);
  }

  close(): void {
    this.#db.close();
  }
}
