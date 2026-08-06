-- 009_token_script — CONC-005: make the `tokens` table (defined in 001 but never written) actually usable for
-- RESTART RECOVERY. The backtrace-verified redeem (CONC-003c) needs the token's exact locking script and holder
-- PKH; `owner_key_id` is a key_refs reference, not a hash160. The ~30 KB mint-tx backtrace pieces are NOT stored
-- — they are re-derived from the chain at redeem time (the chain is the source of truth). Public data only.
ALTER TABLE tokens ADD COLUMN script     TEXT;   -- the data+P2PKH token locking script (hex)
ALTER TABLE tokens ADD COLUMN holder_pkh TEXT;   -- hash160 hex of the holder (payout target)
ALTER TABLE tokens ADD COLUMN sats       INTEGER NOT NULL DEFAULT 1;  -- the token UTXO's satoshis
CREATE INDEX IF NOT EXISTS idx_tokens_live ON tokens (market_id) WHERE burned = 0;
