-- Model registry, per-organization model selection, and recording of policy-executed simulated refunds.
--
-- Model registry: the only place model ids live for the cloud. The gateway uses the org's selected model
-- for a purpose ('team' or 'case'); it must be an enabled registry row for that purpose and provider. Only
-- org owners select, only from the registry, and every change is audited. Nobody can add a registry row
-- through the API: rows come from migrations, so an arbitrary endpoint or model can never be chosen.
create table public.model_registry (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  provider text not null check (provider in ('amd', 'openrouter')),
  purpose text not null check (purpose in ('team', 'case')),
  model_id text not null,
  base_url text not null check (base_url in ('https://openrouter.ai/api/v1', 'https://developer.amd.com.cn/radeon/api/v1')),
  free_only boolean not null,
  counts_for_amd boolean not null,
  enabled boolean not null default true,
  note text not null,
  unique (provider, model_id, purpose)
);
insert into public.model_registry (id, provider, purpose, model_id, base_url, free_only, counts_for_amd, note) values
  ('or-nemotron-3-super-free', 'openrouter', 'team', 'nvidia/nemotron-3-super-120b-a12b:free', 'https://openrouter.ai/api/v1', true, false,
   'Free OpenRouter model, listed with JSON output on 2026-10-17. Not AMD infrastructure.'),
  ('or-gemma-4-31b-free', 'openrouter', 'team', 'google/gemma-4-31b-it:free', 'https://openrouter.ai/api/v1', true, false,
   'Free OpenRouter alternative. Not Gemma-on-AMD evidence.'),
  ('amd-deepseek-v4-flash', 'amd', 'case', 'DeepSeek-V4-Flash', 'https://developer.amd.com.cn/radeon/api/v1', false, true,
   'AMD-hosted endpoint used by the JARVIS refund engine. Key was exposed earlier; owner-gated.');

create table public.org_model_selection (
  org_id uuid not null references public.organizations (id) on delete cascade,
  purpose text not null check (purpose in ('team', 'case')),
  registry_id text not null references public.model_registry (id),
  selected_by uuid not null references auth.users (id),
  selected_at timestamptz not null default now(),
  primary key (org_id, purpose)
);

alter table public.model_registry enable row level security;
alter table public.org_model_selection enable row level security;
grant select on public.model_registry, public.org_model_selection to authenticated;
create policy registry_select on public.model_registry for select to authenticated using (true);
create policy selection_select on public.org_model_selection for select to authenticated using ((select private.is_member(org_id)));

