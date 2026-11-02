# ProofOps in the shared Supabase project: migration, RLS and recovery plan

Status: **draft for owner approval. Nothing has been written to any database.**
Project: `jarvis-actiii-cloud` (ref `bxjveqmdcnhvlzuotode`, ap-south-1, Postgres 17).

## 1. What the read-only inspection found (2 Nov 2026)
- **The project is paused.** The Supabase API reports `status: INACTIVE`, and SQL calls fail with "Database is possibly not accessible". Free-plan projects pause after about a week without traffic. Live inspection could not run.
- Unpausing changes the state of an ACT III resource, so I have not done it. The owner can unpause from the Supabase dashboard (Project → Restore).
- Until then, the existing database is described by the committed ACT III migrations, which created it (`reference/act3/supabase/migrations/`, three files, 17 Oct):
  - **Schemas used:** `public` (17 tables) and `private` (SECURITY DEFINER helpers). Extension `pgcrypto`.
  - **Tables whose names overlap ProofOps:** `public.audit_events`, `public.approvals` and `public.model_requests`. ProofOps uses the same names in its own schema, so every ProofOps query must be schema-qualified (`proofops.approvals`). The migration and the app do this.
  - **Default-privilege changes:** ACT III changed them only `in schema public`, so they do not leak into a new schema.
  - **Grants:** ACT III grants go to `authenticated` and `service_role`. ProofOps grants nothing to either, and explicitly revokes schema access from `anon`, `authenticated` and `service_role`.
- After unpausing, the read-only queries in `prep/proofops-db/inspect_readonly.sql` confirm the live state matches the migrations before anything is applied: schemas, roles, grants, policies, triggers, no existing `proofops` schema, connection limit and database size.

## 2. Design
- **New schema `proofops`.** It holds ten tables:
  - `workspaces` (added: memberships need something to belong to)
  - `workspace_memberships`, `tasks`, `sandbox_runs`
  - `execution_events`, `evidence`, `approvals`, `audit_events` (these four are append-only)
  - `model_requests`, `usage_quotas`
- **Two new roles, no login at creation:**
  - `proofops_owner` owns every object and never logs in.
  - `proofops_app` is the Vultr backend's only database identity. Neither role has superuser or BYPASSRLS.
- **The browser never talks to Supabase.** The ProofOps web app calls the ProofOps API on the Vultr VM, and only that API holds the `proofops_app` connection string.
  - So `proofops` is **not** added to the Supabase Data API exposed schemas.
  - Auth settings, JWT settings and global API exposure stay unchanged.
  - No Supabase key of any kind reaches the browser or the sandbox.
- **Identity is ProofOps-only.**
  - `workspace_memberships.actor_id` is not linked to `auth.users` and not derived from ACT III organizations or roles.
  - Being an ACT III member grants nothing in ProofOps.
- **How RLS works here.** The API authenticates the operator itself, then sets `proofops.actor_id` per transaction. Policies allow only rows in workspaces where that actor is a member with the right role (viewer, operator, approver, owner).
  - This stops cross-workspace reads and writes caused by query bugs.
  - It does not stop a fully compromised API, which could set any actor. That is inherent to one backend identity, and it is stated here rather than overclaimed.
- **No delete grants anywhere.** Append-only tables also refuse UPDATE and DELETE by trigger, even for the owner. `audit_events` carries a hash chain (`prev_hash`, `hash`) computed by the API.
- **Evidence bytes** (screenshots, DOM, HAR) stay on the Vultr side. The database stores only the SHA-256 and a storage reference.

## 3. Proof that the migration touches only ProofOps
- **The file is** `prep/proofops-db/0001_proofops_schema.sql`, run as a single transaction.
- **Every statement is one of:**
  - creating the two ProofOps roles
  - granting `proofops_owner` to `postgres`
  - creating the schema
  - creating, granting, revoking or setting policy on an object qualified `proofops.`
- **No statement names `public`, `private`, `auth`, `storage` or an ACT III object.**
- **Mechanical check before applying:** a grep of the file for `public\.|private\.|auth\.|storage\.|drop |truncate|alter (table|function) (public|private)` must return nothing except the `revoke ... from public` pseudo-role lines.
- **Security tests** (`prep/proofops-db/security_test.sql`) run inside a transaction that always rolls back:
  - **T1:** ACT III's `anon`, `authenticated` and `service_role` have no access to `proofops`.
  - **T2:** `proofops_app` has no grants outside `proofops`.
  - **T3:** no ProofOps role is superuser or BYPASSRLS.
  - **T4:** RLS is on for every ProofOps table.
  - **T5:** no ACT III policy mentions a ProofOps role.
  - **T6:** cross-workspace reads are blocked.
  - **T7:** a viewer cannot create tasks.
  - **T8 and T9:** `public` tables and `auth.users` are unreachable from `proofops_app`.
  - **T10:** events cannot be changed.
  - **T11:** nothing can be deleted.
- **ACT III regression:** rerun ACT III's own `reference/act3/supabase/tests/security_test.sql` after applying. It must still pass 46/46.

## 4. Order of operations (each step needs the owner's go-ahead)
1. **Owner unpauses** the project in the dashboard.
2. **Read-only inspection** (`inspect_readonly.sql`). Stop if anything differs from section 1.
3. **Owner approves** this plan in writing.
4. **Apply `0001_proofops_schema.sql`** as one transaction.
5. **Run `security_test.sql`** (always rolled back), then ACT III's security test. Stop and roll back if anything fails.
6. **Owner enables the login** in the Supabase SQL editor, typing the password there so it never passes through chat, git or a script: `alter role proofops_app login password '<generated>' connection limit 10;`. The connection string then goes into the Vultr VM's environment only.
7. **Seed one workspace and its members** with the migration user.

## 5. Recovery and rollback
- **Undo:** `0001_proofops_schema.down.sql` drops schema `proofops` (cascade is confined to that schema) and the two roles. ACT III is untouched.
- **Before rollback:** if ProofOps data matters, export it with `pg_dump --schema=proofops --data-only`.
- **Never use project-level restores** (PITR or daily backup restore) to undo ProofOps. They roll back ACT III as well.

## 6. Residual risks of sharing the project
| Risk | Effect | Mitigation |
|---|---|---|
| **Auto-pause** | The project pauses after inactivity (it is paused now). The ProofOps demo would break during judging. | ProofOps traffic keeps it active. During judging, check the status daily and keep a local fallback store in the API. If this is unacceptable, use a separate project. |
| Shared admin | The `postgres` user and the ACT III service key are project-wide. `postgres` can read ProofOps. | `service_role` gets no schema access. The ProofOps API never holds either credential. |
| Shared Auth/JWT | Same JWT secret and auth users. | ProofOps does not use Supabase Auth or the Data API at all. |
| Quotas, disk, connections | Free plan: 500 MB database, shared connection pool. | Evidence bytes stay off the database. Connection limit 10 on `proofops_app`. |
| Backups | Project backups cover both apps together. | Per-schema `pg_dump` for ProofOps. Never restore the project to undo ProofOps. |
| Billing and plan changes | One plan for both. | No paid add-ons without owner approval. |
| Pooler role naming | The pooler login is `proofops_app.bxjveqmdcnhvlzuotode`. | Documented in `.env.example` when login is enabled. |

**Verdict:** the privilege isolation can be done safely without weakening ACT III. No ACT III policy, grant, function or setting changes. The one material weakness is availability (auto-pause), not security.
