-- ProofOps database tests: isolation from ACT III, least privilege, and the A1-A4 invariants.
-- Run as `postgres` (psql -v ON_ERROR_STOP=1 -f security_test.sql) after 0001_proofops_schema.sql.
-- Everything runs in one transaction that is rolled back at the end, including the temporary role memberships
-- the test grants itself, so it leaves nothing behind. Any failure stops with "PROOFOPS_TEST_FAILED".

begin;

create function pg_temp.ok(label text) returns void language plpgsql as $$
begin
  perform set_config('proofops_test.passed', (coalesce(nullif(current_setting('proofops_test.passed', true), ''), '0')::int + 1)::text, true);
  raise notice 'ok  %', label;
end $$;

create function pg_temp.check(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'PROOFOPS_TEST_FAILED: %', label; end if;
  perform pg_temp.ok(label);
end $$;

-- Runs sql and requires it to fail with an SQLSTATE starting with `expected`.
create function pg_temp.must_fail(label text, sql text, expected text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlstate like expected || '%' then perform pg_temp.ok(label || '  [' || sqlstate || ']'); return; end if;
    raise exception 'PROOFOPS_TEST_FAILED: % (wrong error % %)', label, sqlstate, sqlerrm;
  end;
  raise exception 'PROOFOPS_TEST_FAILED: % (statement succeeded)', label;
end $$;

-- Fixed ids
\set ws_a   '''00000000-0000-4000-a000-00000000000a'''
\set ws_b   '''00000000-0000-4000-a000-00000000000b'''
\set op_a   '''00000000-0000-4000-b000-0000000000a1'''
\set ap_a   '''00000000-0000-4000-b000-0000000000a2'''
\set vw_a   '''00000000-0000-4000-b000-0000000000a3'''
\set op_b   '''00000000-0000-4000-b000-0000000000b1'''
\set vw_b   '''00000000-0000-4000-b000-0000000000b3'''
\set task_a '''00000000-0000-4000-c000-0000000000a1'''
\set task_a2 '''00000000-0000-4000-c000-0000000000a2'''
\set task_b '''00000000-0000-4000-c000-0000000000b1'''
\set run_a  '''00000000-0000-4000-d000-0000000000a1'''
\set limits '''{"timeout_ms":60000,"memory_mb":1024,"cpus":1,"pids":256,"network_allowlist":["demo.proofops.test"]}'''
\set digest '''sha256:0000000000000000000000000000000000000000000000000000000000000000'''
\set sha    '''1111111111111111111111111111111111111111111111111111111111111111'''

-- ---------------------------------------------------------------- Isolation and least privilege (as postgres)
select pg_temp.check(not has_schema_privilege('anon', 'proofops', 'usage')
  and not has_schema_privilege('authenticated', 'proofops', 'usage')
  and not has_schema_privilege('service_role', 'proofops', 'usage'),
  'I1 anon, authenticated and service_role have no access to schema proofops');

select pg_temp.check((select count(*) from information_schema.role_table_grants
                      where grantee in ('proofops_app', 'proofops_owner') and table_schema <> 'proofops') = 0
  and not has_schema_privilege('proofops_app', 'public', 'create')
  and (to_regnamespace('private') is null or not has_schema_privilege('proofops_app', 'private', 'usage'))
  and not has_schema_privilege('proofops_app', 'auth', 'usage')
  and not has_schema_privilege('proofops_app', 'proofops', 'create'),
  'I2 ProofOps roles have no grants outside proofops and cannot create objects');

select pg_temp.check((select count(*) from pg_roles where rolname in ('proofops_app', 'proofops_owner')
                      and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolcanlogin or rolreplication)) = 0,
  'I3 ProofOps roles: no superuser, BYPASSRLS, CREATEROLE, CREATEDB, LOGIN or REPLICATION');

select pg_temp.check((select bool_and(c.relrowsecurity) and count(*) = 10 from pg_class c
                      where c.relnamespace = 'proofops'::regnamespace and c.relkind = 'r'),
  'I4 RLS enabled on all 10 proofops tables');

select pg_temp.check((select count(*) from pg_policies where schemaname <> 'proofops'
                      and roles && array['proofops_app', 'proofops_owner']::name[]) = 0
  and (select count(*) from pg_policies where schemaname = 'proofops' and not roles <@ array['proofops_app']::name[]) = 0,
  'I5 no ACT III policy names a ProofOps role; every proofops policy targets proofops_app only');

-- A1: after the migration `postgres` holds only ADMIN OPTION on the ProofOps roles, never INHERIT or SET.
select pg_temp.check((select count(*) from pg_auth_members m
                      where m.member = 'postgres'::regrole
                        and m.roleid in ('proofops_owner'::regrole, 'proofops_app'::regrole)
                        and (m.inherit_option or m.set_option)) = 0,
  'A1a postgres has no INHERIT or SET membership in a ProofOps role');
select pg_temp.must_fail('A1b postgres cannot read ProofOps tables without an explicit admin session',
  'select count(*) from proofops.tasks', '42501');

select pg_temp.check((select count(*) from pg_proc p where p.pronamespace = 'proofops'::regnamespace and p.prosecdef
                      and (p.proowner <> 'proofops_owner'::regrole
                           or not coalesce(p.proconfig @> array['search_path=""'], false))) = 0
  and (select count(*) from pg_proc p where p.pronamespace = 'proofops'::regnamespace
       and has_function_privilege('public', p.oid, 'execute')) = 0,
  'I6 definer functions are owned by proofops_owner with empty search_path; none executable by PUBLIC');

select pg_temp.check((select count(*) from pg_default_acl d where d.defaclrole not in ('proofops_owner'::regrole, 'proofops_app'::regrole)
                      and d.defaclacl::text ~ 'proofops_') = 0
  and (select count(*) from pg_default_acl d where d.defaclrole = 'proofops_app'::regrole) = 0
  and (select count(*) from pg_class c where c.relnamespace not in ('proofops'::regnamespace, 'pg_toast'::regnamespace)
       and c.relowner = 'proofops_owner'::regrole) = 0
  and (select count(*) from pg_proc p where p.pronamespace <> 'proofops'::regnamespace and p.proowner = 'proofops_owner'::regrole) = 0,
  'I7 default privileges only restrict proofops_owner''s own objects, and it owns nothing outside proofops');

-- Temporary memberships for this test only (rolled back at the end).
grant proofops_owner to postgres with inherit false, set true;
grant proofops_app   to postgres with inherit false, set true;

-- ---------------------------------------------------------------- Fixtures (as proofops_owner, the admin path)
set local role proofops_owner;
insert into proofops.workspaces (id, name) values (:ws_a, 'ws-a'), (:ws_b, 'ws-b');
insert into proofops.workspace_memberships (workspace_id, actor_id, role) values
  (:ws_a, :op_a, 'operator'), (:ws_a, :ap_a, 'approver'), (:ws_a, :vw_a, 'viewer'),
  (:ws_b, :op_b, 'operator'), (:ws_b, :vw_b, 'viewer');
insert into proofops.usage_quotas (workspace_id, resource, daily_max) values (:ws_a, 'sandbox_runs', 2);
reset role;

-- ---------------------------------------------------------------- Workflow as the backend (proofops_app)
set local role proofops_app;
set local proofops.actor_id = :op_b;
insert into proofops.tasks (id, workspace_id, created_by, goal, plan, policy_version)
values (:task_b, :ws_b, :op_b, 'task in workspace B', '{"steps":[]}', 'policy@1');

set local proofops.actor_id = :op_a;
insert into proofops.tasks (id, workspace_id, created_by, goal, plan, policy_version)
values (:task_a, :ws_a, :op_a, 'open the demo page', '{"steps":["goto"]}', 'policy@1');
select pg_temp.ok('W1 operator creates a planned task');

select pg_temp.must_fail('A3a a task cannot be created as completed',
  format('insert into proofops.tasks (workspace_id, created_by, goal, plan, policy_version, status) values (%L, %L, %L, %L, %L, %L)',
         :ws_a, :op_a, 'x', '{}', 'policy@1', 'completed'), 'P0001');
select pg_temp.must_fail('A3b the backend cannot update tasks directly',
  format('update proofops.tasks set status = %L where id = %L', 'completed', :task_a), '42501');
select pg_temp.must_fail('A3c planned -> completed is not an allowed transition',
  format('select proofops.transition_task(%L, %L)', :task_a, 'completed'), 'P0001');

select proofops.transition_task(:task_a, 'awaiting_approval');
select pg_temp.must_fail('A3d an operator cannot approve',
  format('select proofops.transition_task(%L, %L)', :task_a, 'approved'), '42501');

set local proofops.actor_id = :vw_a;
select pg_temp.must_fail('A3e a viewer cannot change task status',
  format('select proofops.transition_task(%L, %L)', :task_a, 'cancelled'), '42501');
select pg_temp.must_fail('I8 a viewer cannot create tasks',
  format('insert into proofops.tasks (workspace_id, created_by, goal, plan, policy_version) values (%L, %L, %L, %L, %L)',
         :ws_a, :vw_a, 'x', '{}', 'policy@1'), '42501');

set local proofops.actor_id = :ap_a;
select pg_temp.must_fail('A3f approval needs an approve decision on record',
  format('select proofops.transition_task(%L, %L)', :task_a, 'approved'), 'P0001');
insert into proofops.approvals (workspace_id, task_id, decided_by, decision) values (:ws_a, :task_a, :ap_a, 'approve');
select proofops.transition_task(:task_a, 'approved');
select pg_temp.ok('W2 approver records approval and approves the task');

set local proofops.actor_id = :op_a;
select pg_temp.must_fail('A4a limits outside the caps are rejected',
  format('insert into proofops.sandbox_runs (workspace_id, task_id, image_digest, limits) values (%L, %L, %L, %L)',
         :ws_a, :task_a, :digest, '{"timeout_ms":60000,"memory_mb":999999,"cpus":1,"pids":256,"network_allowlist":[]}'), '23514');
select pg_temp.must_fail('A4b a run cannot be created already started',
  format('insert into proofops.sandbox_runs (workspace_id, task_id, image_digest, limits, started_at) values (%L, %L, %L, %L, now())',
         :ws_a, :task_a, :digest, :limits), 'P0001');
insert into proofops.sandbox_runs (id, workspace_id, task_id, image_digest, limits) values (:run_a, :ws_a, :task_a, :digest, :limits);
select pg_temp.must_fail('A4c the backend cannot change sandbox limits',
  format('update proofops.sandbox_runs set limits = %L where id = %L', '{"timeout_ms":300000,"memory_mb":4096,"cpus":4,"pids":1024,"network_allowlist":["*"]}', :run_a), '42501');
select pg_temp.must_fail('A4d the backend cannot change the sandbox image',
  format('update proofops.sandbox_runs set image_digest = %L where id = %L', :digest, :run_a), '42501');

update proofops.sandbox_runs set started_at = clock_timestamp() where id = :run_a;
select proofops.transition_task(:task_a, 'running');

insert into proofops.evidence (workspace_id, task_id, run_id, kind, sha256, storage_ref, verdict)
values (:ws_a, :task_a, :run_a, 'verification', :sha, 'evidence/a/verify-1.json', '{"passed":false}');
select proofops.transition_task(:task_a, 'verifying');
select pg_temp.must_fail('A3g completion needs passing verification evidence',
  format('select proofops.transition_task(%L, %L)', :task_a, 'completed'), 'P0001');

insert into proofops.evidence (workspace_id, task_id, run_id, kind, sha256, storage_ref, verdict)
values (:ws_a, :task_a, :run_a, 'verification', :sha, 'evidence/a/verify-2.json', '{"passed":true}');
select pg_temp.must_fail('A3h completion needs every run ended and destroyed',
  format('select proofops.transition_task(%L, %L)', :task_a, 'completed'), 'P0001');

update proofops.sandbox_runs set ended_at = clock_timestamp(), exit_reason = 'done', destroyed = true where id = :run_a;
select pg_temp.must_fail('A4e a destroyed run cannot be revived',
  format('update proofops.sandbox_runs set destroyed = false where id = %L', :run_a), 'P0001');
select pg_temp.must_fail('A4f ended_at is set once',
  format('update proofops.sandbox_runs set ended_at = now() + interval %L where id = %L', '1 hour', :run_a), 'P0001');

select proofops.transition_task(:task_a, 'completed');
select pg_temp.check((select status from proofops.tasks where id = :task_a) = 'completed',
  'W3 task completes only after approval, a destroyed run and passing verification');

select pg_temp.must_fail('A3i no evidence after completion',
  format('insert into proofops.evidence (workspace_id, task_id, kind, sha256, storage_ref) values (%L, %L, %L, %L, %L)',
         :ws_a, :task_a, 'log', :sha, 'x'), 'P0001');
set local proofops.actor_id = :ap_a;
select pg_temp.must_fail('A3j no approvals after the approval phase, even from an approver',
  format('insert into proofops.approvals (workspace_id, task_id, decided_by, decision) values (%L, %L, %L, %L)',
         :ws_a, :task_a, :ap_a, 'approve'), 'P0001');
set local proofops.actor_id = :op_a;
select pg_temp.must_fail('A3k completed is terminal',
  format('select proofops.transition_task(%L, %L)', :task_a, 'running'), 'P0001');

insert into proofops.tasks (id, workspace_id, created_by, goal, plan, policy_version)
values (:task_a2, :ws_a, :op_a, 'second task', '{}', 'policy@1');
select pg_temp.must_fail('A4g sandbox runs need an approved task',
  format('insert into proofops.sandbox_runs (workspace_id, task_id, image_digest, limits) values (%L, %L, %L, %L)',
         :ws_a, :task_a2, :digest, :limits), 'P0001');

-- A2: quotas
select pg_temp.check(proofops.consume_quota(:ws_a, 'sandbox_runs', 1), 'A2a operator consumes quota (1 of 2)');
select pg_temp.check(proofops.consume_quota(:ws_a, 'sandbox_runs', 1), 'A2b operator consumes quota (2 of 2)');
select pg_temp.check(not proofops.consume_quota(:ws_a, 'sandbox_runs', 1), 'A2c quota refuses beyond the daily limit');
select pg_temp.check((select used_today from proofops.usage_quotas where workspace_id = :ws_a and resource = 'sandbox_runs') = 2,
  'A2d a refused request does not change usage');
select pg_temp.check(not proofops.consume_quota(:ws_a, 'inference_requests', 1), 'A2e no quota row means refused');
select pg_temp.must_fail('A2f the backend cannot reset quotas directly',
  format('update proofops.usage_quotas set used_today = 0 where workspace_id = %L', :ws_a), '42501');
select pg_temp.must_fail('A2g quota amounts must be positive',
  format('select proofops.consume_quota(%L, %L, -5)', :ws_a, 'sandbox_runs'), '22023');
set local proofops.actor_id = :vw_a;
select pg_temp.must_fail('A2h a viewer cannot consume or reset quota',
  format('select proofops.consume_quota(%L, %L, 1)', :ws_a, 'sandbox_runs'), '42501');

-- Cross-workspace
set local proofops.actor_id = :vw_b;
select pg_temp.check((select count(*) from proofops.tasks) = 1 and (select count(*) from proofops.evidence) = 0,
  'I9 a member of workspace B sees only workspace B');
set local proofops.actor_id = :op_a;
select pg_temp.must_fail('I10 a row cannot point at a task in another workspace',
  format('insert into proofops.model_requests (workspace_id, task_id, model, purpose, outcome) values (%L, %L, %L, %L, %L)',
         :ws_a, :task_b, 'm', 'p', 'ok'), '23503');
select pg_temp.must_fail('I11 an operator cannot write into another workspace',
  format('insert into proofops.execution_events (workspace_id, task_id, kind) values (%L, %L, %L)', :ws_b, :task_b, 'x'), '42501');
set local proofops.actor_id = '';
select pg_temp.check((select count(*) from proofops.tasks) = 0, 'I12 no actor set means no rows');
set local proofops.actor_id = :op_a;

select pg_temp.must_fail('I13 the backend cannot delete', format('delete from proofops.tasks where id = %L', :task_a2), '42501');
select pg_temp.must_fail('I14 the backend cannot rewrite events', 'update proofops.execution_events set kind = ''x''', '42501');
select pg_temp.must_fail('I15 the backend cannot read auth.users', 'select count(*) from auth.users', '42501');
select pg_temp.must_fail('I16 the backend cannot read ACT III tables', 'select count(*) from public.organizations', '42501');

-- Audit chain
insert into proofops.audit_events (workspace_id, actor_id, action, hash, prev_hash) values (:ws_a, :op_a, 'test.event', 'forged', 'forged');
select pg_temp.check((select count(*) from proofops.audit_events where hash = 'forged' or prev_hash = 'forged') = 0,
  'I17a caller-supplied audit hashes are ignored');
select pg_temp.check((select count(*) from proofops.audit_events where workspace_id = :ws_a) = 6
  and (select bool_and(prev_hash is not distinct from lag_hash) from (
         select prev_hash, lag(hash) over (order by id) lag_hash from proofops.audit_events where workspace_id = :ws_a) x),
  'I17b the database links all 6 audit events (5 transitions + 1 direct) into one hash chain');
select pg_temp.must_fail('I18 audit events must be attributed to the current actor',
  format('insert into proofops.audit_events (workspace_id, actor_id, action) values (%L, %L, %L)', :ws_a, :ap_a, 'x'), '42501');
reset role;

-- ---------------------------------------------------------------- Invariants hold even for the owner
set local role proofops_owner;
select pg_temp.must_fail('A4h even the owner cannot change sandbox limits',
  format('update proofops.sandbox_runs set limits = %L where id = %L', '{"timeout_ms":300000,"memory_mb":4096,"cpus":4,"pids":1024,"network_allowlist":["*"]}', :run_a), 'P0001');
select pg_temp.must_fail('A3l even the owner cannot change an approved plan',
  format('update proofops.tasks set plan = %L where id = %L', '{"steps":["exfiltrate"]}', :task_a), 'P0001');
select pg_temp.must_fail('A3m even the owner cannot move a completed task back',
  format('update proofops.tasks set status = %L where id = %L', 'running', :task_a), 'P0001');
select pg_temp.must_fail('I19 even the owner cannot delete evidence', 'delete from proofops.evidence', 'P0001');
select pg_temp.must_fail('I20 even the owner cannot delete tasks', 'delete from proofops.tasks', 'P0001');
reset role;

select format('PROOFOPS_DB_TESTS_PASSED: %s checks', current_setting('proofops_test.passed')) as result;
rollback;
