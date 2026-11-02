-- ProofOps schema for the shared Supabase project jarvis-actiii-cloud (bxjveqmdcnhvlzuotode).
-- NOT APPLIED. Needs the owner's written approval of prep/SHARED-DATABASE-PLAN.md and prep/MIGRATION-REVIEW.md.
-- Revision 2 (2 Nov 2026): fixes review findings A1-A4. Tested only on a disposable local Postgres 17.
--
-- Scope rule: every statement creates, grants on or revokes on objects inside schema `proofops`, creates the two
-- ProofOps roles, or grants and revokes a temporary membership of `postgres` in proofops_owner inside this
-- transaction. Nothing touches public, private, auth, storage, extensions, ACT III objects or any setting.
-- Run as `postgres` in one transaction. If any statement fails, nothing is kept.

begin;

-- Roles (cluster-wide by nature). Neither can log in. Neither is superuser, CREATEROLE or BYPASSRLS.
-- Creating them makes `postgres` their administrator (ADMIN OPTION only: no INHERIT, no SET). This is automatic
-- in Postgres 16+ for a non-superuser creator and is the only lasting link to `postgres`.
create role proofops_owner nologin noinherit nobypassrls;   -- owns all ProofOps objects and the definer functions
create role proofops_app   nologin noinherit nobypassrls;   -- the Vultr backend's only database identity

-- A1: temporary SET membership so `postgres` can create objects owned by proofops_owner. It is revoked at the
-- end of this transaction, so `postgres` keeps no INHERIT or SET membership afterwards.
grant proofops_owner to postgres with inherit false, set true;

create schema proofops authorization proofops_owner;
set local role proofops_owner;

-- Nothing in the schema is granted to anyone by default. Postgres grants EXECUTE on functions and USAGE on types
-- to PUBLIC by default, and a per-schema rule cannot remove that, so the revoke is set for objects created by
-- proofops_owner (which only ever creates objects in this schema). It does not affect any other role's objects.
revoke all on schema proofops from public;
alter default privileges for role proofops_owner revoke execute on functions from public;
alter default privileges for role proofops_owner revoke usage on types from public;

-- Actor context. The backend authenticates the operator, then runs `set local proofops.actor_id = '<uuid>'` in
-- each transaction. RLS limits proofops_app to rows in that actor's workspaces. This contains query bugs; it does
-- not stop a fully compromised backend, which chooses the actor id.
create function proofops.actor() returns uuid
language sql stable set search_path = '' as $$
  select nullif(pg_catalog.current_setting('proofops.actor_id', true), '')::uuid
$$;

create type proofops.workspace_role as enum ('owner', 'approver', 'operator', 'viewer');
create type proofops.task_status as enum
  ('planned', 'awaiting_approval', 'approved', 'running', 'verifying', 'completed', 'blocked', 'failed', 'cancelled');

create table proofops.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  created_at  timestamptz not null default now()
);

-- ProofOps identities are ProofOps-only: no link to auth.users or to ACT III memberships.
create table proofops.workspace_memberships (
  workspace_id uuid not null references proofops.workspaces(id) on delete restrict,
  actor_id     uuid not null,
  role         proofops.workspace_role not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, actor_id)
);

create table proofops.tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references proofops.workspaces(id) on delete restrict,
  created_by     uuid not null,
  goal           text not null check (length(goal) between 1 and 2000),
  plan           jsonb not null,
  policy_version text not null check (length(policy_version) between 1 and 80),
  status         proofops.task_status not null default 'planned',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, workspace_id)                 -- target of the composite foreign keys below
);

-- Every child row carries (task_id, workspace_id) as one foreign key, so a row can never point at a task in
-- another workspace even if its own workspace_id passes RLS.
create table proofops.sandbox_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  task_id       uuid not null,
  image_digest  text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  limits        jsonb not null check (
                  jsonb_typeof(limits -> 'timeout_ms') = 'number' and (limits ->> 'timeout_ms')::numeric between 1000 and 300000
              and jsonb_typeof(limits -> 'memory_mb')  = 'number' and (limits ->> 'memory_mb')::numeric  between 64 and 4096
              and jsonb_typeof(limits -> 'cpus')       = 'number' and (limits ->> 'cpus')::numeric       > 0 and (limits ->> 'cpus')::numeric <= 4
              and jsonb_typeof(limits -> 'pids')       = 'number' and (limits ->> 'pids')::numeric       between 16 and 1024
              and jsonb_typeof(limits -> 'network_allowlist') = 'array'),
  started_at    timestamptz,
  ended_at      timestamptz check (ended_at is null or started_at is not null),
  exit_reason   text check (exit_reason is null or length(exit_reason) <= 200),
  destroyed     boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (task_id, workspace_id) references proofops.tasks(id, workspace_id) on delete restrict
);

