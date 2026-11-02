# Review of `prep/proofops-db/0001_proofops_schema.sql`

Status: **PENDING owner approval. Not executed.** Reviewed 2 Nov 2026 against Postgres 17 semantics and the committed ACT III migrations. The live database could not be inspected because the project is paused.

## 1. Every SQL operation, in order
| # | Operation | Scope |
|---|---|---|
| 1 | `create role proofops_owner nologin noinherit nobypassrls` | **Cluster-wide** (see §2) |
| 2 | `create role proofops_app nologin noinherit nobypassrls` | **Cluster-wide** |
| 3 | `grant proofops_owner to postgres` | **Changes an existing role's memberships** (see §4) |
| 4 | `create schema proofops authorization proofops_owner` | New schema |
| 5 | `set local role proofops_owner` | This transaction only |
| 6 | `revoke all on schema proofops from public` | proofops only |
| 7–9 | `alter default privileges for role proofops_owner in schema proofops revoke all on tables/functions/sequences from public` | proofops only |
| 10 | `create function proofops.actor()` | proofops |
| 11 | `create type proofops.workspace_role`, `create type proofops.task_status` | proofops |
| 12 | `create table` × 10: workspaces, workspace_memberships, tasks, sandbox_runs, execution_events, evidence, approvals, audit_events, model_requests, usage_quotas | proofops |
| 13 | `create function proofops.has_role`, `proofops.is_member` (SECURITY DEFINER), `proofops.forbid_change` | proofops |
| 14 | 4 × `create trigger … append_only` on execution_events, evidence, approvals, audit_events | proofops |
| 15 | 7 × `create index` | proofops |
| 16 | `enable row level security` on all 10 tables; `force` on 9, not on workspace_memberships | proofops |
| 17 | 21 × `create policy … to proofops_app` | proofops |
| 18 | `grant usage`, `grant execute` on 3 functions, and table grants to proofops_app (select/insert/update; **no delete**) | proofops |
| 19 | `reset role` | — |
| 20 | `revoke all on schema proofops from anon, authenticated, service_role` | proofops (no-op by design, stated explicitly) |

Everything runs as one `begin … commit`. Any failure keeps nothing.

## 2. Cluster-wide objects
- **Roles are cluster-wide in Postgres.** The two roles exist for every database in the Supabase instance, not just this schema. They appear in `pg_roles`, which any role, ACT III's included, can read.
- **Neither role can log in after the migration.** Login is a later, separate step that the owner performs.
- **Nothing else is cluster-level.** There is no `ALTER SYSTEM`, no `ALTER DATABASE`, no `ALTER ROLE` on existing roles, no extension, no event trigger and no publication.

## 3. Search path and schema permissions
- Every function sets `search_path = ''` and fully qualifies names, which blocks search-path hijacking.
- The table defaults use `gen_random_uuid()` from pg_catalog. That is built in since Postgres 13 and does not need pgcrypto.
- `public` (the pseudo-role) loses all rights on the schema. Default privileges are revoked before any object is created, so no object ever has a public grant, including the functions.
- `proofops_app` gets `USAGE` on proofops only. It gets no `CREATE`, so it cannot add objects.
- The custom setting `proofops.actor_id` is set per transaction with `set local`. It is not a server setting and does not persist.

## 4. Impact on existing ACT III roles
- **`postgres` gains membership in `proofops_owner`** (operation 3).
  - Effect: the migration user can create objects as the owner, and later administer the schema.
  - `postgres` already administers the whole project, so this adds no new reach into ACT III. It does change the membership list of an existing role.
  - **Recommended amendment A1:** revoke the membership at the end of the migration, then re-grant it only for later admin work and for the rollback. Since Postgres 16, the creator keeps ADMIN OPTION on the role, so it can re-grant itself without a superuser.
- **`anon`, `authenticated` and `service_role`** never receive anything. Operation 20 only confirms that. Their ACT III grants and policies are not referenced.
- **`authenticator`, `supabase_admin` and the other platform roles** are not touched.

## 5. RLS and least-privilege guarantees
**What is guaranteed:**
- RLS applies to `proofops_app` on all 10 tables, because it is neither the owner nor BYPASSRLS.
- RLS is forced on 9 tables, so even the owner role is filtered there.
- The append-only triggers block UPDATE and DELETE on events, evidence, approvals and audit for everyone except someone who disables the trigger (owner or superuser).
- There is no DELETE grant on any table.
- Workspaces and memberships are read-only to the app.

