-- Rollback for 20261017200000_jarvis_core.sql. Destroys every JARVIS cloud table and its data.
-- Take a backup first (see docs/cloud/DEPLOYMENT.md). Supabase Auth users are not touched.
begin;
drop function if exists public.purge_expired_chats(), public.export_my_data(), public.execute_approved_refund(uuid),
  public.decide_proposal(uuid, text), public.record_case(uuid, uuid, jsonb, text), public.expire_stale_model_requests(interval),
  public.complete_model_request(uuid, text, integer, integer, numeric, text), public.reserve_model_request(uuid, text, text, text),
  public.set_member_role(uuid, uuid, public.app_role), public.create_organization(text);
drop table if exists public.verification_receipts, public.simulated_refunds, public.approvals, public.action_proposals, public.cases,
  public.model_requests, public.usage_counters, public.quota_policies, public.message_shares, public.messages, public.conversations,
  public.ai_specialists, public.security_events, public.audit_events, public.org_settings, public.platform_admins, public.memberships,
  public.organizations cascade;
drop function if exists private.can_share(uuid, uuid, uuid);
drop function if exists private.audit(uuid, text, text, uuid, uuid, text, text, text, jsonb, text, text, text, uuid), private.forbid_change(),
  private.is_platform_admin(), private.has_role(uuid, public.app_role[]), private.is_member(uuid);
drop type if exists public.app_role;
drop schema if exists private;
commit;
