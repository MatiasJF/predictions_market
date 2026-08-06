-- 012_sig_scheme — UI-001: record HOW the trader signed. Two schemes prove the same thing (the order was
-- authorized by the key it claims) and both reject tampering + impersonation:
--   'ecdsa'  — raw ECDSA over the payload; the CLI/runner path, and what the mainnet runs used.
--   'brc100' — a real BSV wallet signing via BRC-100 createSignature(counterparty:'anyone'); the browser path,
--              where the private key never leaves the user's wallet and the daemon verifies without it.
-- Defaulting to 'ecdsa' keeps every pre-012 row correct.
ALTER TABLE exec_orders ADD COLUMN sig_scheme TEXT NOT NULL DEFAULT 'ecdsa'
  CHECK (sig_scheme IN ('ecdsa','brc100'));
