-- 010_order_auth — LIVE-001a: orders are now AUTHENTICATED by the trader. Before this, `submit()` accepted a
-- trader pubkey as a plain string and verified nothing, so the operator (or anyone with API access) could
-- fabricate fills in any user's name — fatal for "real wallets as clients". The trader now signs
-- `marketId|trader|side|action|units|nonce` with their own key and the engine verifies it BEFORE filling.
-- The UNIQUE index makes a replayed order fail at the DB even if verification were somehow bypassed.
-- Public data only (pubkeys + signatures). NULL on pre-010 rows.
ALTER TABLE exec_orders ADD COLUMN order_sig TEXT;   -- the trader's signature over the order (DER hex)
ALTER TABLE exec_orders ADD COLUMN nonce     INTEGER; -- per-trader-per-market; makes a signed order single-use
CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_orders_nonce
  ON exec_orders (market_id, trader_pubkey, nonce) WHERE nonce IS NOT NULL;
