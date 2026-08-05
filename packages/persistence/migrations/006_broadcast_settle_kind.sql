-- 006_broadcast_settle_kind — allow 'settle' in broadcasts.kind (CONC-002 batch settlement enqueues into the
-- same sign-off queue). SQLite cannot ALTER a CHECK constraint, so rebuild the table (faithful copy of
-- 002_broadcasts with 'settle' added), preserving any existing rows, then restore the indexes.
CREATE TABLE broadcasts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  INTEGER REFERENCES markets(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('deploy','buy','sell','resolve','redeem','settle')),
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
