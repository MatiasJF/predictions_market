-- 011_payout_kind — PAYOUT-001: allow 'payout' in broadcasts.kind so the receipt→on-chain payout enqueues into
-- the same human sign-off queue as every other spend. SQLite cannot ALTER a CHECK constraint, so rebuild the
-- table (faithful copy of 006 with 'payout' added), preserving rows, then restore the indexes.
CREATE TABLE broadcasts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  INTEGER REFERENCES markets(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('deploy','buy','sell','resolve','redeem','settle','payout')),
  summary    TEXT    NOT NULL,
  spend_sats INTEGER NOT NULL,
  plan       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','broadcast','rejected','failed')),
  txid       TEXT,
  error      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
INSERT INTO broadcasts_new (id, market_id, kind, summary, spend_sats, plan, status, txid, error, created_at, decided_at)
  SELECT id, market_id, kind, summary, spend_sats, plan, status, txid, error, created_at, decided_at FROM broadcasts;
DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;
CREATE INDEX idx_broadcasts_status ON broadcasts(status);
CREATE INDEX idx_broadcasts_market ON broadcasts(market_id, status);

-- One row per winner actually paid on-chain (the audit trail for the payout tx).
CREATE TABLE IF NOT EXISTS payouts (
  id            INTEGER PRIMARY KEY,
  market_id     INTEGER NOT NULL,
  trader_pubkey TEXT    NOT NULL,
  pkh           TEXT    NOT NULL,
  shares        TEXT    NOT NULL,   -- WAD-scaled bigint
  sats          INTEGER NOT NULL,
  payout_digest TEXT,               -- commitment pinned on-chain by the payout tx
  txid          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payouts_market ON payouts (market_id);
