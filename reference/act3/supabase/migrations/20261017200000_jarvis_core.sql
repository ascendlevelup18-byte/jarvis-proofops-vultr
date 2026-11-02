-- JARVIS cloud core schema (Supabase Postgres). Version 1.
--
-- Principles
--   * Every application table has row-level security enabled. Browser roles (anon, authenticated) get no
--     table privilege that a policy does not also allow; anon gets nothing at all.
--   * Tenancy comes from memberships checked against auth.uid(), never from an org id or role the client sends.
--   * Financial state changes (approve, execute, verify) happen only inside SECURITY DEFINER functions that
--     re-read the rows they act on, lock them, and write the audit event in the same transaction.
--   * AI output is stored as proposals and messages. No AI-facing role has a grant that changes money.
--   * Audit tables are append-only for every role through triggers; a database owner can still drop the
--     trigger, so this is append-only for the application, not tamper-proof storage.
--   * Amounts are integer minor units (bigint). Provider keys are never stored in the database.

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- identity and tenancy

create type public.app_role as enum ('owner', 'operator', 'viewer');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- Platform administrators are set by the database owner only (no API path writes this table).
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.org_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  chat_retention_days integer not null default 90 check (chat_retention_days between 1 and 3650),
  audit_retention_days integer not null default 2555 check (audit_retention_days between 30 and 3650),
  updated_at timestamptz not null default now()
);

-- Membership helpers. SECURITY DEFINER so policies on memberships do not recurse; search_path is empty so
-- every name is schema-qualified and cannot be shadowed.
create function private.is_member(o uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.org_id = o and m.user_id = (select auth.uid()));
$$;

create function private.has_role(o uuid, roles public.app_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.org_id = o and m.user_id = (select auth.uid()) and m.role = any (roles));
$$;

create function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a where a.user_id = (select auth.uid()));
$$;

revoke all on function private.is_member(uuid), private.has_role(uuid, public.app_role[]), private.is_platform_admin() from public;
grant usage on schema private to authenticated, service_role;
grant execute on function private.is_member(uuid), private.has_role(uuid, public.app_role[]), private.is_platform_admin() to authenticated, service_role;

-- ---------------------------------------------------------------- audit (append-only)

create table public.audit_events (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations (id) on delete cascade,
  actor_kind text not null check (actor_kind in ('user', 'service', 'ai')),
  actor_id uuid,
  operation text not null check (char_length(operation) between 1 and 80),
  case_id uuid,
  proposal_id uuid,
  provider text,
  model text,
  policy_version text,
  authorization_result text,
  execution_result text,
  verification_result text,
  correlation_id uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index audit_events_org_at_idx on public.audit_events (org_id, at desc);

create table public.security_events (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations (id) on delete set null,
  user_id uuid,
  kind text not null check (char_length(kind) between 1 and 80),
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create function private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY: % rows cannot be updated or deleted', tg_table_name using errcode = '42501';
end;
$$;
create trigger audit_events_append_only before update or delete on public.audit_events for each row execute function private.forbid_change();
create trigger security_events_append_only before update or delete on public.security_events for each row execute function private.forbid_change();

create function private.audit(
  p_org uuid, p_actor_kind text, p_operation text, p_case uuid default null, p_proposal uuid default null,
  p_authz text default null, p_exec text default null, p_verify text default null, p_detail jsonb default '{}'::jsonb,
  p_provider text default null, p_model text default null, p_policy_version text default null, p_correlation uuid default null
) returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (org_id, actor_kind, actor_id, operation, case_id, proposal_id, authorization_result, execution_result,
    verification_result, detail, provider, model, policy_version, correlation_id)
  values (p_org, p_actor_kind, (select auth.uid()), p_operation, p_case, p_proposal, p_authz, p_exec, p_verify, p_detail,
    p_provider, p_model, p_policy_version, p_correlation);
$$;
revoke all on function private.audit from public, anon, authenticated;

-- ---------------------------------------------------------------- AI specialists and conversations

create table public.ai_specialists (
  id text primary key check (id in ('ceo', 'cfo', 'sales', 'cmo', 'coo', 'hr')),
  version text not null,
  title text not null,
  boundary text not null,
  active boolean not null default true
);
insert into public.ai_specialists (id, version, title, boundary) values
  ('ceo', 'ceo@1.0.0', 'CEO · Strategy', 'Summarizes and orders the team''s proposals. Cannot override policy controls or decide for the owner.'),
  ('cfo', 'cfo@1.0.0', 'CFO · Finance', 'Every figure comes from the deterministic calculations; forecasts are labelled as scenarios.'),
  ('sales', 'sales@1.0.0', 'Sales Director', 'Names the metric that would confirm or refute each recommendation.'),
  ('cmo', 'cmo@1.0.0', 'CMO · Marketing', 'Campaign outcomes are hypotheses until an experiment measures them.'),
  ('coo', 'coo@1.0.0', 'COO · Operations', 'May propose automations only with the JARVIS pattern: AI proposes, policy decides, results are verified.'),
  ('hr', 'hr@1.0.0', 'HR Director · People', 'Proposes capacity and training options only. Never makes employment decisions or infers personal characteristics.');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('private', 'boardroom')),
  agent text references public.ai_specialists (id),
  title text check (char_length(title) <= 200),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  check ((kind = 'private') = (agent is not null))
);
create index conversations_org_idx on public.conversations (org_id, kind);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  conversation_id uuid not null,
  org_id uuid not null,
  author_kind text not null check (author_kind in ('human', 'ai')),
  author_user_id uuid references auth.users (id) on delete set null,
  agent text references public.ai_specialists (id),
  provenance jsonb, -- {kind: live|fixture, provider, model}; required for AI messages
  text text not null check (char_length(text) between 1 and 4000),
  withheld_statements integer not null default 0 check (withheld_statements >= 0),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade,
  check (author_kind <> 'human' or author_user_id is not null),
  check (author_kind <> 'ai' or (agent is not null and provenance ? 'kind' and provenance ? 'model'))
);
create index messages_conversation_idx on public.messages (conversation_id, seq);

