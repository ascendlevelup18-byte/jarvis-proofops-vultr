-- ProofOps schema in the shared Supabase project jarvis-actiii-cloud (bxjveqmdcnhvlzuotode).
-- NOT APPLIED. Requires the owner's written approval of prep/SHARED-DATABASE-PLAN.md first.
--
-- Scope rule: every statement below creates or grants on objects inside schema `proofops`, or creates the two
-- ProofOps roles. Nothing touches public, private, auth, storage, ACT III functions, policies, grants or settings.
-- Run as one transaction. If any statement fails, nothing is kept.

begin;

-- Roles. Both are created without login. The owner later enables login for proofops_app in the Supabase SQL
-- editor (see the plan) so no password ever passes through chat, git or a script.
create role proofops_owner nologin noinherit nobypassrls;   -- owns every ProofOps object; never logs in
create role proofops_app   nologin noinherit nobypassrls;   -- the Vultr backend's only database identity
grant proofops_owner to postgres;                            -- lets the migration user create objects as owner

create schema proofops authorization proofops_owner;
set local role proofops_owner;

-- Nobody gets anything by default, including ACT III's roles.
revoke all on schema proofops from public;
alter default privileges for role proofops_owner in schema proofops revoke all on tables    from public;
alter default privileges for role proofops_owner in schema proofops revoke all on functions from public;
alter default privileges for role proofops_owner in schema proofops revoke all on sequences from public;

-- Actor context. The backend authenticates the operator itself, then runs
--   set local proofops.actor_id = '<uuid>'
-- inside each transaction. RLS below scopes every row to workspaces that actor belongs to. This limits the
-- damage of a backend query bug (no cross-workspace reads or writes); it does not defend against a fully
-- compromised backend, which could set any actor id.
create function proofops.actor() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('proofops.actor_id', true), '')::uuid
$$;

create type proofops.workspace_role as enum ('owner', 'approver', 'operator', 'viewer');

create table proofops.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  created_at  timestamptz not null default now()
);

-- ProofOps identities are ProofOps-only. actor_id is NOT a foreign key to auth.users and NOT derived from
-- ACT III memberships, so belonging to an ACT III organization grants nothing here.
create table proofops.workspace_memberships (
  workspace_id uuid not null references proofops.workspaces(id) on delete restrict,
  actor_id     uuid not null,
  role         proofops.workspace_role not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, actor_id)
);

create function proofops.has_role(ws uuid, roles proofops.workspace_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from proofops.workspace_memberships m
                 where m.workspace_id = ws and m.actor_id = proofops.actor() and m.role = any(roles))
$$;
create function proofops.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select proofops.has_role(ws, array['owner','approver','operator','viewer']::proofops.workspace_role[])
$$;

create type proofops.task_status as enum
  ('planned', 'awaiting_approval', 'approved', 'running', 'verifying', 'completed', 'blocked', 'failed', 'cancelled');

create table proofops.tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references proofops.workspaces(id) on delete restrict,
  created_by     uuid not null,
  goal           text not null check (length(goal) between 1 and 2000),
  plan           jsonb,
  policy_version text not null,
  status         proofops.task_status not null default 'planned',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table proofops.sandbox_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid not null references proofops.tasks(id) on delete restrict,
  image_digest  text not null,
  limits        jsonb not null,            -- cpu, memory, pids, timeout, network allowlist actually applied
  started_at    timestamptz,
  ended_at      timestamptz,
  exit_reason   text,
  destroyed     boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Append-only tables
create table proofops.execution_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid not null references proofops.tasks(id) on delete restrict,
  run_id        uuid references proofops.sandbox_runs(id) on delete restrict,
  kind          text not null,             -- step_started, action_blocked, injection_detected, ...
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);

create table proofops.evidence (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid not null references proofops.tasks(id) on delete restrict,
  run_id        uuid references proofops.sandbox_runs(id) on delete restrict,
  kind          text not null check (kind in ('screenshot', 'dom_snapshot', 'har', 'verification', 'log')),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_ref   text not null,             -- object path on the Vultr side; bytes are not stored here
  verdict       jsonb,
  created_at    timestamptz not null default now()
);

create table proofops.approvals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid not null references proofops.tasks(id) on delete restrict,
  decided_by    uuid not null,
  decision      text not null check (decision in ('approve', 'reject')),
  reason        text,
  created_at    timestamptz not null default now()
);

create table proofops.audit_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid references proofops.workspaces(id) on delete restrict,
  actor_id      uuid,
  action        text not null,
  target        text,
  detail        jsonb not null default '{}'::jsonb,
  prev_hash     text,
  hash          text not null,
  at            timestamptz not null default now()
);

create table proofops.model_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid references proofops.tasks(id) on delete restrict,
  provider      text not null default 'vultr',
  model         text not null,
  purpose       text not null,
  input_tokens  integer,
  output_tokens integer,
  latency_ms    integer,
  outcome       text not null,             -- ok, error, rejected_by_schema, ...
  created_at    timestamptz not null default now()
);

