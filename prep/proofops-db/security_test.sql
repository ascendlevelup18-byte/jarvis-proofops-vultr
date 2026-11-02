-- Cross-schema isolation tests for the proofops schema. NOT RUN.
-- Runs inside one transaction that is always rolled back, so it leaves no rows behind.
-- Each check raises an exception on failure; success prints one NOTICE per check.
begin;

-- Fixtures (as the migration user)
insert into proofops.workspaces (id, name) values
  ('00000000-0000-4000-a000-000000000001', 'ws-a'), ('00000000-0000-4000-a000-000000000002', 'ws-b');
insert into proofops.workspace_memberships values
  ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-00000000000a', 'operator', now()),
  ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-b000-00000000000b', 'viewer',   now());
insert into proofops.tasks (id, workspace_id, created_by, goal, policy_version) values
  ('00000000-0000-4000-c000-000000000001', '00000000-0000-4000-a000-000000000001',
   '00000000-0000-4000-b000-00000000000a', 'fixture', 'test');

do $$ declare n int; begin
  -- 1. ACT III API roles cannot see the schema at all
  if has_schema_privilege('anon', 'proofops', 'usage') or has_schema_privilege('authenticated', 'proofops', 'usage')
     or has_schema_privilege('service_role', 'proofops', 'usage') then raise exception 'T1 ACT III role has proofops usage'; end if;
  raise notice 'T1 ok: anon/authenticated/service_role have no usage on proofops';

  -- 2. proofops_app has nothing outside proofops
  if has_schema_privilege('proofops_app', 'public', 'create') or has_schema_privilege('proofops_app', 'private', 'usage')
     then raise exception 'T2 proofops_app reaches ACT III schemas'; end if;
  select count(*) into n from information_schema.role_table_grants
   where grantee = 'proofops_app' and table_schema <> 'proofops';
  if n > 0 then raise exception 'T2 proofops_app has % grants outside proofops', n; end if;
  raise notice 'T2 ok: proofops_app has no grants outside proofops';

  -- 3. Neither ProofOps role can bypass RLS or log in yet
  select count(*) into n from pg_roles where rolname in ('proofops_app','proofops_owner') and (rolbypassrls or rolsuper);
  if n > 0 then raise exception 'T3 bypassrls/superuser on a ProofOps role'; end if;
  raise notice 'T3 ok: no bypassrls/superuser';

  -- 4. Every proofops table has RLS enabled and forced
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'proofops' and c.relkind = 'r' and not (c.relrowsecurity
     and (c.relforcerowsecurity or c.relname = 'workspace_memberships'));
  if n > 0 then raise exception 'T4 % tables without forced RLS', n; end if;
  raise notice 'T4 ok: RLS forced on all proofops tables';

  -- 5. No ACT III policy, grant or function changed: none reference proofops roles
  select count(*) into n from pg_policies where schemaname <> 'proofops' and ('proofops_app' = any(roles) or 'proofops_owner' = any(roles));
  if n > 0 then raise exception 'T5 ProofOps role appears in % non-proofops policies', n; end if;
  raise notice 'T5 ok: no ProofOps role in ACT III policies';
end $$;

-- 6-9 as the backend role
set local role proofops_app;
set local proofops.actor_id = '00000000-0000-4000-b000-00000000000b';   -- viewer of ws-b only
do $$ declare n int; begin
  select count(*) into n from proofops.tasks;
  if n <> 0 then raise exception 'T6 actor B sees % tasks of workspace A', n; end if;
  raise notice 'T6 ok: cross-workspace read blocked';
  begin
    insert into proofops.tasks (workspace_id, created_by, goal, policy_version)
    values ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-b000-00000000000b', 'x', 'test');
    raise exception 'T7 viewer created a task';
  exception when insufficient_privilege then raise notice 'T7 ok: viewer cannot create tasks'; end;
  begin
    perform 1 from public.organizations limit 1;
    raise exception 'T8 proofops_app read public.organizations';
  exception when insufficient_privilege then raise notice 'T8 ok: ACT III tables unreachable'; end;
  begin
    perform 1 from auth.users limit 1;
    raise exception 'T9 proofops_app read auth.users';
  exception when insufficient_privilege then raise notice 'T9 ok: auth.users unreachable'; end;
end $$;

set local proofops.actor_id = '00000000-0000-4000-b000-00000000000a';   -- operator of ws-a
do $$ begin
  insert into proofops.execution_events (workspace_id, task_id, kind)
  values ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-c000-000000000001', 'step_started');
  begin
    update proofops.execution_events set kind = 'tampered';
    raise exception 'T10 execution_events was updated';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'T10%' then raise; end if;
    raise notice 'T10 ok: execution_events cannot be changed (%)', sqlerrm;
  end;
  begin
    delete from proofops.tasks;
    raise exception 'T11 task deleted';
  exception when insufficient_privilege then raise notice 'T11 ok: no delete grant'; end;
end $$;

rollback;
