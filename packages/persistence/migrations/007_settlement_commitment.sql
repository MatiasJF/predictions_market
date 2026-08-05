-- 007_settlement_commitment — CONC-003a: bind each settlement to its batch of signed receipts. `batch_digest` is
-- the commitment (hash of the ordered receipts) that the settle tx also pins on-chain via an OP_RETURN output;
-- `attestation_sig`/`attestation_pubkey` are the sequencer's signature over the settlement claim
-- (marketId|fromVersion|toVersion|batchDigest|netYes|netNo|netCash|newStateHash). Together they let anyone audit
-- that a settlement matches its receipts, and make equivocation provable. Public data only.
ALTER TABLE exec_batches ADD COLUMN batch_digest       TEXT;   -- hex sha256 commitment to the ordered receipts
ALTER TABLE exec_batches ADD COLUMN attestation_sig    TEXT;   -- sequencer signature over the settlement claim (DER hex)
ALTER TABLE exec_batches ADD COLUMN attestation_pubkey TEXT;   -- sequencer pubkey (DER hex)

-- The receipt's signed timestamp is part of the signed payload; persist it so a stored receipt can be
-- re-verified (and the batch digest recomputed) from the DB alone. NULL for any pre-007 row.
ALTER TABLE exec_orders ADD COLUMN ts INTEGER;
