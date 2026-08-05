-- 004_execution — the off-chain execution ledger (CONC-001). Each row is one FILLED order AND its signed
-- receipt: the trader's proof of the fill plus the sequencer's signed commitment to the resulting LMSR state.
-- On-chain settlement (CONC-002) later stamps `batch_id` on the rows it collapses into one pool-version tx.
-- BigInt columns are decimal TEXT (ADR-006). Public data only (pubkeys + signatures — never private keys).
-- `market_id` is intentionally NOT FK-constrained so the execution core stays decoupled from the markets DDL;
-- the daemon guarantees the market exists.
CREATE TABLE IF NOT EXISTS exec_orders (
  id            INTEGER PRIMARY KEY,
  market_id     INTEGER NOT NULL,
  seq           INTEGER NOT NULL,                                  -- per-market monotonic fill index (1-based)
  trader_pubkey TEXT    NOT NULL,                                  -- DER hex
  side          TEXT    NOT NULL CHECK (side IN ('yes','no')),
  action        TEXT    NOT NULL CHECK (action IN ('buy','sell')),
  shares        TEXT    NOT NULL,                                  -- WAD-scaled bigint (total shares filled)
  price_sats    INTEGER NOT NULL,                                  -- marginal fill price after the fill
  cost_sats     INTEGER NOT NULL,                                  -- charge (buy) / proceeds (sell)
  q_yes         TEXT    NOT NULL,                                  -- resulting state (bigints)
  q_no          TEXT    NOT NULL,
  e_yes         TEXT    NOT NULL,
  e_no          TEXT    NOT NULL,
  state_hash    TEXT    NOT NULL,                                  -- sha256 state commitment (hex)
  sig           TEXT    NOT NULL,                                  -- receipt signature (DER hex)
  signer_pubkey TEXT    NOT NULL,                                  -- sequencer pubkey (DER hex)
  batch_id      INTEGER,                                           -- set at settlement (CONC-002); NULL = unsettled
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_exec_orders_market    ON exec_orders (market_id);
CREATE INDEX IF NOT EXISTS idx_exec_orders_unsettled ON exec_orders (market_id) WHERE batch_id IS NULL;
