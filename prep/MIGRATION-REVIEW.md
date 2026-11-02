# Review of `prep/proofops-db/0001_proofops_schema.sql`, revision 2

Status: **PENDING owner approval. Never run against the shared Supabase project.** Revision 2 (2 Nov 2026) fixes A1 to A4 from revision 1. It also fixes two more issues that testing found (B1, B2). It was tested on a disposable local Postgres 17.11, the same version as the Supabase project.

## Test result (disposable local database)
Runner: `prep/proofops-db/local-test/run-local.mjs`. Full log: `prep/proofops-db/local-test/RESULT-20261102.txt`.

The runner builds a Supabase-like role layout:
- `postgres` is a non-superuser with CREATEROLE and BYPASSRLS
- `anon`, `authenticated` and `service_role` roles
- a stub `auth` schema
- `pgcrypto` in an `extensions` schema

| Step | Result |
|---|---|
| ACT III's 3 migrations | Applied |
| ACT III database security tests, before ProofOps | **46/46** |
| ProofOps migration | Applied in one transaction |
| ACT III fingerprint (every policy, grant, function body and ACL, membership, role attribute, default privilege, database setting and RLS flag outside proofops) | **Identical** before and after |
| ProofOps tests (`security_test.sql`) | **55/55** |
| ACT III security tests, after ProofOps | **46/46** |
| Rollback (`.down.sql`) | 0 proofops schemas and 0 ProofOps roles left; ACT III fingerprint identical to the original |
| Re-apply after rollback, then retest | Applied; 55/55 |

## Fixes
| Finding | Fix | Tests |
|---|---|---|
| **A1. `postgres` kept a membership in `proofops_owner`** | The membership is now granted with `set true, inherit false` only for the length of the migration transaction, then revoked. Afterwards `postgres` holds only the ADMIN OPTION that Postgres 16+ gives automatically to a non-superuser who creates a role. | A1a: no INHERIT or SET membership remains. A1b: `postgres` cannot read ProofOps tables without an explicit admin session. |
| **A2. A viewer could reset quotas** | The UPDATE grant on `usage_quotas` is removed. Usage changes only through `proofops.consume_quota(ws, resource, n)`, which requires owner or operator and n from 1 to 100000. It locks the row, resets usage only on a new day, refuses beyond `daily_max`, and refuses when no quota row exists. | A2a–A2h |
| **A3. A task could be marked completed without verification** | The UPDATE grant on `tasks` is removed. Status changes only through `proofops.transition_task`, which checks the actor's role for the target status and writes an execution event and an audit event. A trigger enforces the rules for every role, the owner included (listed below this table). Approvals are accepted only while the task awaits approval; evidence only while it is running or verifying. | A3a–A3m, W1–W3 |
| **A4. Sandbox limits could be edited** | The backend can update only `started_at`, `ended_at`, `exit_reason` and `destroyed` (column grants). A trigger keeps task, workspace, image and limits fixed for every role, the owner included (listed below this table). Limits must sit within caps checked by the database. | A4a–A4h |
| **B1 (found in testing). PUBLIC could execute every ProofOps function** | Postgres grants EXECUTE on functions to PUBLIC by default, and a per-schema default-privilege rule cannot remove that, so revision 1's revoke did nothing. Calls were still blocked because PUBLIC has no access to the schema, but the grant existed. Now it is revoked by a default rule scoped to objects `proofops_owner` creates, plus an explicit `revoke execute on all functions`. | I6 |
| **B2 (found in testing). Cross-workspace references** | Revision 1 let a row in workspace A reference a task in workspace B. Every child table now uses a composite foreign key `(task_id, workspace_id)`. | I10 |

**Task rules the trigger enforces (A3):**
- A task must start as `planned`.
- Its goal, plan and policy version can never change.
- Status follows only these moves:
  - `planned` → `awaiting_approval` or `cancelled`
  - `awaiting_approval` → `approved`, `blocked` or `cancelled`
  - `approved` → `running` or `cancelled`
  - `running` → `verifying`, `blocked` or `failed`
  - `verifying` → `completed`, `failed` or `blocked`
- `approved` needs the latest approval decision to be approve.
- `running` needs a started run.
- `completed` needs passing verification evidence, and every run for the task ended and destroyed.

**Sandbox run rules the trigger enforces (A4):**
- Task, workspace, image and limits never change.
- A run can only be created for an approved or running task, and must start unstarted.
- `started_at` and `ended_at` are each set once, in order.
- `destroyed` can never go back to false.
- Limits must sit within these caps:
  - timeout 1 s to 300 s
  - memory 64 to 4096 MB
  - at most 4 CPUs
  - 16 to 1024 processes
  - a network allowlist must be present

Also changed from revision 1:
- **The audit hash chain is computed by the database** (tests I17a, I17b), and every task status change writes to it.
- **No table, tasks and sandbox runs included, can be deleted,** even by the owner.