-- A private message reaches the boardroom only through an explicit share by its conversation's owner.
create table public.message_shares (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  boardroom_id uuid not null,
  shared_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key (boardroom_id, org_id) references public.conversations (id, org_id) on delete cascade,
  unique (message_id, boardroom_id)
);

-- ---------------------------------------------------------------- model routing, requests and quotas

create table public.quota_policies (
  org_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null check (provider in ('amd', 'openrouter')),
  daily_max_requests integer not null check (daily_max_requests between 0 and 10000),
  max_output_tokens integer not null default 900 check (max_output_tokens between 100 and 4000),
  primary key (org_id, provider)
);

create table public.usage_counters (
  org_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null,
  window_start date not null,
  max_requests integer not null check (max_requests >= 0),
  used integer not null default 0,
  primary key (org_id, provider, window_start),
  check (used between 0 and max_requests)
);

create table public.model_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('amd', 'openrouter')),
  model text not null,
  operation text not null check (operation in ('team_boardroom', 'team_reply', 'case_understanding', 'case_proposal', 'health')),
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'failed', 'cancelled')),
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(12, 6),
  error_code text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index model_requests_org_user_idx on public.model_requests (org_id, user_id, created_at desc);

-- ---------------------------------------------------------------- commerce: cases, proposals, approvals

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  external_case_id text not null,
  order_ref text not null,
  data_kind text not null default 'synthetic' check (data_kind in ('synthetic')), -- no real records in this phase
  state text not null check (state in ('RECEIVED','EXTRACTING','EVIDENCE_GATHERING','ANALYZING','DECISION_PROPOSED','POLICY_VALIDATION','APPROVED','EXECUTING','VERIFYING','RESOLVED','ESCALATED','FAILED','CLOSED_NO_ACTION')),
  policy_version text not null,
  ai_provenance jsonb not null, -- adapters actually used, read from the case audit
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (org_id, external_case_id),
  unique (id, org_id)
);

create table public.action_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  kind text not null check (kind = 'refund'),
  transaction_ref text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  policy_outcome text not null check (policy_outcome in ('APPROVE')), -- only policy-approved actions become proposals
  status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected', 'verified', 'failed')),
  created_at timestamptz not null default now(),
  foreign key (case_id, org_id) references public.cases (id, org_id) on delete cascade,
  unique (org_id, idempotency_key),
  unique (id, org_id)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  proposal_id uuid not null unique, -- one human decision per proposal: a replayed approval cannot insert again
  approver_id uuid not null references auth.users (id),
  decision text not null check (decision in ('approve', 'reject')),
  created_at timestamptz not null default now(),
  foreign key (proposal_id, org_id) references public.action_proposals (id, org_id) on delete cascade
);