create table proofops.usage_quotas (
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  resource      text not null check (resource in ('inference_requests', 'sandbox_runs', 'sandbox_seconds')),
  daily_max     integer not null check (daily_max >= 0),
  used_today    integer not null default 0 check (used_today >= 0),
  day           date not null default current_date,
  primary key (workspace_id, resource)
);

create function proofops.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'proofops.% is append-only', tg_table_name; end $$;

create trigger execution_events_append_only before update or delete on proofops.execution_events
  for each row execute function proofops.forbid_change();
create trigger evidence_append_only before update or delete on proofops.evidence
  for each row execute function proofops.forbid_change();
create trigger approvals_append_only before update or delete on proofops.approvals
  for each row execute function proofops.forbid_change();
create trigger audit_events_append_only before update or delete on proofops.audit_events
  for each row execute function proofops.forbid_change();

create index on proofops.tasks (workspace_id, created_at desc);
create index on proofops.sandbox_runs (task_id);
create index on proofops.execution_events (task_id, at);
create index on proofops.evidence (task_id);
create index on proofops.approvals (task_id);
create index on proofops.audit_events (workspace_id, at);
create index on proofops.model_requests (workspace_id, created_at desc);

-- Row level security on every table, forced on all but workspace_memberships. That one is only enabled so
-- the SECURITY DEFINER membership helpers (owned by proofops_owner) can read it; proofops_app is not the
-- owner, so RLS still applies to it there.
alter table proofops.workspace_memberships enable row level security;
do $$ declare t text; begin
  foreach t in array array['workspaces','tasks','sandbox_runs','execution_events',
                           'evidence','approvals','audit_events','model_requests','usage_quotas'] loop
    execute format('alter table proofops.%I enable row level security', t);
    execute format('alter table proofops.%I force row level security', t);
  end loop;
end $$;

create policy ws_select on proofops.workspaces for select to proofops_app using (proofops.is_member(id));
create policy mem_select on proofops.workspace_memberships for select to proofops_app using (proofops.is_member(workspace_id));

create policy task_select on proofops.tasks for select to proofops_app using (proofops.is_member(workspace_id));
create policy task_insert on proofops.tasks for insert to proofops_app with check (
  created_by = proofops.actor() and proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));
create policy task_update on proofops.tasks for update to proofops_app
  using (proofops.has_role(workspace_id, array['owner','operator','approver']::proofops.workspace_role[]))
  with check (proofops.has_role(workspace_id, array['owner','operator','approver']::proofops.workspace_role[]));

create policy run_select on proofops.sandbox_runs for select to proofops_app using (proofops.is_member(workspace_id));
create policy run_insert on proofops.sandbox_runs for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));
create policy run_update on proofops.sandbox_runs for update to proofops_app
  using (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]))
  with check (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));

create policy ev_select on proofops.execution_events for select to proofops_app using (proofops.is_member(workspace_id));
create policy ev_insert on proofops.execution_events for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));

create policy evid_select on proofops.evidence for select to proofops_app using (proofops.is_member(workspace_id));
create policy evid_insert on proofops.evidence for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));

create policy appr_select on proofops.approvals for select to proofops_app using (proofops.is_member(workspace_id));
create policy appr_insert on proofops.approvals for insert to proofops_app with check (
  decided_by = proofops.actor() and proofops.has_role(workspace_id, array['owner','approver']::proofops.workspace_role[]));

create policy audit_select on proofops.audit_events for select to proofops_app using (proofops.is_member(workspace_id));
create policy audit_insert on proofops.audit_events for insert to proofops_app
  with check (actor_id = proofops.actor() and proofops.is_member(workspace_id));

create policy mreq_select on proofops.model_requests for select to proofops_app using (proofops.is_member(workspace_id));
create policy mreq_insert on proofops.model_requests for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner','operator']::proofops.workspace_role[]));

create policy quota_select on proofops.usage_quotas for select to proofops_app using (proofops.is_member(workspace_id));
create policy quota_update on proofops.usage_quotas for update to proofops_app
  using (proofops.is_member(workspace_id)) with check (proofops.is_member(workspace_id));

-- Grants: only proofops_app, only what the policies above need. No delete anywhere. Workspaces and
-- memberships are read-only to the backend; the owner manages them with the migration user.
grant usage on schema proofops to proofops_app;
grant execute on function proofops.actor(), proofops.is_member(uuid),
  proofops.has_role(uuid, proofops.workspace_role[]) to proofops_app;
grant select on proofops.workspaces, proofops.workspace_memberships to proofops_app;
grant select, insert, update on proofops.tasks, proofops.sandbox_runs to proofops_app;
grant select, insert on proofops.execution_events, proofops.evidence, proofops.approvals,
  proofops.audit_events, proofops.model_requests to proofops_app;
grant select, update on proofops.usage_quotas to proofops_app;

reset role;

-- Explicitly keep ACT III's API roles out. These are revokes on proofops objects only.
revoke all on schema proofops from anon, authenticated, service_role;

commit;
