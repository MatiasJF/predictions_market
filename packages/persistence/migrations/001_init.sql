-- 001_init — BSV Prediction Market feasibility spike data model.
-- The migration runner owns the `schema_migrations` table and records the version; this file only
-- creates the domain schema. See docs/SCHEMA.md and ADR-006 (BigInt-as-TEXT) / ADR-003 (SQLite).

-- Public keys and references ONLY. NEVER store private keys / WIF / seed phrases here (Golden Rule 6).
CREATE TABLE key_refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT    NOT NULL UNIQUE,
  role       TEXT    NOT NULL CHECK (role IN ('platform','oracle','user')),
  pubkey     TEXT    NOT NULL,                          -- compressed public key, hex
  network    TEXT    NOT NULL CHECK (network IN ('testnet','mainnet')),
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE markets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question        TEXT    NOT NULL,
  description     TEXT,
  -- LMSR params as decimal-integer TEXT (BigInt) — see ADR-006:
  b               TEXT    NOT NULL,                      -- liquidity parameter (scaled)
  scale           TEXT    NOT NULL,                      -- fixed-point SCALE for this market
  payout_unit     INTEGER NOT NULL DEFAULT 100000,       -- sats per winning share
  fee_bps         INTEGER NOT NULL DEFAULT 100,          -- 1.00% = 100 bps
  oracle_key_id   INTEGER NOT NULL REFERENCES key_refs(id),
  platform_key_id INTEGER NOT NULL REFERENCES key_refs(id),
  network         TEXT    NOT NULL CHECK (network IN ('testnet','mainnet')),
  state           TEXT    NOT NULL DEFAULT 'imported'
                  CHECK (state IN ('imported','reviewed','deployed','trading','closed',
                                   'awaiting_result','resolved','settled','voided','refunded')),
  resolution      TEXT    CHECK (resolution IN ('yes','no')),   -- NULL until resolved
  close_at        TEXT,                                  -- scheduled close timestamp (ISO)
  resolved_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Stateful pool UTXO lineage: v0 -> v1 -> v2 ...  Exactly one unspent row per market at a time.
CREATE TABLE pool_utxos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  INTEGER NOT NULL REFERENCES markets(id),
  version    INTEGER NOT NULL,                           -- 0,1,2,...
  txid       TEXT    NOT NULL,
  vout       INTEGER NOT NULL,
  sats       INTEGER NOT NULL,                           -- locked reserve / collateral (fits int64)
  -- LMSR state as decimal-integer TEXT (BigInt) — see ADR-006:
  q_yes      TEXT    NOT NULL,                           -- net YES shares (scaled)
  q_no       TEXT    NOT NULL,                           -- net NO shares (scaled)
  e_yes      TEXT    NOT NULL,                           -- exp(qYes/b)*SCALE (multiplicative state)
  e_no       TEXT    NOT NULL,                           -- exp(qNo/b)*SCALE
  spent      INTEGER NOT NULL DEFAULT 0 CHECK (spent IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market_id, version),
  UNIQUE (txid, vout)
);

CREATE TABLE trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id    INTEGER NOT NULL REFERENCES markets(id),
  from_version INTEGER NOT NULL,                         -- pool version consumed
  to_version   INTEGER NOT NULL,                         -- pool version produced
  side         TEXT    NOT NULL CHECK (side IN ('yes','no')),
  action       TEXT    NOT NULL CHECK (action IN ('buy','sell')),
  shares       TEXT    NOT NULL,                         -- scaled BigInt
  cost_sats    INTEGER NOT NULL,                         -- gross cost (buy) / proceeds (sell), sats
  fee_sats     INTEGER NOT NULL DEFAULT 0,
  buyer_key_id INTEGER REFERENCES key_refs(id),
  txid         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Token (YES/NO claim ticket) UTXOs held by users.
CREATE TABLE tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id    INTEGER NOT NULL REFERENCES markets(id),
  side         TEXT    NOT NULL CHECK (side IN ('yes','no')),
  shares       TEXT    NOT NULL,                         -- scaled BigInt
  txid         TEXT    NOT NULL,
  vout         INTEGER NOT NULL,
  owner_key_id INTEGER REFERENCES key_refs(id),
  burned       INTEGER NOT NULL DEFAULT 0 CHECK (burned IN (0,1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (txid, vout)
);

CREATE INDEX idx_pool_market_ver ON pool_utxos(market_id, version);
CREATE INDEX idx_pool_unspent    ON pool_utxos(market_id, spent);
CREATE INDEX idx_trades_market   ON trades(market_id);
CREATE INDEX idx_tokens_owner    ON tokens(owner_key_id, burned);
