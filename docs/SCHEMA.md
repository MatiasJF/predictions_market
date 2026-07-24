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
- **pool_utxos** — the stateful pool's version lineage. `(market_id, version)` unique; `(txid, vout)`
  unique. Holds reserve `sats` and LMSR state (`q_yes/q_no`, `e_yes/e_no`). Exactly one `spent=0` row per
  market at a time (the current head).
- **trades** — one row per executed buy/sell; records `from_version → to_version`, `side`, `action`,
  `shares`, `cost_sats`, `fee_sats`, optional `txid`.
- **tokens** — YES/NO claim-ticket UTXOs held by users; `burned` flips on sell/redeem. `(txid, vout)` unique.

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
- Runner: `packages/persistence/src/db.ts` (`migrate()`); creates `schema_migrations`, applies each
  unapplied `NNN_*.sql` in order, records the version. Verified this commit by applying via the `sqlite3`
  CLI into a throwaway DB.
