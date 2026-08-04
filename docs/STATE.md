# STATE — living

_Last updated: 2026-08-04 — PRODUCTIZATION (Phase P3). Feasibility proven + traded live on mainnet; full token lifecycle VM-proven. NOW: the spike is **APIfied** — a localhost HTTP daemon (`@pm/daemon`) drives the full market lifecycle autonomously behind a `ChainEngine` swap seam (`@pm/engine`, Rúnar now / sCrypt next), with a **sign-off queue** so the human only authorizes wallet spends. Hardened with `/positions`, multi-share buy/sell (0-conf chain), and a full API README. 72 tests green. Mainnet token-tx demo still blocked by runar-sdk BUG-005 (→ Phase 2 sCrypt)._

## Current phase
**FEASIBILITY PROVEN — all six unknowns resolved.** The native on-chain UTXO LMSR prediction market is
**buildable, deployable, and tradeable on BSV mainnet**: contract compiles to Script (Rúnar); buy/sell/oracle
logic verified in-VM (51 tests) + adversarially reviewed; and both a **deploy and a live LMSR buy are
confirmed on mainnet** (deploy `ddbb0b36…`, buy `7106f762…`), fees negligible (176-sat deploy, 510-sat buy).
**Remaining work is productization, not feasibility:** collateral↔UTXO-sats binding (`extractAmount`),
funding-UTXO chaining for rapid sequential trades (BUG-003), YES/NO tokens + withdraw/redeem (TOKEN-001).
**Project stopping point (all committed, KB in sync).** Feasibility fully proven and demonstrated live on
mainnet; the entire product lifecycle including tokens is built and VM-proven. The only remaining gap is a
mainnet *demonstration* of the token-carrying transactions, blocked by runar-sdk **BUG-005** (no
`addRawOutput` tx building) — best unblocked by fixing the SDK upstream, then running the already-built
lifecycle on mainnet. **Deliverable: `docs/VERDICT.md`.** Funds: ~1,998,314 sats sweepable at
`1DpDhuNAP3Cdga1GWM37WugVZ3h1edGQ72`.

## The mission in one line
Prove whether a native on-chain UTXO LMSR prediction market is feasible on BSV via Rúnar, or find the
wall. Deliverable = a written verdict on the six unknowns (see ROADMAP.md) backed by working code.

## Task board
Status: ○ todo · ◐ doing · ● done · ⨯ blocked. IDs are `AREA-nnn`, flat per-area (do not reset by phase).

### Phase P0 — Foundation
- ● OPS-001 — Scaffold KB: `CLAUDE.md` + `docs/{STATE,INDEX,DECISIONS,ARCHITECTURE,SCHEMA,ROADMAP,GLOSSARY}.md`.
- ● OPS-002 — pnpm monorepo skeleton: workspace, `tsconfig.base.json`, package stubs, `.gitignore`, `.env.example`.
- ● RESEARCH-001 — Verify Rúnar is real & capable. Result: real BSVA compiler; **no exp/log/loops** → drives ADR-002/007.
- ● DB-001 — SQLite data model + migration `001_init.sql` + migration runner. Verified by applying via `sqlite3` CLI.
- ● OPS-003 — Initial git commit.

### Phase P1 — Feasibility core (LMSR math + toolchain gate)
- ● LMSR-001 — Pure integer LMSR reference in `@pm/lmsr` (`fixed.ts` exp/ln, `lmsr.ts` price/cost/state/
  buy+sell, multiplicative-state). **29 Vitest tests green**, typecheck clean. Verified by 3 adversarial
  agents: math correct (max rel err ~9e-13), satoshi-safe (real pool ≥ liability to 1M trades), and
  test-quality findings all closed (sell implemented + tested, NO-side/non-unit/strict-price-discovery
  coverage added). See ADR-008. Files: `packages/lmsr/src/{fixed,lmsr,index}.ts`, `.../test/{fixed,lmsr}.test.ts`.
- ● LMSR-002 — On-chain cost-without-`ln` solved. `buyChargeApproxSats`/`sellPayoutApproxSats` in `@pm/lmsr`
  price at the post-trade marginal price (right-Riemann bound): buys round up / sells round down → MM-safe.
  4 tests over a b×side×skew grid confirm the safe direction + error bound (≤0.13% of notional at Δ/b=1e-2).
  ADR-011; resolves Open Q1. Files: `packages/lmsr/src/lmsr.ts`, `packages/lmsr/test/cost-approx.test.ts`.
