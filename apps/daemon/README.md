# @pm/daemon — the prediction-market HTTP API

A long-running localhost HTTP daemon that drives the full LMSR prediction-market lifecycle
(create → quote → deploy → buy/sell → resolve) **autonomously**. The only human touchpoint is
**authorizing wallet spends**: every state-changing operation parks in a sign-off queue and nothing reaches
mainnet until you `POST /broadcasts/:id/authorize`.

The contract toolchain sits behind a `ChainEngine` seam (`@pm/engine`) — **Rúnar** today, **sCrypt** in Phase 2
— so this API is stable across the engine swap.

## Run

```bash
pnpm db:migrate                       # apply migrations (PM_DB_PATH or default data/spike.db)
pnpm --filter @pm/daemon dev          # start the daemon (127.0.0.1:8787)
```

Env: `PM_DB_PATH` (DB file), `PM_PORT` (default 8787), `PM_ENGINE` (`runar` default | `scrypt`), `PM_NETWORK`
(runar: `mainnet`|`testnet`; scrypt: `mainnet`|`local`). The funding key lives only in the git-ignored `.env`
(`PM_FUNDING_WIF`) and is read **only** by the authorize path — never returned, logged, or stored. The server
binds `127.0.0.1` only.

**Engine swap:** the same API/queue drives either contract toolchain behind the `ChainEngine` seam. `PM_ENGINE=scrypt`
loads the sCrypt engine (`packages/contracts-scrypt`, built to `dist/` — run `npm --prefix packages/contracts-scrypt
run build` first); `PM_NETWORK=local` runs it offline (DummyProvider). Example — the full lifecycle over curl on
sCrypt: `create → deploy → buy → resolve → redeem`, each `POST …` then `POST /broadcasts/:id/authorize`.

## Security model (Golden Rule 6 / ADR-010)

- **Read + enqueue** never touch the private key. Building a `TxPlan` is pure (LMSR math + an unsigned
  descriptor with **no key material**).
- **`POST /broadcasts/:id/authorize`** is the *only* place the WIF is used — the engine rebuilds, signs, and
  broadcasts, then the DB effects apply atomically. This is your wallet gate.
- The daemon may derive the **public** funding address/pubkey from the WIF in-memory (for balance reads and
  market provenance); the key itself never leaves the engine.

## Endpoints

Base URL `http://127.0.0.1:8787`. All bodies + responses are JSON.

### Markets

| Method | Path | Body / query | Description |
|---|---|---|---|
| `POST` | `/markets` | `{question, bUnits, payoutUnit?, description?}` | Create a market (off-chain until deployed). |
| `GET` | `/markets` | — | List all markets (each with prices, positions, current pool). |
| `GET` | `/markets/:id` | — | One market: params, opening/live prices, net positions, current pool state. |
| `GET` | `/markets/:id/quote` | `?side=yes|no&shares=N` | Pure LMSR quote — buy charge, sell proceeds, prices. No chain, no queue. |
| `GET` | `/markets/:id/positions` | — | Net YES/NO shares + net cost from the trades ledger. |

### Trading (enqueue → sign-off queue)

Each returns `{broadcast_id, status:"pending", kind, summary, spend_sats}`. Nothing broadcasts yet.

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/markets/:id/deploy` | — | Deploy the pool UTXO (v0). |
| `POST` | `/markets/:id/buy` | `{side, shares?}` | Buy `shares` (1..100) — state-only (no on-chain token; position tracked in the trades ledger). |
| `POST` | `/markets/:id/sell` | `{side, shares?}` | Sell `shares` (1..100) back to the pool. |
| `POST` | `/markets/:id/resolve` | `{outcome}` | Resolve via the mock Rabin oracle (verified on-chain). |
| `POST` | `/markets/:id/redeem` | `{side, shares?}` | **501 under Rúnar** — winner payout needs `addRawOutput`/multi-input (BUG-005); unblocked by Phase 2. |

### Sign-off queue + wallet

| Method | Path | Description |
|---|---|---|
| `GET` | `/broadcasts` (`?status=pending`) | List queued/decided broadcasts. |
| `GET` | `/broadcasts/:id` | One broadcast. |
| `POST` | `/broadcasts/:id/authorize` | **The wallet gate.** Sign + broadcast, apply effects, advance the pool lineage. Returns `{txid, pool_version}`. |
| `POST` | `/broadcasts/:id/reject` | Drop a pending broadcast. |
| `GET` | `/wallet/balance` | Funding address + confirmed balance (live WhatsOnChain read). |
| `GET` | `/health` | Liveness. |

## A full autonomous loop (curl)

```bash
B=http://127.0.0.1:8787
curl -s -X POST $B/markets -d '{"question":"Will X happen?","bUnits":1000}'   # → market 1
curl -s "$B/markets/1/quote?side=yes&shares=10"                               # price it
D=$(curl -s -X POST $B/markets/1/deploy | jq -r .broadcast_id)                # enqueue deploy
curl -s -X POST $B/broadcasts/$D/authorize                                    # YOU authorize → txid
curl -s -X POST $B/markets/1/buy   -d '{"side":"yes","shares":3}'             # enqueue buy 3
# ...authorize it, then:
curl -s $B/markets/1/positions                                               # net YES = 3
curl -s -X POST $B/markets/1/resolve -d '{"outcome":"yes"}'                   # enqueue resolve → authorize
```

## Engine limits under Rúnar (the Phase-2 boundary)

The Rúnar engine supports the runar-sdk-broadcastable paths: **deploy, buy (state-only), sell, resolve**.

- **Token-mint buy** and **redeem** → `501 engine_limitation` (runar-sdk BUG-005 can't build
  `addRawOutput`/multi-input txs). The full mint→resolve→redeem lifecycle is VM-proven; on-chain it returns
  with **sCrypt** (Phase 2, same API).
- **Multi-share (N>1) buy/sell** authorizes a 0-conf **chain** of N unit-txs via a client-side overlay
  (`ChainingProvider`) that threads each tx's pool + change outputs to the next — a workaround for runar-sdk
  **BUG-003**. The DB records one aggregate trade + the final pool head; intermediates are transient. The
  quote/position/DB paths are unit-tested; the live multi-tx chain awaits a gated mainnet run to confirm.

## Design

Three layers, one seam (see `docs/ARCHITECTURE.md`): `http.ts` (router, 127.0.0.1) → `service.ts`
(`MarketService`, HTTP-agnostic orchestration + the sign-off queue) → `ChainEngine` (`@pm/engine`). The DB
(`@pm/persistence`) holds markets, the `pool_utxos` full-state lineage, the trades ledger, and the
`broadcasts` queue. LMSR math is the pure `@pm/lmsr` ground truth. Decisions: ADR-015 (API-as-seam + queue),
ADR-016 (pool state in DB + plain buy).
