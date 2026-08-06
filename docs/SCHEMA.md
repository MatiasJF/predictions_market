# Data model (SQLite)

Source of truth: `packages/persistence/migrations/*.sql`. Keep this doc in sync when migrations change
(Golden Rule 1). The blockchain is the real ledger; this DB is the run's audit trail (ADR-003).

**Number handling (ADR-006):** LMSR-scaled values (`b`, `scale`, `q_yes`, `q_no`, `e_yes`, `e_no`,
`shares`) are stored as **TEXT** decimal strings and parsed to `BigInt` in code — they can exceed int64.
Plain satoshi amounts that fit int64 (`sats`, `cost_sats`, `fee_sats`, `payout_unit`) are **INTEGER**.
Never REAL — floats break satoshi-exactness.

**Security (Golden Rule 6):** no table holds a private key. `key_refs` stores public keys / references
only; signing material is injected from env at runtime.

## Tables
- **schema_migrations** — `(version INTEGER PK, applied_at TEXT)`. Owned by the migration runner, not by
  `001_init.sql`.
- **key_refs** — labelled public keys. `role ∈ {platform,oracle,user}`, `network ∈ {testnet,mainnet}`.
- **markets** — one row per market. LMSR params (`b`, `scale`), `payout_unit` (100000), `fee_bps` (100 =
  1%), FKs to oracle/platform keys, `state` (lifecycle below), `resolution` (`yes|no`, NULL until resolved).
- **pool_utxos** — the stateful pool's version lineage and, since `003`, its **full mutable state** (the
  daemon's pool-state home — replaces `apps/spike/data/pool.json`). `(market_id, version)` unique; `(txid,
  vout)` unique. Holds reserve `sats`, LMSR state (`q_yes/q_no`, `e_yes/e_no`), plus `collateral`, `resolved`,
  `winner`, and `locking_script` (the exact continuation script needed to spend the head). Exactly one
  `spent=0` row per market at a time (the current head).
- **trades** — one row per executed buy/sell; records `from_version → to_version`, `side`, `action`,
  `shares`, `cost_sats`, `fee_sats`, optional `txid`. Under the Rúnar engine this is also the off-chain
  position ledger for state-only (plain) buys/sells (documented-trust model; on-chain tokens are Phase 2).
- **tokens** — YES/NO position-token UTXOs held by users; `burned` flips on redeem. `(txid, vout)` unique.
  **Now populated** (CONC-005): the sCrypt engine surfaces the minted token as a `TxEffects.token` and the service
  writes it on buy. Since `009` it also carries `script` (the exact locking script the backtrace redeem needs),
  `holder_pkh`, and `sats` — enough for a restarted daemon to redeem. The ~30 KB mint-tx backtrace pieces are NOT
  stored; they are re-derived from the chain at redeem time.
- **broadcasts** (`002`) — the **sign-off queue**. One row per prepared-but-unsent spend: `market_id`, `kind`
  (`deploy|buy|sell|resolve|redeem`), human `summary`, `spend_sats`, `plan` (JSON `TxPlan` — unsigned
  descriptor + DB effects, **NO key material**), `status` (`pending→broadcast|rejected|failed`), `txid`,
  `error`, timestamps. `POST /broadcasts/:id/authorize` is the only path that signs+sends; ≤1 `pending` per
  market. Since `006`, `kind` also allows `settle` (batch settlement enqueues here).
- **exec_orders** (`004`, CONC-001) — the **off-chain execution ledger**: one row per instant fill AND its signed
  receipt. `market_id` (not FK — the execution core is decoupled from the markets DDL), `seq` (per-market
  monotonic, unique), `trader_pubkey`, `side`, `action`, `shares`, `price_sats`, `cost_sats`, the resulting
  `q_yes/q_no/e_yes/e_no` + `state_hash` (sha256 commitment), `sig` + `signer_pubkey` (the receipt), `batch_id`
  (NULL until settled), and (since `007`) `ts` — the receipt's signed timestamp, so a stored receipt re-verifies
  from the DB. Public data only.
- **exec_batches** (`005`, CONC-002; `007` adds the commitment) — one row per **on-chain settlement**: the N
  `exec_orders` it collapsed into a single pool-version advance. `from_version → to_version`, `order_count`,
  `net_yes_units`, `net_no_units` (signed), `net_collateral_sats`, `txid`, `status`; and (007, CONC-003a)
  `batch_digest` (commitment to the ordered receipts, also pinned on-chain via the settle OP_RETURN),
  `attestation_sig` + `attestation_pubkey` (the sequencer's settlement claim); and (008, CONC-003b)
  `rabin_key`/`rabin_sig`/`seq_rabin_pubkey` — the on-chain-verifiable Rabin attestation, so an equivocation is
  slashable against the operator `Bond`. Settled orders get `exec_orders.batch_id` stamped to it. Enables
  `auditSettlement` to prove a settlement matches its receipts.

## Market lifecycle (markets.state)
`imported → reviewed → deployed → trading → closed → awaiting_result → resolved → settled`
Exceptional overrides: `voided`, `refunded`. (Mirrors the source roadmap's lifecycle, adapted to on-chain.)

## Relationships
```
key_refs 1──* markets (oracle_key_id, platform_key_id)
markets  1──* pool_utxos   (version lineage; one unspent head)
markets  1──* trades
markets  1──* tokens
key_refs 1──* trades (buyer_key_id)   key_refs 1──* tokens (owner_key_id)
```

## Migrations
- `001_init.sql` — initial schema (key_refs, markets, pool_utxos, trades, tokens + indexes).
- `002_broadcasts.sql` — the sign-off queue (`broadcasts` + indexes).
- `003_pool_state.sql` — `pool_utxos` gains `collateral`, `resolved`, `winner`, `locking_script` (full pool
  state, replacing `pool.json`).
- `004_execution.sql` — `exec_orders` (off-chain fill + receipt ledger, CONC-001).
- `005_settlement.sql` — `exec_batches` (on-chain batch settlement lineage, CONC-002).
- `006_broadcast_settle_kind.sql` — rebuilds `broadcasts` to allow `kind='settle'`.
- `007_settlement_commitment.sql` — `exec_batches` += `batch_digest`/`attestation_sig`/`attestation_pubkey`;
  `exec_orders` += `ts` (CONC-003a auditable settlement).
- `008_settlement_rabin_attest.sql` — `exec_batches` += `rabin_key`/`rabin_sig`/`seq_rabin_pubkey` (CONC-003b
  on-chain-verifiable attestation → slashable equivocation).
- `009_token_script.sql` — `tokens` += `script`/`holder_pkh`/`sats` (CONC-005 restart recovery; the table is
  now actually written — on buy, and burned on redeem).
- `010_order_auth.sql` — `exec_orders` += `order_sig`/`nonce` + UNIQUE(market_id, trader_pubkey, nonce)
  (LIVE-001a: orders are authenticated by the trader; a replay fails at the DB too).
- `011_payout_kind.sql` — allows `kind='payout'` in `broadcasts` + a `payouts` table (PAYOUT-001 audit
  trail: who was paid, how much, and the digest pinned on-chain).
- Runner: `packages/persistence/src/db.ts` (`migrate()`); creates `schema_migrations`, applies each
  unapplied `NNN_*.sql` in order, records the version. Apply with `pnpm db:migrate`
  (`packages/persistence/src/migrate-cli.ts`, `PM_DB_PATH` or default `data/spike.db`). Verified this commit
  by applying `001`+`002`+`003` into a throwaway DB and by the `@pm/daemon` service tests (in-memory DB).
