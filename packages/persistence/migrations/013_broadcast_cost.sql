-- 013_broadcast_cost — record what each broadcast actually cost, so the transaction log survives a reload.
-- The pool covenant republishes the whole compiled contract on every spend, so SIZE is the cost; keeping it
-- next to the txid makes a run auditable after the fact ("what did this market's lifecycle cost on chain?")
-- without re-fetching every transaction. NULL for rows written before this migration, and for anything that
-- never reached the chain.
ALTER TABLE broadcasts ADD COLUMN size_bytes INTEGER;
ALTER TABLE broadcasts ADD COLUMN fee_sats INTEGER;