- ● CONTRACT-001 — Rúnar toolchain gate. **Re-scoped to OFFLINE** (the real unknown was "does Rúnar compile
  +run a stateful contract", not "can we broadcast"): `Counter.runar.ts` compiles to 148 bytes of Script and
  executes 0→1→2 via `runar-testing`'s VM. 2 tests green. Gate met → no scrypt-ts fallback. See ADR-009.
  Files: `packages/contracts/src/Counter.runar.ts`, `packages/contracts/test/counter.gate.test.ts`.
- ● CONTRACT-002 — `LMSRMarket.buyYes/buyNo` in Rúnar: multiplicative update (`mulDiv`) + MM-safe ceil charge
  (`safediv`), state continued via `addOutput`. Compiles to 466 B; 5 tests: output state == `@pm/lmsr`
  reference across skewed states + both sides, exact-charge boundary, underpayment rejected, and a 60-step
  feedback-loop lockstep. **Adversarially verified** (charge ≡ reference via 120-step run; all 6 mutations
  caught). ADR-012. Files: `packages/contracts/src/LMSRMarket.runar.ts`, `.../test/lmsr-market.test.ts`.
  **Caveats (→ DEPLOY-001):** collateral is STATE not real UTXO sats; `outputSatoshis` unconstrained; single
  output (buyer change/token mint = P2); interpreter ≠ mainnet.

### Phase P2 — On-chain lifecycle
- ● CONTRACT-003 — sell path in Rúnar. `LMSRMarket.sellYes/sellNo`: inverse multiplicative update
  (`mulDiv` by readonly `invMult` = exp(−unit/b)·scale, to match the reference's rounding exactly), MM-safe
  floor proceeds (`safediv`, no +sum−1), guard `q ≥ unit`, `collateral −= proceeds`. 4 tests: output ==
  `@pm/lmsr` reference (both sides), empty-position guard rejects, and buy→sell round-trip leaves the pool
  collateral ≥ start (spread favours the pool). 44 tests total. **Caveat:** ownership check (burning the
  seller's token) is TOKEN-001; same offline-VM/real-sats deferral as buy.
- ◐ TOKEN-001 — YES/NO share tokens (`runar-lang/tokens` FungibleToken). Split:
  - ● **001a DONE:** `ShareToken` (direct `StatefulSmartContract`; mutable supply/holder + readonly
    marketId/side; transfer/split). 5 VM tests (transfer, split, holder-auth reject, over-split reject).
    Couldn't extend the base `FungibleToken` — BUG-004. File: `packages/contracts/src/ShareToken.runar.ts`.
  - ● **001b DONE (VM):** `buyYes`/`buyNo` mint a ShareToken to the buyer via `addRawOutput` — the pool holds
    the token code template (`tokenCodeYes`/`tokenCodeNo`, code part + OP_RETURN, market/side baked in) and
    appends `num2bin(1,8) ‖ buyerPubKey` on-chain. VM-verified: output 1 is a correct ShareToken
    (`tokenCodeYes ‖ supply=1 ‖ holder`). 3 mint tests; existing 15 buy/sell tests updated + green (59 total).
    Tooling (`market.ts`) computes the token codes + 16-arg constructor. **Not yet on mainnet** (needs manual
    multi-output tx build — the SDK's `call()` doesn't emit a foreign-contract output).
  - ● **001c DONE (VM):** `ShareToken.burn` (holder consumes the token) + `LMSRMarket.redeem(supply, holder,
    side, poolOutSats)` — when resolved and `side==winner`, pays `supply×payoutUnit` (P2PKH built as
    `76a914‖hash160(holder)‖88ac`) and reduces collateral. 3 redeem tests (pays winner, pre-resolution reject,
    losing-side reject) + burn compiles. Documented **trust gap**: pool trusts the supplied supply/holder/side
    (production needs SPV/pushdata token verification). Multi-input token+pool combo → verified on mainnet (001d).
  - ⨯ **001d (mainnet) — BLOCKED by BUG-005.** `prepareCall`/`call` don't build `addRawOutput` outputs, so the
    SDK can't construct the token-minting buy (proven offline: `prepared.tx.outputs` = [pool, change], no
    token; `apps/spike/src/diag-mint.ts`). Demonstrating mint/redeem on mainnet needs fully hand-built
    multi-output (mint) + multi-input (redeem) OP_PUSH_TX transactions — a substantial standalone tx-engineering
    effort (replicating the SDK's unlocking assembly). Full lifecycle is VM-proven (11 tests); mainnet demo deferred.
- ● SETTLE-001 — Oracle resolution via Rabin signature. `LMSRMarket.resolve(sig, padding, outcome, ...)`
  verifies `verifyRabinSig(cat(marketTag, outcome), sig, padding, oracleN)` and flips the pool to
  `resolved`/`winner`; buy/sell now `assert(resolved==0)`. 6 tests (valid YES/NO, forged rejected,
  wrong-outcome rejected, trading disabled after resolve, no double-resolve). Resolves unknown #5. ADR-013.
  **Winner redemption** (burn winning token for 100k) deferred to TOKEN-001.
- ◐ DEPLOY-001 — first real deploy of the pool UTXO. Split (ADR-014):
  - ● **001a (offline) DONE:** `apps/spike` deploy+buy tooling on `runar-sdk`; dry-run through `MockProvider`
    builds the real txs. **Measured tx sizes → fee/trade (#6):** deploy ≈ **1,751 B** (~88 sat @0.05/B),
    buy ≈ **5,100 B** (~255 sat @0.05/B; ~5,100 sat @1/B) — dominated by the OP_PUSH_TX preimage + stateful
    continuation. Buy sizes are stable across trades. Files: `apps/spike/src/{market,measure,dry-run}.ts`,
    `apps/spike/test/deploy.test.ts`. Verified (51 tests). `pnpm --filter @pm/spike dry-run` prints the table.
  - ● **001b (mainnet) — DONE. Pool DEPLOYED and TRADED live on BSV mainnet.** Funded 0.02 BSV to
    `1DpDhuNAP3Cdga1GWM37WugVZ3h1edGQ72`.
    - Deploy: `ddbb0b368ac54716001ae9cc32fdabfb23548fed31ccb0b3d1232754c16dca88:0` — full LMSR 5-branch
      script on-chain; **fee 176 sat** (1750 B, ~0.1 sat/B).
    - **First live LMSR buy (spend):** `7106f762debd93995661d08333ea45813f9b699c523c014d8b2d496b39ac2ed6` —
      spent the pool UTXO via OP_PUSH_TX, minted the new pool UTXO with advanced state (qYes=1 unit); **fee
      510 sat** (5096 B). **Answers #2 (single-UTXO spend works) and #6 (real fee) on mainnet.**
    - Root cause of the earlier failures: `WhatsOnChainProvider.getUtxos()` returns empty `.script` → wrong
      funding sighash (BUG-001). The OP_PUSH_TX contract input was correct all along (BUG-002 RETRACTED —
      proven via `@bsv/sdk` local `Spend`). Sequential 0-conf trades need funding-UTXO chaining (BUG-003).
      See `docs/Runar-bugs.md`.
    - Tooling: `apps/spike/src/{keygen,bsv-signer,env,mainnet,measure,diag-oppushtx}.ts`. Pool state chains in
      `apps/spike/data/pool.json` (current head `7106f762…:0`). Change ~1,998,314 sats sweepable at the funding address.
    - Still owed for production (not feasibility): collateral↔UTXO-sats binding (`extractAmount`), funding-UTXO
      chaining for rapid trades, withdraw/redeem path (TOKEN-001).
- ○ OPS-004 (planned) — Mainnet proof run (gated) + feasibility verdict report on all six unknowns.

### Phase P3 — Productization: the autonomous API (ADR-015/016)
- ● API-001 — Sign-off queue + pool-state schema. Migrations `002_broadcasts.sql` (queue) + `003_pool_state.sql`
  (`pool_utxos` gains collateral/resolved/winner/locking_script). `BroadcastRow`/`PoolUtxoRow` types synced.
  `pnpm db:migrate` CLI (`packages/persistence/src/migrate-cli.ts`) fixed (was a missing path). Verified: both
  migrations apply into a throwaway DB.
- ● API-002 — `@pm/engine`: the `ChainEngine` swap seam. `RunarEngine` absorbs the proven `mainnet.ts`
  tx-building (deploy via @bsv/sdk; buy/sell/resolve via prepareCall + funding re-sign). Added broadcastable
  `buyYesPlain`/`buyNoPlain` to the contract (single output, no mint — the live-proven shape). token-mint buy +
  redeem throw `EngineLimitation` (BUG-005 → 501). `MockEngine` (no network) for tests. +2 contract VM tests.
- ● API-003 — `@pm/daemon` `MarketService`: HTTP-agnostic orchestration over Db + ChainEngine. create/list/get
  market, pure LMSR quote, enqueue deploy/buy/sell/resolve/redeem, sign-off queue (authorize=only WIF use;
  reject), wallet balance. Applies effects atomically + advances `pool_utxos` lineage. One-pending-per-market.
- ● API-004 — HTTP daemon: Node built-in `http` router bound to **127.0.0.1**, JSON I/O; `server.ts` opens DB +
  migrates + wires RunarEngine. `pnpm --filter @pm/daemon dev`.
- ● API-005 — 6 service tests (temp DB + MockEngine): create→quote→deploy→buy→sell→resolve, queue
  enqueue/authorize/reject, lineage advance, redeem 501. **70 tests total green.** Live curl smoke: health,
  create, quote (10 YES = 501,375 sat), enqueue deploy → pending, wallet balance (live WoC: 1,998,314 sats),
  reject → empty, authorize-rejected → 409. **No mainnet spend** — the queue boundary held (authorize is the gate).
- ● API-006 — KB sync: ADR-015 (API-as-seam + queue) + ADR-016 (pool-state in DB + plain-buy), STATE/INDEX/
  ARCHITECTURE/SCHEMA updated.
- ● API-008 — `/positions`: net YES/NO shares + net cost aggregated from the `trades` ledger; summary folded
  into `GET /markets/:id`. The off-chain position book (documented-trust model). Tested.
- ● API-009 — Multi-share buy/sell (ADR-017): engine loops N unit-steps to the final state (one aggregate
  trade + one pool version jump); `authorizeAndBroadcast` chains N 0-conf txs via `ChainingProvider` (BUG-003
  workaround), capped at 100/call. DB/quote/position paths tested; live chain awaits a gated run. Single-unit
  path unchanged (proven). 72 tests green.
- ● API-010 — `apps/daemon/README.md`: full API reference (every endpoint + curl), run/authorize guide, the
  security model, and the Rúnar engine limits (501s) as the Phase-2 boundary.
- ○ API-007 (next, GATED) — one live authorized mainnet run through the daemon (deploy → plain buy → resolve),
  confirming txids on WhatsOnChain. Needs explicit per-broadcast user authorization.

### Phase P4 — Rúnar → sCrypt (planned; own planning pass)
- ○ SCRYPT-001 — `ScryptEngine implements ChainEngine` + port LMSRMarket/ShareToken/Rabin-oracle to sCrypt;
  token-mint buy + multi-input redeem become live (the Rúnar 501s). Validate against the same `@pm/lmsr` ground
  truth. Detailed plan authored after P3 lands.

## Known issues
- **`better-sqlite3` native binary is now BUILT** (API-001). If a fresh clone hits "Could not locate the
  bindings file", run `npm --prefix node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 run
  build-release` (node-gyp). Note: a machine-level pnpm store move required `pnpm config set store-dir
  ~/Library/pnpm/store/v3 --global` to relink; `pnpm rebuild` silently no-ops, hence the direct node-gyp build.
- The daemon DB defaults to `data/spike.db` (`PM_DB_PATH` overrides). The old `apps/spike/data/pool.json` is
  legacy CLI scratch — the daemon uses `pool_utxos` full-state instead (ADR-016).
- Node is v20.19.5 → no `node:sqlite`; we use `better-sqlite3`. `sqlite3` CLI 3.43.2 is available for schema checks.
- `runar-testing` needs `fast-check` at import time but doesn't declare it; added as a `@pm/contracts` devDep.
- Rúnar is v0.4.6 (pre-1.0) — treat compiler behavior as verify-empirically, not assume.

## Open questions (the crux — feed the feasibility verdict)
1. ~~**Cost without `ln`:**~~ **RESOLVED (ADR-011, LMSR-002):** the contract prices trades at the post-trade
   marginal price (`mulDiv`, no `ln`) — a right-Riemann bound that overcharges buys / underpays sells → MM-safe,
   with error bounded by trade÷liquidity (≤0.13% of notional at Δ/b=1e-2). Design rule: cap Δ/b ≤ ~0.01.
2. **Variable trade sizes without loops:** `exp(k·u/b) = (exp(u/b))^k` needs `k` multiplications, but Rúnar
   forbids unbounded loops. **New candidate:** Rúnar exposes `pow(base, exp)` in Script — `mult^k` in one
   bounded op (fixed-point scaling to be worked out). Test in CONTRACT-002/003. Other options: one unit per
   tx, a small unrolled menu of sizes, or buyer-supplied state verified by a bounded check. **Leaning `pow`.**
3. **Single-UTXO throughput:** every trade spends the one pool UTXO → concurrent trades race. Real
   throughput/UX cost is unmeasured — needs a real-chain ticket (DEPLOY-001). This is why the source roadmap
   went off-chain. Still fully open.
4. ~~**Token standard:**~~ **RESOLVED (ADR-009):** use `runar-lang/tokens` (`FungibleToken`/`NonFungibleToken`)
   for YES/NO tokens, not the docs' vague "BRC-100". Oracle settlement uses **Rabin sigs**
   (`runar-lang/oracle`), cheaper on-chain than ECDSA.

## Decisions needing user input before proceeding
- None for CONTRACT-002 (offline, proceeds on defaults). **DEPLOY-001** (first real **mainnet** spend, ADR-010)
  will need a funding decision: plan is to generate a fresh key locally and surface only the address for the
  user to fund from their own wallet — never accept a pasted private key (Golden Rule 6). Every mainnet
  broadcast is gated behind explicit per-action confirmation.
