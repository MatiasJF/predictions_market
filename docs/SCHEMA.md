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
- **tokens** — YES/NO claim-ticket UTXOs held by users; `burned` flips on sell/redeem. `(txid, vout)` unique.
  Populated once on-chain minting is available (Phase 2 / sCrypt); the Rúnar engine does not mint.
- **broadcasts** (`002`) — the **sign-off queue**. One row per prepared-but-unsent spend: `market_id`, `kind`
  (`deploy|buy|sell|resolve|redeem`), human `summary`, `spend_sats`, `plan` (JSON `TxPlan` — unsigned
  descriptor + DB effects, **NO key material**), `status` (`pending→broadcast|rejected|failed`), `txid`,
  `error`, timestamps. `POST /broadcasts/:id/authorize` is the only path that signs+sends; ≤1 `pending` per
  market. Since `006`, `kind` also allows `settle` (batch settlement enqueues here).
- **exec_orders** (`004`, CONC-001) — the **off-chain execution ledger**: one row per instant fill AND its signed
  receipt. `market_id` (not FK — the execution core is decoupled from the markets DDL), `seq` (per-market
  monotonic, unique), `trader_pubkey`, `side`, `action`, `shares`, `price_sats`, `cost_sats`, the resulting
  `q_yes/q_no/e_yes/e_no` + `state_hash` (sha256 commitment), `sig` + `signer_pubkey` (the receipt), `batch_id`
  (NULL until settled). Public data only.
- **exec_batches** (`005`, CONC-002) — one row per **on-chain settlement**: the N `exec_orders` it collapsed into
  a single pool-version advance. `from_version → to_version`, `order_count`, `net_yes_units`, `net_no_units`
  (signed), `net_collateral_sats`, `txid`, `status`. Settled orders get `exec_orders.batch_id` stamped to it.

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
- Runner: `packages/persistence/src/db.ts` (`migrate()`); creates `schema_migrations`, applies each
  unapplied `NNN_*.sql` in order, records the version. Apply with `pnpm db:migrate`
  (`packages/persistence/src/migrate-cli.ts`, `PM_DB_PATH` or default `data/spike.db`). Verified this commit
  by applying `001`+`002`+`003` into a throwaway DB and by the `@pm/daemon` service tests (in-memory DB).
