-- The share_insert policy read messages, whose select policy reads message_shares: Postgres rejects that as
-- policy recursion (found by supabase/tests/security_test.sql on the real database). The ownership check now
-- runs in a SECURITY DEFINER helper that reads the rows directly.
create function private.can_share(p_message uuid, p_boardroom uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                 where m.id = p_message and m.org_id = p_org and c.kind = 'private' and c.owner_id = (select auth.uid()))
     and exists (select 1 from public.conversations b where b.id = p_boardroom and b.org_id = p_org and b.kind = 'boardroom')
     and exists (select 1 from public.memberships x where x.org_id = p_org and x.user_id = (select auth.uid()));
$$;
revoke all on function private.can_share(uuid, uuid, uuid) from public;
grant execute on function private.can_share(uuid, uuid, uuid) to authenticated, service_role;

drop policy share_insert on public.message_shares;
create policy share_insert on public.message_shares for insert to authenticated with check (
  shared_by = (select auth.uid()) and (select private.can_share(message_id, boardroom_id, org_id)));
