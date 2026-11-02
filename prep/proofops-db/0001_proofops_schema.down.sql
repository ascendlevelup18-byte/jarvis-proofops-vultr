-- Rollback for 0001_proofops_schema.sql. NOT APPLIED to the shared project.
-- Removes only the proofops schema and the two ProofOps roles. Touches nothing owned by ACT III.
-- Destroys ProofOps data, so export it first if any of it matters:
--   pg_dump --schema=proofops --data-only ... > proofops-backup.sql
-- Stop the ProofOps API first: DROP ROLE fails while proofops_app has open connections.
begin;
grant proofops_owner to postgres with inherit true, set true;  -- temporary: dropping the schema needs the owner's privileges
-- Restore the built-in defaults for proofops_owner so no default-privilege entry keeps the role alive.
alter default privileges for role proofops_owner grant execute on functions to public;
alter default privileges for role proofops_owner grant usage on types to public;
drop schema proofops cascade;                                 -- cascade is confined to objects inside schema proofops
revoke proofops_owner from postgres;
drop role proofops_app;
drop role proofops_owner;
commit;