create table proofops.execution_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null,
  task_id       uuid not null,
  run_id        uuid,
  kind          text not null check (length(kind) between 1 and 60),
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now(),
  foreign key (task_id, workspace_id) references proofops.tasks(id, workspace_id) on delete restrict,
  foreign key (run_id, workspace_id) references proofops.sandbox_runs(id, workspace_id) on delete restrict
);

create table proofops.evidence (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  task_id       uuid not null,
  run_id        uuid,
  kind          text not null check (kind in ('screenshot', 'dom_snapshot', 'har', 'verification', 'log')),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_ref   text not null check (length(storage_ref) between 1 and 500),   -- bytes live on the Vultr side
  verdict       jsonb check (kind <> 'verification' or jsonb_typeof(verdict -> 'passed') = 'boolean'),
  created_at    timestamptz not null default now(),
  foreign key (task_id, workspace_id) references proofops.tasks(id, workspace_id) on delete restrict,
  foreign key (run_id, workspace_id) references proofops.sandbox_runs(id, workspace_id) on delete restrict
);

create table proofops.approvals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  task_id       uuid not null,
  decided_by    uuid not null,
  decision      text not null check (decision in ('approve', 'reject')),
  reason        text check (reason is null or length(reason) <= 1000),
  created_at    timestamptz not null default now(),
  foreign key (task_id, workspace_id) references proofops.tasks(id, workspace_id) on delete restrict
);

create table proofops.audit_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  actor_id      uuid,
  action        text not null check (length(action) between 1 and 80),
  target        text,
  detail        jsonb not null default '{}'::jsonb,
  prev_hash     text,                       -- set by the database, not the caller
  hash          text not null,              -- set by the database, not the caller
  at            timestamptz not null default now()
);

create table proofops.model_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  task_id       uuid,
  provider      text not null default 'vultr',
  model         text not null,
  purpose       text not null,
  input_tokens  integer check (input_tokens  >= 0),
  output_tokens integer check (output_tokens >= 0),
  latency_ms    integer check (latency_ms    >= 0),
  outcome       text not null,
  created_at    timestamptz not null default now(),
  foreign key (task_id, workspace_id) references proofops.tasks(id, workspace_id) on delete restrict
);

create table proofops.usage_quotas (
  workspace_id  uuid not null references proofops.workspaces(id) on delete restrict,
  resource      text not null check (resource in ('inference_requests', 'sandbox_runs', 'sandbox_seconds')),
  daily_max     integer not null check (daily_max >= 0),
  used_today    integer not null default 0 check (used_today >= 0),
  day           date not null default current_date,
  primary key (workspace_id, resource)
);

create index on proofops.tasks (workspace_id, created_at desc);
create index on proofops.sandbox_runs (task_id);
create index on proofops.execution_events (task_id, at);
create index on proofops.evidence (task_id);
create index on proofops.approvals (task_id, created_at desc);
create index on proofops.audit_events (workspace_id, id desc);
create index on proofops.model_requests (workspace_id, created_at desc);

-- Membership helpers, used by RLS policies. SECURITY DEFINER (as proofops_owner, which is not BYPASSRLS) so the
-- policies do not recurse.
create function proofops.has_role(ws uuid, roles proofops.workspace_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from proofops.workspace_memberships m
                 where m.workspace_id = ws and m.actor_id = proofops.actor() and m.role = any (roles))
$$;
create function proofops.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select proofops.has_role(ws, array['owner', 'approver', 'operator', 'viewer']::proofops.workspace_role[])
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Database-enforced invariants (apply to every role, including the owner and the migration user)
-- ---------------------------------------------------------------------------------------------------------

create function proofops.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'proofops.% is append-only', tg_table_name using errcode = 'P0001'; end $$;

create trigger execution_events_append_only before update or delete on proofops.execution_events
  for each row execute function proofops.forbid_change();
