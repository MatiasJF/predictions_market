-- 005_settlement — on-chain batch settlement lineage (CONC-002). One row per settlement: the N off-chain
-- exec_orders it collapsed into a single pool-version advance (net YES/NO unit deltas + net cash). Settled
-- orders get their `batch_id` stamped to this row's id. BigInt columns are decimal TEXT (ADR-006). Public only.
CREATE TABLE IF NOT EXISTS exec_batches (
  id                  INTEGER PRIMARY KEY,
  market_id           INTEGER NOT NULL,
  from_version        INTEGER NOT NULL,                                  -- pool version consumed
  to_version          INTEGER NOT NULL,                                  -- pool version produced
  order_count         INTEGER NOT NULL,
  net_yes_units       TEXT    NOT NULL,                                  -- signed bigint (net YES unit delta)
  net_no_units        TEXT    NOT NULL,                                  -- signed bigint (net NO unit delta)
  net_collateral_sats INTEGER NOT NULL,                                  -- signed (+ = pool gained cash)
  txid                TEXT,
  status              TEXT    NOT NULL DEFAULT 'settled' CHECK (status IN ('settled')),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exec_batches_market ON exec_batches (market_id);
