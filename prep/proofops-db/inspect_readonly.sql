-- Read-only inspection of the shared project before any ProofOps write. SELECT only.
select json_build_object(
 'schemas', (select json_agg(nspname order by nspname) from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema'),
 'proofops_schema_exists', (select count(*) from pg_namespace where nspname = 'proofops'),
 'proofops_roles_exist', (select json_agg(rolname) from pg_roles where rolname like 'proofops%'),
 'public_tables', (select json_agg(json_build_object('t', c.relname, 'rls', c.relrowsecurity) order by c.relname)
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
 'policies_by_schema', (select json_object_agg(schemaname, n) from (select schemaname, count(*) n from pg_policies group by 1) x),
 'extensions', (select json_agg(extname || ' ' || extversion) from pg_extension),
 'definer_functions', (select json_agg(n.nspname || '.' || p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where p.prosecdef and n.nspname in ('public', 'private')),
 'default_acl', (select json_agg(pg_get_userbyid(defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || defaclobjtype::text || ' ' || defaclacl::text)
                 from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace),
 'event_triggers', (select json_agg(evtname) from pg_event_trigger),
 'max_connections', current_setting('max_connections'),
 'db_size', pg_size_pretty(pg_database_size(current_database())),
 'version', version()
) as inspection;