create trigger evidence_append_only before update or delete on proofops.evidence
  for each row execute function proofops.forbid_change();
create trigger approvals_append_only before update or delete on proofops.approvals
  for each row execute function proofops.forbid_change();
create trigger audit_events_append_only before update or delete on proofops.audit_events
  for each row execute function proofops.forbid_change();
create trigger tasks_no_delete before delete on proofops.tasks
  for each row execute function proofops.forbid_change();
create trigger sandbox_runs_no_delete before delete on proofops.sandbox_runs
  for each row execute function proofops.forbid_change();

-- A3: tasks start as `planned`; the goal, plan and policy are frozen at creation; status moves only along the
-- allowed transitions; `approved` needs a latest decision of approve; `running` needs a started run; `completed`
-- needs `verifying` first, a passing verification evidence row, and every run for the task ended and destroyed.
create function proofops.tasks_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'planned' then raise exception 'a task must be created as planned' using errcode = 'P0001'; end if;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  if (new.id, new.workspace_id, new.created_by, new.goal, new.plan, new.policy_version, new.created_at)
     is distinct from (old.id, old.workspace_id, old.created_by, old.goal, old.plan, old.policy_version, old.created_at) then
    raise exception 'task identity, goal, plan and policy are immutable' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    allowed := (old.status::text, new.status::text) in (
      ('planned', 'awaiting_approval'), ('planned', 'cancelled'),
      ('awaiting_approval', 'approved'), ('awaiting_approval', 'blocked'), ('awaiting_approval', 'cancelled'),
      ('approved', 'running'), ('approved', 'cancelled'),
      ('running', 'verifying'), ('running', 'blocked'), ('running', 'failed'),
      ('verifying', 'completed'), ('verifying', 'failed'), ('verifying', 'blocked'));
    if not allowed then
      raise exception 'task transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;

    if new.status = 'approved' and coalesce((
         select a.decision from proofops.approvals a where a.task_id = new.id
         order by a.created_at desc, a.id desc limit 1), '') <> 'approve' then
      raise exception 'task % has no approval', new.id using errcode = 'P0001';
    end if;

    if new.status = 'running' and not exists (
         select 1 from proofops.sandbox_runs r where r.task_id = new.id and r.started_at is not null) then
      raise exception 'task % has no started sandbox run', new.id using errcode = 'P0001';
    end if;

    if new.status = 'completed' then
      if not exists (select 1 from proofops.evidence e where e.task_id = new.id and e.kind = 'verification'
                     and (e.verdict ->> 'passed')::boolean) then
        raise exception 'task % has no passing verification evidence', new.id using errcode = 'P0001';
      end if;
      if not exists (select 1 from proofops.sandbox_runs r where r.task_id = new.id)
         or exists (select 1 from proofops.sandbox_runs r where r.task_id = new.id
                    and (r.ended_at is null or not r.destroyed)) then
        raise exception 'task % has a sandbox run that is not ended and destroyed', new.id using errcode = 'P0001';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;
create trigger tasks_guard before insert or update on proofops.tasks
  for each row execute function proofops.tasks_guard();

-- A4: a run can only be created for an approved or running task. Its task, workspace, image and limits never
-- change. started_at and ended_at are set once, in order; destroyed only goes from false to true.
create function proofops.sandbox_runs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from proofops.tasks t where t.id = new.task_id and t.status in ('approved', 'running')) then
      raise exception 'sandbox runs need an approved task' using errcode = 'P0001';
    end if;
    if new.started_at is not null or new.ended_at is not null or new.exit_reason is not null or new.destroyed then
      raise exception 'a sandbox run must be created unstarted' using errcode = 'P0001';
    end if;
    new.created_at := now();
    return new;
  end if;

  if (new.id, new.workspace_id, new.task_id, new.image_digest, new.limits, new.created_at)
     is distinct from (old.id, old.workspace_id, old.task_id, old.image_digest, old.limits, old.created_at) then
    raise exception 'sandbox run image and limits are immutable' using errcode = 'P0001';
  end if;
  if old.started_at is not null and new.started_at is distinct from old.started_at then
    raise exception 'started_at is set once' using errcode = 'P0001';
  end if;
  if old.ended_at is not null and (new.ended_at is distinct from old.ended_at or new.exit_reason is distinct from old.exit_reason) then
    raise exception 'ended_at and exit_reason are set once' using errcode = 'P0001';
  end if;
  if new.ended_at is not null and new.ended_at < new.started_at then
    raise exception 'ended_at precedes started_at' using errcode = 'P0001';
  end if;
  if old.destroyed and not new.destroyed then
    raise exception 'a destroyed run cannot be revived' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger sandbox_runs_guard before insert or update on proofops.sandbox_runs
  for each row execute function proofops.sandbox_runs_guard();

