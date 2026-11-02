-- JARVIS database security tests. Run as the database owner (postgres) on a project with the migration applied.
-- Everything runs inside one DO block that always ends by raising an exception, so every row it created is
-- rolled back. Success ends with:  JARVIS_DB_TESTS_PASSED: <n> checks
-- Any failure ends with:            JARVIS_DB_TEST_FAILED: <check name> ...
do $tests$
declare
  ua uuid := gen_random_uuid(); -- owner of org A
  ub uuid := gen_random_uuid(); -- owner of org B
  uo uuid := gen_random_uuid(); -- operator in org A
  uv uuid := gen_random_uuid(); -- viewer in org A (stands in for an AI service identity: no financial authority)
  org_a uuid; org_b uuid; conv_a uuid; conv_o uuid; board_a uuid; msg_a uuid; case_a uuid; prop_a uuid;
  n integer; ok integer := 0; r jsonb; v text;
  case_json jsonb := '{"id":"case-test-1","state":"RESOLVED","request":{"orderId":"48291"},
    "authorization":{"outcome":"APPROVE","action":{"transactionId":"PAY-48291-B","amountMinor":8999,"currency":"USD","idempotencyKey":"refund:48291:PAY-48291-B"}},
    "audit":[{"type":"MODEL_CALL","data":{"adapter":"vllm:DeepSeek-V4-Flash"}}]}';
