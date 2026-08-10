-- 015_sell_proceeds — FUND-001 step 7b: the market pays what it owes.
--
-- A sell has always been the market owing a trader money. The fill was recorded, `cost_sats` carried the
-- proceeds, and nothing ever sent them. Mainnet market #7 (2026-08-10) booked **998 sat owed** to a real trader
-- with no code path capable of paying it — the platform quietly defaulting on its own ledger. It survived only
-- because the same person held both keys.
--
-- This table is the debt register. A row appears when a sell fills and is stamped when the money actually
-- moves, so "owed" and "paid" are different facts rather than the same optimistic assumption.
CREATE TABLE IF NOT EXISTS sell_proceeds (
  id                  INTEGER PRIMARY KEY,
  market_id           INTEGER NOT NULL,
  -- The sell fill this settles. One debt per fill, enforced below: the whole point is paying exactly once.
  order_seq           INTEGER NOT NULL,
  trader_pubkey       TEXT    NOT NULL,
  sats                INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'owed' CHECK (status IN ('owed','paid')),
  -- Where it was paid, and the BRC-29 derivation the seller's wallet needs to internalize it. Same shape as
  -- `payouts`, and for the same reason: money at an address no wallet watches may as well not have been sent.
  pkh                 TEXT,
  derivation_prefix   TEXT,
  derivation_suffix   TEXT,
  sender_identity_key TEXT,
  txid                TEXT,
  output_index        INTEGER,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  paid_at             TEXT
);
-- Paying the same sell twice is real money twice — the defect that cost 3,000 sat on 2026-08-06, in a new place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sell_proceeds_order ON sell_proceeds (market_id, order_seq);
CREATE INDEX IF NOT EXISTS idx_sell_proceeds_status ON sell_proceeds (market_id, status);
CREATE INDEX IF NOT EXISTS idx_sell_proceeds_trader ON sell_proceeds (trader_pubkey);

-- Backfill the debts that already exist. Sells filled before this table did are still owed — mainnet market #7
-- left 998 sat outstanding to a real trader. Creating the table without recognising those would be choosing the
-- reading of history in which the platform happens to owe nothing.
INSERT OR IGNORE INTO sell_proceeds (market_id, order_seq, trader_pubkey, sats)
  SELECT market_id, seq, trader_pubkey, cost_sats FROM exec_orders WHERE action = 'sell' AND cost_sats > 0;

-- A stake is a UTXO, and paying sellers spends it. Without this flag the next proceeds payment would happily
-- select the same inputs again and build a transaction the network rejects as a double spend.
ALTER TABLE payment_intents ADD COLUMN spent INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_payment_intents_pot ON payment_intents (status, spent);

-- Paying sellers is a spend, so it goes through the same human sign-off queue as everything else — which means
-- `broadcasts.kind` has to admit it. SQLite cannot ALTER a CHECK constraint, so rebuild the table exactly as
-- 011 did, this time including the `size_bytes`/`fee_sats` columns 013 added.
CREATE TABLE broadcasts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  INTEGER REFERENCES markets(id),
  kind       TEXT    NOT NULL
             CHECK (kind IN ('deploy','buy','sell','resolve','redeem','settle','payout','proceeds')),
  summary    TEXT    NOT NULL,
  spend_sats INTEGER NOT NULL,
  plan       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','broadcast','rejected','failed')),
  txid       TEXT,
  error      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  size_bytes INTEGER,
  fee_sats   INTEGER
);
INSERT INTO broadcasts_new (id, market_id, kind, summary, spend_sats, plan, status, txid, error, created_at, decided_at, size_bytes, fee_sats)
  SELECT id, market_id, kind, summary, spend_sats, plan, status, txid, error, created_at, decided_at, size_bytes, fee_sats FROM broadcasts;
DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;
CREATE INDEX idx_broadcasts_status ON broadcasts(status);
CREATE INDEX idx_broadcasts_market ON broadcasts(market_id, status);
