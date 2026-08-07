-- 014_funding — FUND-001: a fill must be PAID FOR.
--
-- Until now a trader signed a message, the engine recorded `cost_sats`, and nothing ever collected it. Every
-- trader held a free option: unlimited upside, no stake, with the operator carrying the whole downside. This
-- migration adds the missing money leg.
--
-- `payment_intents` is the record of "we quoted this price, to this trader, payable to this one-time script".
-- It exists BEFORE the payment and outlives it, because it is the only place the derivation nonces are stored —
-- and without those nonces the satoshis paid to that script are unspendable even though they are ours. Losing
-- this table loses money, so treat it as ledger, not cache.
--
-- The 1:1 link to a fill is what makes the gate auditable after the fact: every exec_orders row must point at
-- an intent whose payment was accepted, and every accepted intent points back at the fill it bought.
CREATE TABLE IF NOT EXISTS payment_intents (
  id                INTEGER PRIMARY KEY,
  market_id         INTEGER NOT NULL,
  trader_pubkey     TEXT    NOT NULL,                    -- BRC-100 identity key (hex) — who we quoted
  side              TEXT    NOT NULL CHECK (side IN ('yes','no')),
  action            TEXT    NOT NULL CHECK (action IN ('buy','sell')),
  units             INTEGER NOT NULL,
  quoted_cost_sats  INTEGER NOT NULL,                    -- the price we committed to at quote time
  -- BRC-29 derivation. The nonces are NOT reconstructible: lose them and the payment is stranded.
  derivation_prefix TEXT    NOT NULL,
  derivation_suffix TEXT    NOT NULL,
  locking_script    TEXT    NOT NULL,                    -- hex P2PKH the trader must pay
  address           TEXT    NOT NULL,                    -- same script, address form (for chain queries)
  -- Lifecycle. 'pending' → 'paid' (accepted, fill created) | 'rejected' (refunded) | 'expired' (never paid).
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','rejected','expired')),
  paid_sats         INTEGER,                             -- what actually arrived (may exceed quoted)
  txid              TEXT,                                -- the trader's payment tx
  output_index      INTEGER,
  refund_txid       TEXT,                                -- set when a rejected intent is refunded
  error             TEXT,
  expires_at        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_market ON payment_intents (market_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_trader ON payment_intents (trader_pubkey);
-- One payment transaction output can fund at most one intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_txout
  ON payment_intents (txid, output_index) WHERE txid IS NOT NULL;

-- Link each fill to the payment that bought it. NULL only for rows written before this migration — new fills
-- must carry one, enforced in the service rather than by a NOT NULL that would break existing databases.
ALTER TABLE exec_orders ADD COLUMN payment_intent_id INTEGER;
ALTER TABLE exec_orders ADD COLUMN paid_sats INTEGER;
CREATE INDEX IF NOT EXISTS idx_exec_orders_intent ON exec_orders (payment_intent_id);

-- Payouts move to BRC-29 too, so a winner's own wallet can internalize the money instead of it landing at a
-- bare hash160(identity key) the wallet does not track. Keeping the nonces here is what lets a winner claim a
-- payout later from a different client.
ALTER TABLE payouts ADD COLUMN derivation_prefix TEXT;
ALTER TABLE payouts ADD COLUMN derivation_suffix TEXT;
ALTER TABLE payouts ADD COLUMN sender_identity_key TEXT;
