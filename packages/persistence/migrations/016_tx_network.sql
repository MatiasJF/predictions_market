-- 016_tx_network — which transactions were REALLY sent (UI-018).
--
-- `status='broadcast'` cannot answer that. A `PM_NETWORK=local` run builds each transaction, verifies
-- its Script exactly as mainnet would, records the same txid, and deliberately does not send it — so
-- a rehearsed transaction and a real one are indistinguishable afterwards. That was harmless while a
-- database held one kind, and stops being harmless the moment it holds both: the app then offers a
-- block-explorer link for a transaction that exists nowhere, and whoever clicks it is told the
-- transaction cannot be found. A dead link is worse than no link, because it implies the money went
-- somewhere it did not.
--
-- `markets.network` cannot carry this: it is constrained to testnet|mainnet, and a market built on a
-- local daemon is still a mainnet-shaped market. It is the TRANSACTIONS that were never sent.
--
-- NULL means "we do not know" — rows written before this migration — and the client treats unknown
-- exactly like local: no link. Silence is the safe default.
ALTER TABLE broadcasts ADD COLUMN network TEXT;
ALTER TABLE payment_intents ADD COLUMN network TEXT;