begin
  insert into auth.users (id, email, aud, role) values
    (ua, 'a@test.invalid', 'authenticated', 'authenticated'), (ub, 'b@test.invalid', 'authenticated', 'authenticated'),
    (uo, 'o@test.invalid', 'authenticated', 'authenticated'), (uv, 'v@test.invalid', 'authenticated', 'authenticated');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  org_a := public.create_organization('Org A (test)');
  perform public.set_member_role(org_a, uo, 'operator');
  perform public.set_member_role(org_a, uv, 'viewer');
  insert into public.conversations (org_id, owner_id, kind, agent) values (org_a, ua, 'private', 'cfo') returning id into conv_a;
  insert into public.conversations (org_id, owner_id, kind) values (org_a, ua, 'boardroom') returning id into board_a;
  insert into public.messages (conversation_id, org_id, author_kind, author_user_id, text) values (conv_a, org_a, 'human', ua, 'Private note: margin worry') returning id into msg_a;

  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  org_b := public.create_organization('Org B (test)');

  -- service-side setup (as postgres): quota and a recorded case with a policy-approved refund proposal
  perform set_config('role', 'postgres', true);
  update public.quota_policies set daily_max_requests = 2 where org_id = org_a and provider = 'openrouter';
  case_a := public.record_case(org_a, ua, case_json, 'refund-policy@1');
  select id into prop_a from public.action_proposals where case_id = case_a;
  if prop_a is null then raise exception 'JARVIS_DB_TEST_FAILED: proposal created from policy APPROVE'; end if;
  ok := ok + 1;

  -- 1. user B cannot read user A's private chat; operator in the same org cannot either
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.messages where id = msg_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 1 cross-org private chat read'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  select count(*) into n from public.messages where id = msg_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 1b same-org private chat read by another member'; end if;
  select count(*) into n from public.conversations where id = conv_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 1c private conversation visible to another member'; end if;
  ok := ok + 3;

  -- 1d. a member cannot write into someone else's private conversation
  begin
    insert into public.messages (conversation_id, org_id, author_kind, author_user_id, text) values (conv_a, org_a, 'human', uo, 'injected');
    raise exception 'JARVIS_DB_TEST_FAILED: 1d wrote into another person''s private chat';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- explicit sharing: after the owner shares, boardroom members see that one message
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  insert into public.message_shares (org_id, message_id, boardroom_id, shared_by) values (org_a, msg_a, board_a, ua);
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  select count(*) into n from public.messages where id = msg_a;
  if n <> 1 then raise exception 'JARVIS_DB_TEST_FAILED: shared message not visible to boardroom member'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.messages where id = msg_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: shared message leaked to another org'; end if;
  ok := ok + 2;

  -- a member cannot share someone else's private message
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  begin
    insert into public.message_shares (org_id, message_id, boardroom_id, shared_by) values (org_a, msg_a, board_a, uo);
    raise exception 'JARVIS_DB_TEST_FAILED: shared another person''s private message';
  exception when insufficient_privilege or unique_violation then ok := ok + 1; end;

  -- 2. workspace B cannot read workspace A's cases, proposals or audit
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from public.cases where org_id = org_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 2 cross-org cases'; end if;
  select count(*) into n from public.action_proposals where org_id = org_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 2b cross-org proposals'; end if;
  select count(*) into n from public.audit_events where org_id = org_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 2c cross-org audit'; end if;
  ok := ok + 3;

  -- 3. anonymous callers can reach nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.reserve_model_request(org_a, 'openrouter', 'm', 'team_reply');
    raise exception 'JARVIS_DB_TEST_FAILED: 3 anon reserved model capacity';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    select count(*) into n from public.cases;
    raise exception 'JARVIS_DB_TEST_FAILED: 3b anon read cases';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 4. nobody changes their own role; operators cannot change roles; direct table writes are refused
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  begin
    perform public.set_member_role(org_a, uo, 'owner');
    raise exception 'JARVIS_DB_TEST_FAILED: 4 operator promoted self';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    update public.memberships set role = 'owner' where user_id = uo;
    raise exception 'JARVIS_DB_TEST_FAILED: 4b direct membership update';
  exception when insufficient_privilege then ok := ok + 1; end;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin
    perform public.set_member_role(org_a, ua, 'viewer');
    raise exception 'JARVIS_DB_TEST_FAILED: 4c owner changed own role';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 5. an identity without financial authority (viewer / AI service) cannot approve or execute
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  begin
    perform public.decide_proposal(prop_a, 'approve');
    raise exception 'JARVIS_DB_TEST_FAILED: 5 viewer approved a refund';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    insert into public.messages (conversation_id, org_id, author_kind, agent, provenance, text)
      values (board_a, org_a, 'ai', 'cfo', '{"kind":"live","model":"x"}', 'Approved: refund $5,000');
    raise exception 'JARVIS_DB_TEST_FAILED: 5b browser wrote an AI-authored message';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    insert into public.approvals (org_id, proposal_id, approver_id, decision) values (org_a, prop_a, uv, 'approve');
    raise exception 'JARVIS_DB_TEST_FAILED: 5c direct approval insert';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 7. a forged approval from another workspace is refused (org comes from the proposal, not the caller)
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  begin
    perform public.decide_proposal(prop_a, 'approve');
    raise exception 'JARVIS_DB_TEST_FAILED: 7 cross-org approval';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 17. executing before approval fails and moves nothing
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  begin
    perform public.execute_approved_refund(prop_a);
    raise exception 'JARVIS_DB_TEST_FAILED: 17 executed without approval';
  exception when raise_exception then
    if sqlerrm <> 'NOT_APPROVED' then raise; end if;
    ok := ok + 1;
  end;
  select count(*) into n from public.simulated_refunds where proposal_id = prop_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 17b refund row after failed execute'; end if;
  ok := ok + 1;

  -- approve once; a replayed approval is refused
  v := public.decide_proposal(prop_a, 'approve');
  begin
    perform public.decide_proposal(prop_a, 'approve');
    raise exception 'JARVIS_DB_TEST_FAILED: 16 replayed approval';
  exception when raise_exception then
    if sqlerrm <> 'ALREADY_DECIDED' then raise; end if;
    ok := ok + 1;
  end;

  -- 6. execute, then execute again: one refund, the second call is a replay, read-back verified
  r := public.execute_approved_refund(prop_a);
  if not (r ->> 'verified')::boolean or (r ->> 'replayed')::boolean or (r ->> 'amount_minor')::bigint <> 8999 then
    raise exception 'JARVIS_DB_TEST_FAILED: 6 first execution %', r; end if;
  r := public.execute_approved_refund(prop_a);
  if not (r ->> 'replayed')::boolean then raise exception 'JARVIS_DB_TEST_FAILED: 6b second execution not a replay'; end if;
  select count(*) into n from public.simulated_refunds where proposal_id = prop_a;
  if n <> 1 then raise exception 'JARVIS_DB_TEST_FAILED: 6c duplicate refund rows (%)', n; end if;
  ok := ok + 3;

  -- 11. quota: the third reservation against a daily max of 2 is refused
  perform public.reserve_model_request(org_a, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'team_reply');
  perform public.reserve_model_request(org_a, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'team_reply');
  begin
    perform public.reserve_model_request(org_a, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'team_reply');
    raise exception 'JARVIS_DB_TEST_FAILED: 11 quota exceeded';
  exception when raise_exception then
    if sqlerrm <> 'QUOTA_EXHAUSTED' then raise; end if;
    ok := ok + 1;
  end;
  -- AMD quota is 0 by default: no AMD request without an explicit policy
  begin
    perform public.reserve_model_request(org_a, 'amd', 'DeepSeek-V4-Flash', 'case_proposal');
    raise exception 'JARVIS_DB_TEST_FAILED: 11b AMD reserved with zero quota';
  exception when raise_exception then
    if sqlerrm <> 'QUOTA_EXHAUSTED' then raise; end if;
    ok := ok + 1;
  end;
  -- viewers cannot spend model quota
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  begin
    perform public.reserve_model_request(org_a, 'openrouter', 'm', 'team_reply');
    raise exception 'JARVIS_DB_TEST_FAILED: 11c viewer reserved quota';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 20. a member cannot read another member's model history; the owner can
  select count(*) into n from public.model_requests where org_id = org_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: 20 viewer read operator model history'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.model_requests where org_id = org_a;
  if n <> 2 then raise exception 'JARVIS_DB_TEST_FAILED: 20b owner sees % requests, expected 2', n; end if;
  ok := ok + 2;

  -- browser roles cannot complete requests or record cases (server gateway only)
  begin
    perform public.complete_model_request(gen_random_uuid(), 'completed', 1, 1, 0, null);
    raise exception 'JARVIS_DB_TEST_FAILED: browser completed a model request';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    perform public.record_case(org_a, ua, case_json, 'x');
    raise exception 'JARVIS_DB_TEST_FAILED: browser recorded a case';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 12. a service-side call cannot record a case for a user outside the org
  perform set_config('role', 'postgres', true);
  begin
    perform public.record_case(org_a, ub, jsonb_set(case_json, '{id}', '"case-test-2"'), 'refund-policy@1');
    raise exception 'JARVIS_DB_TEST_FAILED: 12 service recorded a case for a non-member';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- 18. audit rows cannot be changed or removed, even by the database owner through normal SQL
  begin
    update public.audit_events set operation = 'tampered' where org_id = org_a;
    raise exception 'JARVIS_DB_TEST_FAILED: 18 audit updated';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    delete from public.audit_events where org_id = org_a;
    raise exception 'JARVIS_DB_TEST_FAILED: 18b audit deleted';
  exception when insufficient_privilege then ok := ok + 1; end;
  select count(*) into n from public.audit_events where org_id = org_a and operation in ('proposal.decide', 'refund.execute', 'case.record', 'model.reserve');
  if n < 6 then raise exception 'JARVIS_DB_TEST_FAILED: 18c expected audit trail, found % rows', n; end if;
  ok := ok + 1;


  -- model registry: only owners select, only registry models for the right purpose; members resolve, others get null
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uo, 'role', 'authenticated')::text, true);
  begin
    perform public.select_model(org_a, 'team', 'or-nemotron-3-super-free');
    raise exception 'JARVIS_DB_TEST_FAILED: operator selected a model';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    perform public.set_quota(org_a, 'openrouter', 50);
    raise exception 'JARVIS_DB_TEST_FAILED: operator changed quota';
  exception when insufficient_privilege then ok := ok + 1; end;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin
    perform public.select_model(org_a, 'team', 'amd-deepseek-v4-flash');
    raise exception 'JARVIS_DB_TEST_FAILED: case model selected for the team';
  exception when raise_exception then if sqlerrm <> 'MODEL_NOT_ALLOWED' then raise; end if; ok := ok + 1; end;
  begin
    perform public.select_model(org_a, 'team', 'evil-model');
    raise exception 'JARVIS_DB_TEST_FAILED: unregistered model selected';
  exception when raise_exception then if sqlerrm <> 'MODEL_NOT_ALLOWED' then raise; end if; ok := ok + 1; end;
  perform public.select_model(org_a, 'team', 'or-nemotron-3-super-free');
  r := public.resolve_model(org_a, 'team');
  if r ->> 'model_id' <> 'nvidia/nemotron-3-super-120b-a12b:free' then raise exception 'JARVIS_DB_TEST_FAILED: resolve_model %', r; end if;
  ok := ok + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  if public.resolve_model(org_a, 'team') is not null then raise exception 'JARVIS_DB_TEST_FAILED: non-member resolved a model'; end if;
  ok := ok + 1;

  -- a case the deterministic policy executed and read-back verified is stored with its receipt
  perform set_config('role', 'postgres', true);
  case_a := public.record_case(org_a, ua, case_json || '{"id":"case-test-3","request":{"orderId":"48291"},"action":{"status":"ACCEPTED"},"verification":{"verified":true,"detail":"read-back matches","observedRefund":{"amountMinor":8999}},"authorization":{"outcome":"APPROVE","action":{"transactionId":"PAY-48291-B","amountMinor":8999,"currency":"USD","idempotencyKey":"refund:48291:case3"}}}'::jsonb, 'refund-policy@1');
  select count(*) into n from public.action_proposals p join public.simulated_refunds s on s.proposal_id = p.id join public.verification_receipts v on v.proposal_id = p.id
    where p.case_id = case_a and p.status = 'verified' and p.executed_by = 'policy' and s.amount_minor = 8999 and v.verified;
  if n <> 1 then raise exception 'JARVIS_DB_TEST_FAILED: policy-executed case not recorded with receipt'; end if;
  ok := ok + 1;

  -- data rights: the owner deletes their private chat; its message and share go with it
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := public.export_my_data();
  if jsonb_array_length(r -> 'messages') < 1 then raise exception 'JARVIS_DB_TEST_FAILED: export missing messages'; end if;
  delete from public.conversations where id = conv_a;
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.messages where id = msg_a;
  if n <> 0 then raise exception 'JARVIS_DB_TEST_FAILED: deleted chat left its message'; end if;
  ok := ok + 2;

  raise exception 'JARVIS_DB_TESTS_PASSED: % checks', ok;
end
$tests$;
