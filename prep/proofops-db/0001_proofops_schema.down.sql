-- Rollback for 0001_proofops_schema.sql. NOT APPLIED.
-- Removes only the proofops schema and the two ProofOps roles. Touches nothing owned by ACT III.
-- Destroys ProofOps data, so export it first if any of it matters:
--   pg_dump --schema=proofops --data-only ... > proofops-backup.sql
begin;
drop schema proofops cascade;          -- cascade is limited to objects inside schema proofops
revoke proofops_owner from postgres;
drop role proofops_app;
drop role proofops_owner;
commit;
