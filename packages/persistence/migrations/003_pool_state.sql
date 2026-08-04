-- 003_pool_state — make pool_utxos the pool's FULL-state home (replaces the ad-hoc apps/spike/data/pool.json).
-- To spend the live pool the engine needs every mutable field + the locking script, not just q/e. These
-- columns complete the LMSRMarket mutable state (collateral/resolved/winner) and store the exact continuation
-- script produced by the last spend. BigInt columns are decimal TEXT (ADR-006). Public data only.
ALTER TABLE pool_utxos ADD COLUMN collateral     TEXT    NOT NULL DEFAULT '0';
ALTER TABLE pool_utxos ADD COLUMN resolved       INTEGER NOT NULL DEFAULT 0;   -- 0 | 1
ALTER TABLE pool_utxos ADD COLUMN winner         INTEGER NOT NULL DEFAULT 0;   -- 0 = NO, 1 = YES
ALTER TABLE pool_utxos ADD COLUMN locking_script TEXT;                          -- hex; NULL only for legacy rows