-- Approvals only while the task awaits approval; evidence only while the task runs or is being verified.
create function proofops.task_phase_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  s proofops.task_status;
begin
  select t.status into s from proofops.tasks t where t.id = new.task_id;
  if tg_table_name = 'approvals' and s is distinct from 'awaiting_approval' then
    raise exception 'approvals are only accepted while the task awaits approval' using errcode = 'P0001';
  end if;
  if tg_table_name = 'evidence' and (s is null or s not in ('running', 'verifying')) then
    raise exception 'evidence is only accepted while the task runs or is verified' using errcode = 'P0001';
  end if;
  new.created_at := now();
  return new;
end $$;
create trigger approvals_phase before insert on proofops.approvals
  for each row execute function proofops.task_phase_guard();
create trigger evidence_phase before insert on proofops.evidence
  for each row execute function proofops.task_phase_guard();

-- Audit hash chain computed by the database: callers cannot choose prev_hash, hash or time.
create function proofops.audit_chain() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  prev text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('proofops.audit:' || new.workspace_id::text, 0));
  select a.hash into prev from proofops.audit_events a where a.workspace_id = new.workspace_id order by a.id desc limit 1;
  new.at := pg_catalog.clock_timestamp();
  new.prev_hash := prev;
  new.hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws('|',
    coalesce(prev, 'genesis'), new.id::text, new.workspace_id::text, coalesce(new.actor_id::text, ''), new.action,
    coalesce(new.target, ''), new.detail::text, new.at::text), 'UTF8')), 'hex');
  return new;
end $$;
create trigger audit_events_chain before insert on proofops.audit_events
  for each row execute function proofops.audit_chain();

-- ---------------------------------------------------------------------------------------------------------
-- The only write paths for task status (A3) and quotas (A2)
-- ---------------------------------------------------------------------------------------------------------

create function proofops.transition_task(p_task uuid, p_to proofops.task_status, p_reason text default null)
returns proofops.task_status
language plpgsql security definer set search_path = '' as $$
declare
  t proofops.tasks;
  needed proofops.workspace_role[];
begin
  select * into t from proofops.tasks where id = p_task for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;

  needed := case p_to
    when 'approved'  then array['owner', 'approver']::proofops.workspace_role[]
    when 'blocked'   then array['owner', 'approver', 'operator']::proofops.workspace_role[]
    when 'cancelled' then array['owner', 'approver', 'operator']::proofops.workspace_role[]
    else array['owner', 'operator']::proofops.workspace_role[] end;
  if not proofops.has_role(t.workspace_id, needed) then
    raise exception 'not allowed to move this task to %', p_to using errcode = '42501';
  end if;

  update proofops.tasks set status = p_to where id = p_task;   -- tasks_guard enforces the transition rules
  insert into proofops.execution_events (workspace_id, task_id, kind, detail)
  values (t.workspace_id, p_task, 'status_changed',
          pg_catalog.jsonb_build_object('from', t.status, 'to', p_to, 'by', proofops.actor(), 'reason', p_reason));
  insert into proofops.audit_events (workspace_id, actor_id, action, target, detail)
  values (t.workspace_id, proofops.actor(), 'task.' || p_to::text, p_task::text,
          pg_catalog.jsonb_build_object('from', t.status, 'reason', p_reason));
  return p_to;
end $$;