create function public.select_model(p_org uuid, p_purpose text, p_registry_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.model_registry;
begin
  if not private.has_role(p_org, array['owner']::public.app_role[]) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into r from public.model_registry where id = p_registry_id;
  if r.id is null or not r.enabled or r.purpose <> p_purpose then raise exception 'MODEL_NOT_ALLOWED' using errcode = 'P0001'; end if;
  insert into public.org_model_selection (org_id, purpose, registry_id, selected_by) values (p_org, p_purpose, r.id, (select auth.uid()))
    on conflict (org_id, purpose) do update set registry_id = excluded.registry_id, selected_by = excluded.selected_by, selected_at = now();
  perform private.audit(p_org, 'user', 'model.select', p_provider => r.provider, p_model => r.model_id, p_detail => jsonb_build_object('purpose', p_purpose, 'registry', r.id));
end;
$$;

-- Owners set the daily request quota per provider (0 disables it). Audited.
create function public.set_quota(p_org uuid, p_provider text, p_daily_max integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_org, array['owner']::public.app_role[]) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_daily_max not between 0 and 200 then raise exception 'QUOTA_OUT_OF_RANGE' using errcode = '22023'; end if;
  update public.quota_policies set daily_max_requests = p_daily_max where org_id = p_org and provider = p_provider;
  if not found then raise exception 'UNKNOWN_PROVIDER' using errcode = '22023'; end if;
  perform private.audit(p_org, 'user', 'quota.set', p_provider => p_provider, p_detail => jsonb_build_object('daily_max', p_daily_max));
end;
$$;

-- Resolves the model the gateway may use for a purpose, as the caller (member check included).
create function public.resolve_model(p_org uuid, p_purpose text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not private.is_member(p_org) then null else
    (select jsonb_build_object('registry_id', r.id, 'provider', r.provider, 'model_id', r.model_id, 'base_url', r.base_url,
                               'free_only', r.free_only, 'counts_for_amd', r.counts_for_amd)
     from public.org_model_selection s join public.model_registry r on r.id = s.registry_id
     where s.org_id = p_org and s.purpose = p_purpose and r.enabled) end;
$$;

-- Proposals now record who executed them: the deterministic policy within its autonomous limit, or a human.
alter table public.action_proposals add column executed_by text not null default 'human' check (executed_by in ('policy', 'human'));

-- record_case now also stores the engine's own simulated execution when policy executed autonomously:
-- the refund row and the read-back receipt come from the case record (policy amount, gateway result,
-- verification), never from model text. A case whose read-back failed is stored as failed.
create or replace function public.record_case(p_org uuid, p_user uuid, p_case jsonb, p_policy_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_case uuid; v_action jsonb := p_case #> '{authorization,action}'; v_prop uuid; v_exec boolean; v_verified boolean;
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
  v_exec := p_case #>> '{action,status}' = 'ACCEPTED';
  v_verified := coalesce((p_case #>> '{verification,verified}')::boolean, false);
  if p_case #>> '{authorization,outcome}' = 'APPROVE' and v_action is not null then
    insert into public.action_proposals (org_id, case_id, kind, transaction_ref, amount_minor, currency, idempotency_key, policy_outcome, status, executed_by)
      values (p_org, v_case, 'refund', v_action ->> 'transactionId', (v_action ->> 'amountMinor')::bigint, v_action ->> 'currency',
              v_action ->> 'idempotencyKey', 'APPROVE',
              case when v_exec and v_verified then 'verified' when v_exec then 'failed' else 'pending_approval' end,
              case when v_exec then 'policy' else 'human' end)
      returning id into v_prop;
    if v_exec then
      insert into public.simulated_refunds (org_id, proposal_id, idempotency_key, amount_minor, currency, status)
        values (p_org, v_prop, v_action ->> 'idempotencyKey', (v_action ->> 'amountMinor')::bigint, v_action ->> 'currency',
                case when v_verified then 'SUCCEEDED' else 'FAILED' end);
      insert into public.verification_receipts (org_id, proposal_id, verified, observed)
        values (p_org, v_prop, v_verified, coalesce(p_case #> '{verification,observedRefund}', '{}'::jsonb) || jsonb_build_object('detail', p_case #>> '{verification,detail}'));
    end if;
  end if;
  insert into public.audit_events (org_id, actor_kind, actor_id, operation, case_id, proposal_id, policy_version, authorization_result,
                                   execution_result, verification_result, detail)
    values (p_org, 'service', p_user, 'case.record', v_case, v_prop, p_policy_version, p_case #>> '{authorization,outcome}',
            case when v_exec then 'policy_executed_simulated' else 'not_executed' end,
            case when v_exec then (case when v_verified then 'verified' else 'failed' end) else null end,
            jsonb_build_object('state', p_case ->> 'state', 'external_case_id', p_case ->> 'id', 'adapters',
              (select jsonb_agg(distinct e #>> '{data,adapter}') from jsonb_array_elements(p_case -> 'audit') e where e #>> '{data,adapter}' is not null)));
  return v_case;
end;
$$;

revoke all on function public.select_model(uuid, text, text), public.set_quota(uuid, text, integer), public.resolve_model(uuid, text) from public, anon, authenticated;
grant execute on function public.select_model(uuid, text, text), public.set_quota(uuid, text, integer), public.resolve_model(uuid, text) to authenticated;
revoke all on function public.record_case(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_case(uuid, uuid, jsonb, text) to service_role;
