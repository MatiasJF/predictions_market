-- 002_broadcasts — the sign-off queue (API-001). A pending broadcast is a spend the autonomous daemon
-- has PREPARED but not sent: it holds a human-readable summary + a self-contained JSON plan (unsigned tx
-- descriptor + the DB effects to apply on success). Nothing goes on-chain until a human hits the authorize
-- endpoint, which is the ONLY place the funding WIF is loaded (Golden Rule 6 / ADR-010).
--
-- The `plan` column contains NO key material — only public data (outpoints, scripts, LMSR state, effects).
-- BigInt-bearing values inside `plan`/effects are decimal strings (ADR-006).

CREATE TABLE broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  INTEGER REFERENCES markets(id),         -- NULL for pure wallet ops (e.g. a sweep)
  kind       TEXT    NOT NULL CHECK (kind IN ('deploy','buy','sell','resolve','redeem')),
  summary    TEXT    NOT NULL,                        -- human-readable, e.g. "buy 1 YES @ market 42"
  spend_sats INTEGER NOT NULL,                        -- fee (+ any real sats moved) the spend will cost
  plan       TEXT    NOT NULL,                        -- JSON TxPlan: build descriptor + effects; NO keys
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','broadcast','rejected','failed')),
  txid       TEXT,                                    -- set on successful broadcast
  error      TEXT,                                    -- set on failed broadcast
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT                                     -- when authorized/rejected/failed
);

CREATE INDEX idx_broadcasts_status ON broadcasts(status);
CREATE INDEX idx_broadcasts_market ON broadcasts(market_id, status);