-- Atomically consumes quota. Returns false (and changes nothing) when no quota row exists or the limit would be
-- exceeded. Usage only grows within a day; only the owner, through the admin path, sets daily_max.
create function proofops.consume_quota(p_ws uuid, p_resource text, p_amount integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  q proofops.usage_quotas;
begin
  if not proofops.has_role(p_ws, array['owner', 'operator']::proofops.workspace_role[]) then
    raise exception 'not allowed to consume quota' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    raise exception 'invalid quota amount' using errcode = '22023';
  end if;
  select * into q from proofops.usage_quotas where workspace_id = p_ws and resource = p_resource for update;
  if not found then return false; end if;
  if q.day <> current_date then q.used_today := 0; q.day := current_date; end if;
  if q.used_today + p_amount > q.daily_max then return false; end if;
  update proofops.usage_quotas set used_today = q.used_today + p_amount, day = q.day
   where workspace_id = p_ws and resource = p_resource;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Row level security: enabled on every table. Not forced, because the definer functions above run as the owner
-- and must see every row to enforce the rules. proofops_app is never the owner, so RLS always applies to it.
-- ---------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['workspaces', 'workspace_memberships', 'tasks', 'sandbox_runs', 'execution_events',
                           'evidence', 'approvals', 'audit_events', 'model_requests', 'usage_quotas'] loop
    execute format('alter table proofops.%I enable row level security', t);
  end loop;
end $$;

create policy ws_select    on proofops.workspaces            for select to proofops_app using (proofops.is_member(id));
create policy mem_select   on proofops.workspace_memberships for select to proofops_app using (proofops.is_member(workspace_id));
create policy task_select  on proofops.tasks                 for select to proofops_app using (proofops.is_member(workspace_id));
create policy run_select   on proofops.sandbox_runs          for select to proofops_app using (proofops.is_member(workspace_id));
create policy ev_select    on proofops.execution_events      for select to proofops_app using (proofops.is_member(workspace_id));
create policy evid_select  on proofops.evidence              for select to proofops_app using (proofops.is_member(workspace_id));
create policy appr_select  on proofops.approvals             for select to proofops_app using (proofops.is_member(workspace_id));
create policy audit_select on proofops.audit_events          for select to proofops_app using (proofops.is_member(workspace_id));
create policy mreq_select  on proofops.model_requests        for select to proofops_app using (proofops.is_member(workspace_id));
create policy quota_select on proofops.usage_quotas          for select to proofops_app using (proofops.is_member(workspace_id));

create policy task_insert on proofops.tasks for insert to proofops_app with check (
  created_by = proofops.actor() and proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));
create policy run_insert on proofops.sandbox_runs for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));
create policy run_update on proofops.sandbox_runs for update to proofops_app
  using (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]))
  with check (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));
create policy ev_insert on proofops.execution_events for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));
create policy evid_insert on proofops.evidence for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));
create policy appr_insert on proofops.approvals for insert to proofops_app with check (
  decided_by = proofops.actor() and proofops.has_role(workspace_id, array['owner', 'approver']::proofops.workspace_role[]));
create policy audit_insert on proofops.audit_events for insert to proofops_app
  with check (actor_id = proofops.actor() and proofops.is_member(workspace_id));
create policy mreq_insert on proofops.model_requests for insert to proofops_app
  with check (proofops.has_role(workspace_id, array['owner', 'operator']::proofops.workspace_role[]));

-- ---------------------------------------------------------------------------------------------------------
-- Grants: proofops_app only. No DELETE anywhere. No UPDATE on tasks (A3) or usage_quotas (A2). On sandbox_runs
-- only the lifecycle columns are updatable (A4). Workspaces and memberships are read-only to the backend.
-- ---------------------------------------------------------------------------------------------------------
revoke execute on all functions in schema proofops from public;   -- explicit, in addition to the default above
grant usage on schema proofops to proofops_app;
grant usage on type proofops.workspace_role, proofops.task_status to proofops_app;
grant execute on function proofops.actor(), proofops.is_member(uuid), proofops.has_role(uuid, proofops.workspace_role[]),
  proofops.transition_task(uuid, proofops.task_status, text), proofops.consume_quota(uuid, text, integer) to proofops_app;
grant select on all tables in schema proofops to proofops_app;
grant insert on proofops.tasks, proofops.sandbox_runs, proofops.execution_events, proofops.evidence,
  proofops.approvals, proofops.audit_events, proofops.model_requests to proofops_app;
grant update (started_at, ended_at, exit_reason, destroyed) on proofops.sandbox_runs to proofops_app;

-- Confirm ACT III's API roles have nothing here (no-ops by design, kept as explicit statements).
revoke all on schema proofops from anon, authenticated, service_role;

reset role;

-- A1: drop the temporary membership. `postgres` keeps only the automatic ADMIN OPTION from creating the roles.
revoke proofops_owner from postgres;

commit;