**What is not guaranteed:**
- **A compromised backend is not stopped.** `proofops_app` chooses the actor id, so a compromised backend can act as any actor. RLS protects against query bugs, not against takeover of the backend.
- **The audit hash chain is not enforced by the database.** The API computes it, and the database only stores it.

**Weaknesses found in this review (amendments recommended before applying):**
- **A2. `usage_quotas` update is too broad.** Any member, including a viewer, could reset `used_today`. Fix: replace the update grant with a SECURITY DEFINER `proofops.consume_quota(ws, resource, n)` that can only increase usage.
- **A3. `tasks` update is too broad.** An operator or approver can update any column, including setting `status = 'completed'` directly and skipping verification. Fix: drop the update grant and move state changes into a SECURITY DEFINER `proofops.transition_task(task, to_status)` that enforces the allowed transitions and requires an `evidence` row with a passing verdict before `completed`.
- **A4. `sandbox_runs` update is too broad.** Restrict it with column-level `update (started_at, ended_at, exit_reason, destroyed)` grants.

## 6. Shared database settings
- **None are modified.** There is no change to `postgresql.conf`, `ALTER DATABASE … SET`, Auth, JWT, Data API exposed schemas, network restrictions, pooler settings or project plan.
- **Platform reaction to DDL:** Supabase's own DDL event triggers will fire, as they do for any DDL. These are the PostgREST schema-cache reload and the pg_graphql placeholder. Since `proofops` is not exposed and grants nothing to API roles, nothing becomes reachable.
- **To verify after unpausing:** `inspect_readonly.sql` lists every event trigger. Any trigger that automatically grants on new tables or schemas would need review before applying.

## 7. The 11 isolation tests (`security_test.sql`, always rolled back)
| # | Test |
|---|---|
| T1 | `anon`, `authenticated` and `service_role` have no `USAGE` on proofops |
| T2 | `proofops_app` has no table grants outside proofops and cannot use `private` |
| T3 | Neither ProofOps role is superuser or BYPASSRLS |
| T4 | RLS is enabled on every proofops table, and forced on all but workspace_memberships |
| T5 | No ACT III policy names a ProofOps role |
| T6 | An actor in workspace B sees zero tasks from workspace A |
| T7 | A viewer cannot create a task |
| T8 | `proofops_app` cannot read `public.organizations` |
| T9 | `proofops_app` cannot read `auth.users` |
| T10 | Execution events cannot be updated |
| T11 | Tasks cannot be deleted |

After applying, ACT III's own `security_test.sql` (46 checks) must still pass. Amendments A2 to A4 would add three tests: a viewer cannot reset a quota, a task cannot jump to completed, and a run's limits cannot be changed.

## 8. Rollback limitations
- **The down migration destroys all ProofOps data.** Export first with `pg_dump --schema=proofops`.
- **`drop role` fails while `proofops_app` has open connections.** Stop the Vultr API first.
- **`drop role` fails if either role was granted anything outside proofops later.** None should be. T2 and T5 check this.
- **Project backups and PITR snapshots taken after the migration contain proofops.** Restoring the project to an earlier point would also roll back ACT III, so it is never a ProofOps rollback method.
- **Free-plan backups:** the free plan may have no PITR, so the per-schema dump is the only selective backup.

## 9. Any chance of cross-application access
| Direction | Possible? | Why |
|---|---|---|
| ACT III browser (anon or authenticated JWT) → proofops | No | No schema usage; proofops not exposed in the Data API |
| ACT III gateway (`service_role` key) → proofops | No | `service_role` has no usage on proofops |
| ProofOps backend → ACT III tables or auth | No | No grants outside proofops (T2, T8, T9) |
| Project admin (`postgres`, dashboard, `supabase_admin`) → proofops | **Yes** | Inherent to sharing a project; the same people already administer ACT III |
| Leaked `postgres` password or a dashboard compromise | **Yes, both apps** | Shared blast radius; only a separate project removes it |
| ACT III org membership → ProofOps rights | No | ProofOps identities are separate; no foreign key to `auth.users` or `public.memberships` |

## Recommendation
Apply only after amendments A1 to A4 are folded into the draft, with Gemini's security review reconciled, and after the read-only inspection confirms the live state. If the shared admin blast radius or auto-pause is not acceptable, a separate Supabase project removes both, at the cost of one more project to manage.