## Every SQL operation (revision 2)
1. **Create roles.** `create role proofops_owner` and `create role proofops_app`, both with nologin, noinherit and nobypassrls. These are **cluster-wide.**
2. **Temporary membership.** `grant proofops_owner to postgres with inherit false, set true`. It is revoked at step 14.
3. **Schema.** `create schema proofops authorization proofops_owner`, then `set local role proofops_owner`.
4. **Lock down defaults.**
   - `revoke all on schema proofops from public`.
   - `alter default privileges for role proofops_owner revoke execute on functions from public`, and the same for `usage on types`. These are role-level rules, so they affect only objects created by `proofops_owner`.
5. **Types.** 2 enum types, `workspace_role` and `task_status`.
6. **Tables.** 10 tables with check constraints and composite foreign keys, plus 7 indexes.
7. **Membership functions.** `has_role` and `is_member` (SECURITY DEFINER).
8. **Trigger functions.** `forbid_change`, `tasks_guard`, `sandbox_runs_guard` and `task_phase_guard` (invoker), plus `audit_chain` (SECURITY DEFINER).
9. **Triggers.** 11 in total:
   - append-only on 4 tables
   - no-delete on tasks and on sandbox_runs
   - the tasks guard
   - the runs guard
   - 2 phase guards
   - the audit chain
10. **Write-path functions.** `transition_task` and `consume_quota` (SECURITY DEFINER).
11. **RLS.** Enabled on all 10 tables, with 18 policies, all `to proofops_app`.
12. **Grants to `proofops_app` only:**
    - schema usage, and usage on the 2 types
    - execute on 5 functions
    - select on all proofops tables
    - insert on 7 tables
    - column-level update on `sandbox_runs`
    - an explicit `revoke execute on all functions … from public`
13. **Explicit revoke.** `revoke all on schema proofops from anon, authenticated, service_role`, a no-op by design. Then `reset role`.
14. **Remove the temporary membership.** `revoke proofops_owner from postgres`.

## Answers to the review questions
- **Cluster-wide roles:** yes, the two roles exist cluster-wide and appear in `pg_roles`. They have no login, no superuser, no CREATEROLE, no CREATEDB, no REPLICATION and no BYPASSRLS (test I3). Login is enabled later by the owner, separately.
- **Search path:** every function sets `search_path = ''` and names every object with its schema (I6). `pg_catalog` functions are written with their schema inside the definer functions.
- **Schema permissions:** only `proofops_app` has USAGE, and nobody but the owner has CREATE (I1, I2).
- **Default privileges:** they only restrict `proofops_owner`'s own objects, and it owns nothing outside `proofops` apart from Postgres's automatic TOAST tables (I7).
- **Security-definer risk:**
  - The 5 definer functions run as `proofops_owner`. That role is not BYPASSRLS and has no grants outside `proofops`, so a bug in one of them cannot reach ACT III.
  - None is executable by PUBLIC. Only `proofops_app` can call them.
  - The two write-path functions check the actor's workspace role before acting.
- **Impact on existing ACT III roles:**
  - `anon`, `authenticated`, `service_role` and `authenticator` gain nothing (I1).
  - `postgres` ends with ADMIN OPTION only (A1a). The fingerprint shows no other role, membership or grant changed.
- **Shared settings:** none. There is no `ALTER SYSTEM`, `ALTER DATABASE`, change to existing roles, extension, event trigger, publication, or change to Auth, API or pooler settings. The fingerprint includes `pg_db_role_setting`.
- **RLS:**
  - RLS is enabled on all tables, so `proofops_app` is always subject to it.
  - It is **not forced**, because the definer functions run as the owner and must see every row to enforce the rules. The owner is constrained instead by the triggers above, which apply to every role.
  - With no actor set, the backend sees no rows (I12).

## Remaining risks
1. **A compromised backend can pick any actor.**
   - It could create a task as an operator actor and approve it as an approver actor.
   - The database enforces the order and the evidence, but separation of duties is only as strong as the backend's operator authentication.
   - **Recommendation for kickoff:** a separate `proofops_verifier` role. Only that role could insert `verification` evidence, from the independent verifier process, so the agent backend cannot certify its own work.
2. **The verification verdict is asserted, not re-checked.** The database checks that passing evidence exists and is hash-addressed, not that the verifier was honest. Evidence bytes live on the Vultr side.
3. **`postgres` can always grant itself access** through its ADMIN OPTION, and the platform superuser sees everything. This comes with sharing a project: anyone holding the project's `postgres` password can read ProofOps, and the reverse holds too.
4. **The local simulation is not Supabase.** These still need checking on the real project:
   - Supabase's `supautils` restrictions on role statements
   - its event triggers
   - the `createrole_self_grant` setting
   - whether `postgres` there behaves exactly like the simulated non-superuser

   `inspect_readonly.sql` covers the event triggers and settings after unpausing. A faithful dry run would need a separate free Supabase project (owner approval required) or Supabase branching (paid).
5. **Auto-pause** can take the demo down during judging. The project is paused now.
6. **Rollback limits:**
   - It destroys ProofOps data, so dump it first.
   - It fails while `proofops_app` has open connections.
   - Project-level backups and PITR cover both apps, so they are never a ProofOps undo.
7. **The quota day is the database's `current_date`** (UTC on Supabase).

## Not yet received
Gemini's independent security findings. I'll reconcile them against this revision when they arrive.
