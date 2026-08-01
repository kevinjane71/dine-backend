-- 002_table_parties.sql
-- The "reset all tables" flow (and the seat/party feature) writes hasParties /
-- partyGroupId / partyLabel onto tables. The offline base schema predates these
-- columns, so on a local server the pgAdapter tried to overflow them to extra_data
-- INSIDE a batch transaction — which Postgres aborts on the first missing column,
-- failing the whole reset with "current transaction is aborted" (25P02).
-- Adding the real columns makes reset (and party grouping) work offline.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS has_parties BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS party_group_id TEXT;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS party_label TEXT;
