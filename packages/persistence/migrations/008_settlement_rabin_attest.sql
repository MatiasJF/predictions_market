-- 008_settlement_rabin_attest — CONC-003b: record the sequencer's on-chain-VERIFIABLE (Rabin) attestation per
-- settlement, so a real equivocation (two conflicting attestations for the same settlement key) can be turned
-- into an on-chain fraud proof that slashes the operator's Bond. `rabin_key` = marketId‖toVersion (hex),
-- `rabin_sig` = JSON RabinSig {s, padding}, `seq_rabin_pubkey` = the sequencer Rabin modulus (decimal). Public.
ALTER TABLE exec_batches ADD COLUMN rabin_key        TEXT;
ALTER TABLE exec_batches ADD COLUMN rabin_sig        TEXT;
ALTER TABLE exec_batches ADD COLUMN seq_rabin_pubkey TEXT;