create table public.simulated_refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  proposal_id uuid not null unique,
  idempotency_key text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null check (status in ('SUCCEEDED', 'FAILED')),
  created_at timestamptz not null default now(),
  foreign key (proposal_id, org_id) references public.action_proposals (id, org_id) on delete cascade,
  unique (org_id, idempotency_key)
);

create table public.verification_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  proposal_id uuid not null unique,
  verified boolean not null,
  observed jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (proposal_id, org_id) references public.action_proposals (id, org_id) on delete cascade
);
create trigger verification_receipts_append_only before update or delete on public.verification_receipts for each row execute function private.forbid_change();
create trigger approvals_append_only before update on public.approvals for each row execute function private.forbid_change();

-- ---------------------------------------------------------------- privileges

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

grant usage on schema public to authenticated;
grant select on public.organizations, public.memberships, public.org_settings, public.ai_specialists, public.audit_events,
  public.model_requests, public.usage_counters, public.quota_policies, public.cases, public.action_proposals, public.approvals,
  public.simulated_refunds, public.verification_receipts, public.message_shares to authenticated;
grant select, insert, delete on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant insert, delete on public.message_shares to authenticated;

-- ---------------------------------------------------------------- row-level security

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.platform_admins enable row level security;
alter table public.org_settings enable row level security;
alter table public.audit_events enable row level security;
alter table public.security_events enable row level security;
alter table public.ai_specialists enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_shares enable row level security;
alter table public.quota_policies enable row level security;
alter table public.usage_counters enable row level security;
alter table public.model_requests enable row level security;
alter table public.cases enable row level security;
alter table public.action_proposals enable row level security;
alter table public.approvals enable row level security;
alter table public.simulated_refunds enable row level security;
alter table public.verification_receipts enable row level security;

create policy org_select on public.organizations for select to authenticated using ((select private.is_member(id)));
create policy membership_select on public.memberships for select to authenticated using ((select private.is_member(org_id)));
create policy settings_select on public.org_settings for select to authenticated using ((select private.is_member(org_id)));
create policy specialists_select on public.ai_specialists for select to authenticated using (true);
-- Audit: owners and operators of the org read it; nobody writes it directly.
create policy audit_select on public.audit_events for select to authenticated
  using (org_id is not null and (select private.has_role(org_id, array['owner', 'operator']::public.app_role[])));

-- Conversations: a private chat is visible to its owner only; a boardroom to every member of the org.
create policy conv_select on public.conversations for select to authenticated using (
  (select private.is_member(org_id)) and (kind = 'boardroom' or owner_id = (select auth.uid())));
create policy conv_insert on public.conversations for insert to authenticated with check (
  owner_id = (select auth.uid()) and (
    (kind = 'private' and (select private.is_member(org_id)))
    or (kind = 'boardroom' and (select private.has_role(org_id, array['owner', 'operator']::public.app_role[])))));
create policy conv_delete on public.conversations for delete to authenticated using (kind = 'private' and owner_id = (select auth.uid()));

-- Messages: readable where the conversation is readable, or where a private message was explicitly shared
-- into a boardroom of the same org. People insert only their own human messages; AI messages are written
-- by the server gateway after validation.
create policy msg_select on public.messages for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.org_id = messages.org_id
          and (select private.is_member(c.org_id)) and (c.kind = 'boardroom' or c.owner_id = (select auth.uid())))
  or exists (select 1 from public.message_shares s where s.message_id = messages.id and s.org_id = messages.org_id
             and (select private.is_member(s.org_id))));
create policy msg_insert on public.messages for insert to authenticated with check (
  author_kind = 'human' and author_user_id = (select auth.uid()) and agent is null and provenance is null
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.org_id = messages.org_id
              and (select private.is_member(c.org_id)) and (c.kind = 'boardroom' or c.owner_id = (select auth.uid()))
              and (c.kind = 'private' or (select private.has_role(c.org_id, array['owner', 'operator']::public.app_role[])))));

