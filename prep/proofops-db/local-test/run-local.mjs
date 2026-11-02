// Disposable local test of the ProofOps migration. Never points at Supabase.
// Usage: PROOFOPS_PG_TEST_DIR=<folder with node_modules/@embedded-postgres/windows-x64@17.11 and pg@8> node run-local.mjs
// Builds a throwaway Postgres 17.11 with Supabase-like roles (non-superuser postgres with CREATEROLE and BYPASSRLS,
// anon, authenticated, service_role, stub auth schema), then: ACT III migrations and tests, ProofOps migration,
// ACT III fingerprint check, ProofOps tests, ACT III tests again, rollback, clean check, re-apply and re-test.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const pg = createRequire(join(process.env.PROOFOPS_PG_TEST_DIR ?? process.cwd(), "package.json"))("pg");

const HERE = process.env.PROOFOPS_PG_TEST_DIR ?? process.cwd();
const BIN = join(HERE, "node_modules/@embedded-postgres/windows-x64/native/bin");
const DATA = join(HERE, "data-" + Date.now());
const PORT = 54329;
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ACT3 = join(REPO, "reference/act3/supabase");
const PO = join(REPO, "prep/proofops-db");
const log = [];
const say = (s) => { console.log(s); log.push(s); };

execFileSync(join(BIN, "initdb.exe"), ["-D", DATA, "-U", "supabase_admin", "-A", "trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
const server = spawn(join(BIN, "postgres.exe"), ["-D", DATA, "-p", String(PORT), "-c", "listen_addresses=127.0.0.1"], { stdio: "ignore" });
const connect = async (user) => {
  for (let i = 0; i < 50; i++) {
    const c = new pg.Client({ host: "127.0.0.1", port: PORT, user, database: "app" === user ? "postgres" : (globalThis.DB ?? "postgres") });
    const notices = [];
    c.on("notice", (n) => notices.push(n.message));
    try { await c.connect(); c.notices = notices; return c; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("server did not start");
};

let exitCode = 0;
try {
  // ---- Supabase-like bootstrap (as the platform superuser) ----
  const su = await connect("supabase_admin");
  await su.query(`
    create role postgres login createrole createdb replication bypassrls nosuperuser;
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    grant anon, authenticated, service_role to postgres;`);
  await su.query("create database app owner supabase_admin");
  await su.end();
  globalThis.DB = "app";
  const su2 = await connect("supabase_admin");
  await su2.query(`
    grant connect, create, temporary on database app to postgres;
    grant all on schema public to postgres;
    grant usage on schema public to anon, authenticated, service_role;
    create schema extensions;
    create extension pgcrypto schema extensions;
    grant usage on schema extensions to postgres, anon, authenticated, service_role;
    alter database app set search_path = "$user", public, extensions;
    create schema auth;
    create table auth.users (id uuid primary key, email text, aud text, role text);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    grant usage on schema auth to postgres, anon, authenticated, service_role;
    grant all on auth.users to postgres;
    grant execute on function auth.uid() to anon, authenticated, service_role, postgres;`);
  await su2.end();

  const run = async (label, file, { expectError } = {}) => {
    const c = await connect("postgres");
    let sql = readFileSync(file, "utf8");
    // psql \set variables -> literal substitution (the test file is also runnable as-is with psql)
    const vars = {};
    sql = sql.replace(/^\\set (\w+)\s+(.+)$/gm, (_, k, v) => { vars[k] = v.trim().replace(/^'(.*)'$/s, "$1").replaceAll("''", "'"); return ""; });
    for (const [k, v] of Object.entries(vars).sort((a, b) => b[0].length - a[0].length)) sql = sql.replaceAll(":" + k, v);
    try {
      const res = await c.query(sql);
      const rows = [res].flat().flatMap((r) => r.rows ?? []);
      say(`PASS ${label}${rows.at(-1)?.result ? " -> " + rows.at(-1).result : ""}`);
      return { notices: c.notices };
    } catch (e) {
      if (expectError && e.message.includes(expectError)) { say(`PASS ${label} -> ${e.message}`); return { notices: c.notices }; }
      say(`FAIL ${label}: ${e.message}`);
      for (const n of c.notices.slice(-5)) say("  notice: " + n);
      exitCode = 1;
      throw e;
    } finally { await c.end(); }
  };

  // Fingerprint of everything ACT III depends on: policies, grants, functions, memberships, default ACLs, settings.
  const fingerprint = async () => {
    const c = await connect("supabase_admin");
    const q = async (s) => JSON.stringify((await c.query(s)).rows);
    const parts = [
      await q(`select schemaname, tablename, policyname, roles::text, cmd, qual, with_check from pg_policies where schemaname <> 'proofops' order by 1,2,3`),
      await q(`select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants where table_schema <> 'proofops' order by 1,2,3,4`),
      await q(`select n.nspname, p.proname, md5(pg_get_functiondef(p.oid)), p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private','auth') order by 1,2,3`),
      await q(`select nspname, nspacl::text, pg_get_userbyid(nspowner) from pg_namespace where nspname <> 'proofops' order by 1`),
      await q(`select r.rolname, m.rolname, a.admin_option, a.inherit_option, a.set_option from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member where r.rolname not like 'proofops%' and m.rolname not like 'proofops%' order by 1,2`),
      await q(`select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls from pg_roles where rolname not like 'proofops%' order by 1`),
      await q(`select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype, defaclacl::text from pg_default_acl where defaclrole not in (select oid from pg_roles where rolname like 'proofops%') order by 1,2,3`),
      await q(`select setdatabase, setrole, setconfig::text from pg_db_role_setting order by 1,2`),
      await q(`select c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private','auth') order by 1`),
    ];
    await c.end();
    return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
  };

  for (const f of ["20261017200000_jarvis_core.sql", "20261017203000_share_policy_fix.sql", "20261017213000_model_registry_and_case_execution.sql"])
    await run(`ACT III migration ${f}`, join(ACT3, "migrations", f));
  await run("ACT III security tests (before ProofOps)", join(ACT3, "tests/security_test.sql"), { expectError: "JARVIS_DB_TESTS_PASSED" });
  const before = await fingerprint();
  say(`ACT III fingerprint before: ${before}`);

  await run("ProofOps migration 0001", join(PO, "0001_proofops_schema.sql"));
  const afterMigration = await fingerprint();
  say(`ACT III fingerprint after migration: ${afterMigration} ${afterMigration === before ? "(unchanged)" : "(CHANGED)"}`);
  if (afterMigration !== before) exitCode = 1;

  const t = await run("ProofOps security tests", join(PO, "security_test.sql"));
  writeFileSync(join(HERE, "proofops-test-notices.txt"), t.notices.join("\n"));
  say(`  ${t.notices.filter((n) => n.startsWith("ok")).length} checks reported ok`);
  await run("ACT III security tests (after ProofOps)", join(ACT3, "tests/security_test.sql"), { expectError: "JARVIS_DB_TESTS_PASSED" });
  const afterTests = await fingerprint();
  say(`ACT III fingerprint after tests: ${afterTests} ${afterTests === before ? "(unchanged)" : "(CHANGED)"}`);

  await run("ProofOps rollback (down)", join(PO, "0001_proofops_schema.down.sql"));
  const c = await connect("supabase_admin");
  const left = (await c.query(`select (select count(*) from pg_namespace where nspname = 'proofops') s, (select count(*) from pg_roles where rolname like 'proofops%') r`)).rows[0];
  await c.end();
  const afterRollback = await fingerprint();
  say(`After rollback: proofops schemas=${left.s}, roles=${left.r}; ACT III fingerprint ${afterRollback} ${afterRollback === before ? "(identical to before)" : "(DIFFERENT)"}`);
  if (left.s !== "0" || left.r !== "0" || afterRollback !== before) exitCode = 1;

  await run("ProofOps migration re-applied after rollback", join(PO, "0001_proofops_schema.sql"));
  await run("ProofOps security tests (second run)", join(PO, "security_test.sql"));
} catch (e) {
  exitCode = 1;
  if (!log.at(-1)?.startsWith("FAIL")) say("ERROR " + e.message);
} finally {
  server.kill();
  writeFileSync(join(HERE, "proofops-db-test-log.txt"), log.join("\n") + "\n");
  say(exitCode ? "RESULT: FAILED" : "RESULT: ALL PASSED");
  process.exit(exitCode);
}