create policy share_select on public.message_shares for select to authenticated using ((select private.is_member(org_id)));
create policy share_insert on public.message_shares for insert to authenticated with check (
  shared_by = (select auth.uid())
  and exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
              where m.id = message_id and m.org_id = message_shares.org_id and c.kind = 'private' and c.owner_id = (select auth.uid()))
  and exists (select 1 from public.conversations b where b.id = boardroom_id and b.org_id = message_shares.org_id and b.kind = 'boardroom')
  and (select private.is_member(org_id)));
create policy share_delete on public.message_shares for delete to authenticated using (shared_by = (select auth.uid()));

-- Model usage: each person sees their own requests; owners see the whole org's.
create policy mreq_select on public.model_requests for select to authenticated using (
  (select private.is_member(org_id)) and (user_id = (select auth.uid()) or (select private.has_role(org_id, array['owner']::public.app_role[]))));
create policy quota_select on public.quota_policies for select to authenticated using ((select private.is_member(org_id)));
create policy usage_select on public.usage_counters for select to authenticated using ((select private.is_member(org_id)));

-- Commerce records: members read; every change goes through the functions below.
create policy cases_select on public.cases for select to authenticated using ((select private.is_member(org_id)));
create policy proposals_select on public.action_proposals for select to authenticated using ((select private.is_member(org_id)));
create policy approvals_select on public.approvals for select to authenticated using ((select private.is_member(org_id)));
create policy refunds_select on public.simulated_refunds for select to authenticated using ((select private.is_member(org_id)));
create policy receipts_select on public.verification_receipts for select to authenticated using ((select private.is_member(org_id)));
-- platform_admins and security_events: no policy, so no browser access at all.

-- ---------------------------------------------------------------- functions (the only write paths)

-- Creates an organization with the caller as its owner, atomically.
create function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED' using errcode = '28000'; end if;
  insert into public.organizations (name, created_by) values (p_name, v_uid) returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.org_settings (org_id) values (v_org);
  insert into public.quota_policies (org_id, provider, daily_max_requests) values (v_org, 'openrouter', 0), (v_org, 'amd', 0);
  perform private.audit(v_org, 'user', 'org.create');
  return v_org;
end;
$$;

-- Owners add or change members. Nobody can change their own role, and an org always keeps one owner.
create function public.set_member_role(p_org uuid, p_user uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not private.has_role(p_org, array['owner']::public.app_role[]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user = v_uid then raise exception 'CANNOT_CHANGE_OWN_ROLE' using errcode = '42501'; end if;
  insert into public.memberships (org_id, user_id, role) values (p_org, p_user, p_role)
    on conflict (org_id, user_id) do update set role = excluded.role;
  perform private.audit(p_org, 'user', 'member.set_role', p_detail => jsonb_build_object('target', p_user, 'role', p_role));
end;
$$;

-- Atomic quota reservation before any provider request. A single INSERT ... ON CONFLICT DO UPDATE takes the
-- row lock, so two concurrent callers can never both take the last request.
create function public.reserve_model_request(p_org uuid, p_provider text, p_model text, p_operation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_used integer; v_id uuid;
begin
  if not private.has_role(p_org, array['owner', 'operator']::public.app_role[]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.usage_counters as u (org_id, provider, window_start, max_requests, used)
    select p_org, p_provider, (now() at time zone 'utc')::date, q.daily_max_requests, 1
    from public.quota_policies q where q.org_id = p_org and q.provider = p_provider and q.daily_max_requests > 0
  on conflict (org_id, provider, window_start) do update set used = u.used + 1 where u.used < u.max_requests
  returning used into v_used;
  if v_used is null then raise exception 'QUOTA_EXHAUSTED' using errcode = 'P0001'; end if;
  insert into public.model_requests (org_id, user_id, provider, model, operation) values (p_org, v_uid, p_provider, p_model, p_operation)
    returning id into v_id;
  perform private.audit(p_org, 'user', 'model.reserve', p_provider => p_provider, p_model => p_model, p_detail => jsonb_build_object('request', v_id, 'used', v_used));
  return v_id;
end;
$$;

-- Server gateway only (service role): record the outcome of a reserved request. A reservation is never
-- refunded to the counter, so an interrupted request still counts (conservative).
create function public.complete_model_request(p_request uuid, p_status text, p_tokens_in integer, p_tokens_out integer, p_cost numeric, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.model_requests;
begin
  update public.model_requests set status = p_status, tokens_in = p_tokens_in, tokens_out = p_tokens_out, cost_usd = p_cost,
    error_code = p_error, completed_at = now()
  where id = p_request and status = 'reserved' returning * into r;
  if r.id is null then raise exception 'NOT_RESERVED' using errcode = 'P0001'; end if;
  insert into public.audit_events (org_id, actor_kind, operation, provider, model, execution_result, correlation_id, detail)
    values (r.org_id, 'service', 'model.complete', r.provider, r.model, p_status, r.correlation_id,
            jsonb_build_object('request', r.id, 'tokens_in', p_tokens_in, 'tokens_out', p_tokens_out, 'cost_usd', p_cost, 'error', p_error));
end;
$$;

-- Stale reservations (process died mid-call) are closed as failed and stay counted.
create function public.expire_stale_model_requests(p_older_than interval default interval '10 minutes') returns integer
language sql security definer set search_path = '' as $$
  with x as (update public.model_requests set status = 'failed', error_code = 'STALE_RESERVATION', completed_at = now()
             where status = 'reserved' and created_at < now() - p_older_than returning 1)
  select count(*)::integer from x;
$$;

-- Server gateway only: store a finished JARVIS case and, when deterministic policy approved a refund,
-- its proposal awaiting human approval. The model's text never sets amount or status: both come from the
-- case's own authorization record, which the policy engine produced.
create function public.record_case(p_org uuid, p_user uuid, p_case jsonb, p_policy_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_case uuid; v_action jsonb := p_case #> '{authorization,action}'; v_prop uuid;
begin
  if not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = p_user and m.role in ('owner', 'operator')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.cases (org_id, created_by, external_case_id, order_ref, state, policy_version, ai_provenance, result)
    values (p_org, p_user, p_case ->> 'id', p_case #>> '{request,orderId}', p_case ->> 'state', p_policy_version,
            coalesce((select jsonb_agg(distinct e #>> '{data,adapter}') from jsonb_array_elements(p_case -> 'audit') e
                      where e ->> 'type' in ('UNDERSTANDING_CALL', 'MODEL_CALL') and e #>> '{data,adapter}' is not null), '[]'::jsonb),
            p_case)
    returning id into v_case;
  if p_case #>> '{authorization,outcome}' = 'APPROVE' and v_action is not null then
    insert into public.action_proposals (org_id, case_id, kind, transaction_ref, amount_minor, currency, idempotency_key, policy_outcome)
      values (p_org, v_case, 'refund', v_action ->> 'transactionId', (v_action ->> 'amountMinor')::bigint, v_action ->> 'currency',
              v_action ->> 'idempotencyKey', 'APPROVE')
      returning id into v_prop;
  end if;
  insert into public.audit_events (org_id, actor_kind, actor_id, operation, case_id, proposal_id, policy_version, authorization_result, detail)
    values (p_org, 'service', p_user, 'case.record', v_case, v_prop, p_policy_version, p_case #>> '{authorization,outcome}',
            jsonb_build_object('state', p_case ->> 'state', 'external_case_id', p_case ->> 'id'));
  return v_case;
end;
$$;

-- A human owner or operator of the proposal's own org decides once. The org comes from the proposal row,
-- never from the caller, so an approval cannot be pointed at another workspace.
create function public.decide_proposal(p_proposal uuid, p_decision text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.action_proposals;
begin
  select * into p from public.action_proposals where id = p_proposal for update;
  if p.id is null or not private.has_role(p.org_id, array['owner', 'operator']::public.app_role[]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_decision not in ('approve', 'reject') then raise exception 'INVALID_DECISION' using errcode = '22023'; end if;
  if p.status <> 'pending_approval' then raise exception 'ALREADY_DECIDED' using errcode = 'P0001'; end if;
  insert into public.approvals (org_id, proposal_id, approver_id, decision) values (p.org_id, p.id, v_uid, p_decision);
  update public.action_proposals set status = case when p_decision = 'approve' then 'approved' else 'rejected' end where id = p.id;
  perform private.audit(p.org_id, 'user', 'proposal.decide', p_case => p.case_id, p_proposal => p.id, p_authz => p_decision);
  return p_decision;
end;
$$;

-- Executes an approved proposal against the SIMULATED gateway and verifies it by reading it back, in one
-- transaction. Idempotent: a second call finds the existing refund and moves no new money.
create function public.execute_approved_refund(p_proposal uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.action_proposals; r public.simulated_refunds; v_ok boolean; v_replayed boolean := false;
begin
  select * into p from public.action_proposals where id = p_proposal for update;
  if p.id is null or not private.has_role(p.org_id, array['owner', 'operator']::public.app_role[]) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.approvals a where a.proposal_id = p.id and a.decision = 'approve') then
    raise exception 'NOT_APPROVED' using errcode = 'P0001';
  end if;
  insert into public.simulated_refunds (org_id, proposal_id, idempotency_key, amount_minor, currency, status)
    values (p.org_id, p.id, p.idempotency_key, p.amount_minor, p.currency, 'SUCCEEDED')
    on conflict (org_id, idempotency_key) do nothing returning * into r;
  if r.id is null then
    v_replayed := true;
    select * into r from public.simulated_refunds where org_id = p.org_id and idempotency_key = p.idempotency_key;
  end if;
  -- Read-back: the stored refund must match the approved proposal exactly.
  v_ok := r.status = 'SUCCEEDED' and r.amount_minor = p.amount_minor and r.currency = p.currency and r.proposal_id = p.id;
  insert into public.verification_receipts (org_id, proposal_id, verified, observed)
    values (p.org_id, p.id, v_ok, jsonb_build_object('refund', r.id, 'amount_minor', r.amount_minor, 'currency', r.currency, 'status', r.status))
    on conflict (proposal_id) do nothing;
  update public.action_proposals set status = case when v_ok then 'verified' else 'failed' end where id = p.id;
  perform private.audit(p.org_id, 'user', 'refund.execute', p_case => p.case_id, p_proposal => p.id, p_authz => 'approved',
    p_exec => case when v_replayed then 'replayed' else 'executed' end, p_verify => case when v_ok then 'verified' else 'failed' end);
  return jsonb_build_object('refund', r.id, 'replayed', v_replayed, 'verified', v_ok, 'amount_minor', r.amount_minor, 'simulated', true);
end;
$$;

-- Data rights: a person exports or deletes their own chats. Deleting removes their private conversations
-- (messages and shares cascade). Audit rows stay, as the audit retention policy says.
create function public.export_my_data() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'conversations', coalesce((select jsonb_agg(to_jsonb(c)) from public.conversations c where c.owner_id = (select auth.uid())), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m)) from public.messages m join public.conversations c on c.id = m.conversation_id
                          where c.owner_id = (select auth.uid())), '[]'::jsonb),
    'model_requests', coalesce((select jsonb_agg(to_jsonb(r)) from public.model_requests r where r.user_id = (select auth.uid())), '[]'::jsonb));
$$;

create function public.purge_expired_chats() returns integer
language sql security definer set search_path = '' as $$
  with x as (delete from public.messages m using public.org_settings s
             where s.org_id = m.org_id and m.created_at < now() - make_interval(days => s.chat_retention_days) returning 1)
  select count(*)::integer from x;
$$;

revoke all on function public.create_organization(text), public.set_member_role(uuid, uuid, public.app_role),
  public.reserve_model_request(uuid, text, text, text), public.complete_model_request(uuid, text, integer, integer, numeric, text),
  public.expire_stale_model_requests(interval), public.record_case(uuid, uuid, jsonb, text), public.decide_proposal(uuid, text),
  public.execute_approved_refund(uuid), public.export_my_data(), public.purge_expired_chats() from public, anon, authenticated;
grant execute on function public.create_organization(text), public.set_member_role(uuid, uuid, public.app_role),
  public.reserve_model_request(uuid, text, text, text), public.decide_proposal(uuid, text), public.execute_approved_refund(uuid),
  public.export_my_data() to authenticated;
grant execute on function public.complete_model_request(uuid, text, integer, integer, numeric, text), public.expire_stale_model_requests(interval),
  public.record_case(uuid, uuid, jsonb, text), public.purge_expired_chats(), public.reserve_model_request(uuid, text, text, text) to service_role;
