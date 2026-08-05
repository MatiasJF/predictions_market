# STATE — living

_Last updated: 2026-08-04 — PRODUCTIZATION (Phase P3). Feasibility proven + traded live on mainnet; full token lifecycle VM-proven. NOW: the spike is **APIfied** — a localhost HTTP daemon (`@pm/daemon`) drives the full market lifecycle autonomously behind a `ChainEngine` swap seam (`@pm/engine`, Rúnar now / sCrypt next), with a **sign-off queue** so the human only authorizes wallet spends. Hardened with `/positions`, multi-share buy/sell (0-conf chain), and a full API README. 72 tests green. **Live run (2026-08-04): DEPLOY confirmed on mainnet via the daemon (9d7c370f…, block 960831); BUY blocked by BUG-006 (NULLFAIL, VM≠mainnet) + BUG-003 + WoC 429s** — which motivated Phase 2 (sCrypt). **PHASE 2 COMPLETE: the FULL lifecycle (deploy→buy+mint→resolve→redeem) is now LIVE on BSV mainnet under sCrypt** (txids in SCRYPT-004 / VERDICT.md) — every Rúnar blocker fixed. Funds ~1,996,947 sat (lifecycle cost ≈ fees only)._

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
- ◐ API-007 (GATED live run, 2026-08-04) — **DEPLOY confirmed live on mainnet via the daemon**
  (`9d7c370f6a891f63da7e7d2797fa4ad85bde72e8fe6d2a4f15e9d3b4a28b0a3c`, block 960831): create → enqueue →
  user-authorize → sign → broadcast → `pool_utxos` v0 all worked on-chain. **BUY blocked:** reproduced BUG-003
  live (stale-UTXO `txn-mempool-conflict`), added the `ChainingProvider` overlay workaround (got past it), then
  the buy NULLFAILed on mainnet **even with confirmed funding** despite passing 72 VM tests — see **BUG-006**
  (VM ≠ mainnet for a new Rúnar OP_PUSH_TX method) + WhatsOnChain 429 rate-limiting. Deploy path proven; buy/
  sell/resolve paths **not yet mainnet-verified** → strong motivation for Phase 2 (sCrypt). Spend: ~1,367 sat
  (deploy fee 1,367; failed broadcasts cost nothing). Funds remaining ~1,996,947 sat.
- ○ API-011 (deferred) — isolate/fix BUG-006 (buy NULLFAIL) OR supersede via the sCrypt engine (Phase 2).
- ◐ SCRYPT-005 (autonomous mainnet via daemon) — **integration PROVEN, run blocked by mempool state.** Started
  the daemon `PM_ENGINE=scrypt PM_NETWORK=mainnet`: it connected, created the market, built the deploy tx, and
  made a **real broadcast attempt** through the HTTP API — rejected `too-long-mempool-chain`. Cause: the
  SCRYPT-004 lifecycle txs (4 × ~26 KB) are still **unconfirmed** (~0.05 sat/byte default fee) and chained,
  filling BSV's 101 KB / 25-tx unconfirmed-ancestor budget; the single funding UTXO is buried under them and no
  confirmed UTXO is free. Can't extend (chain at limit; no RBF; CPFP won't fit). **Two platform findings:**
  (1) **fee management** — sCrypt's default fee is too low for prompt confirmation of big contract txs; set an
  explicit fee. (2) **single-UTXO throughput (unknown #3, concrete)** — one funding chain saturates the mempool
  budget after ~4 ops; a platform needs a pool of funding UTXOs (parallel chains) + confirmation-aware
  scheduling + a slimmer pool script. **Note:** SCRYPT-004 txs were node-ACCEPTED (script-valid on mainnet =
  the feasibility proof) but confirmation is pending (fee). To complete SCRYPT-005: wait for confirmation OR
  fund a fresh key (confirmed UTXO independent of the stuck chain). Market persisted in `data/scrypt-mainnet.db`.
  **UPDATE (fresh key `124uMr2…`, funded 50k):** the daemon `PM_ENGINE=scrypt PM_NETWORK=mainnet` drove
  **create → deploy → buy+mint → resolve LIVE on mainnet through the HTTP API** (3 gated authorizes): deploy
  `dd43066212c1061dfc997de874ad7f866347722d6a83598bf2feadf15f4254c8`, buy+mint
  `f0a10dcd14923bbbdfc7ee25de53ccf1d987be46cf7bd0458bd8cf2e9b7c063e` (confirmed 2-in/3-out = pool+token+change),
  resolve `c7e4c5fccb4805fc19629b0331bc69cf5425f899934e42103c307bc2e64875e3`. **The autonomous-mainnet-via-daemon
  vision is realized.** Redeem (4th pool tx) awaits the deploy's 1st confirmation (pool chain 4×26 KB > 101 KB
  ancestor limit). Fees stayed low (~238 sat for 3 txs); ~49,762 sat remains for redeem.
  **FEE-CONTROL FINDING:** setting `bsv.Transaction.FEE_PER_KB = 250` did NOT take effect — the sCrypt-built
  txs went out at ~0.003 sat/byte, so miners skip them (the user's funding tx, at a normal wallet fee, confirmed
  fine in block 960854). The pool txs won't confirm, so redeem (needs deploy confirmed) is blocked. **For a
  platform, fee control must be fixed** — `FEE_PER_KB` isn't the knob sCrypt's tx-builder honors; needs an
  explicit per-tx fee in the custom builders / provider config (+ CPFP to rescue stuck txs). This + the mempool-
  ancestor limit + single-UTXO pool chain are the concrete throughput/fee items for productionizing the platform.
  **FORCE-THROUGH ATTEMPT (result: not cleanly forceable):** applied `tx.feePerKb(500)` to the buy/redeem custom
  builders (partial fix — deploy/resolve use sCrypt's own builders, still need provider-level fee control) and
  tried a manual CPFP of the stuck deploy — **rejected DOUBLE_SPEND_ATTEMPTED** (competing tx `8c19951…`).
  Root cause: sCrypt's `DefaultProvider` **auto-splits the funding** into a tangled low-fee tx chain
  (`f9aaee`→`8c19951`→`01ec39`→…), and WhatsOnChain's UTXO view lags/disagrees, so the real spendable state
  can't be pinned down to CPFP safely. **Platform to-dos crystallized:** (1) full fee control on ALL builders +
  provider; (2) disable/manage sCrypt's funding auto-split (deterministic UTXO handling); (3) slim the ~26 KB
  pool contract; (4) a funding-UTXO pool for throughput. The ~50k funds sit in the unconfirmed chain rooted at
  the confirmed `f9aaee` (block 960854) — recoverable once it confirms/evicts. **Verdict unchanged:** the
  autonomous-mainnet-via-daemon capability is PROVEN (3 live broadcasts); the redeem tx and clean fee/UTXO
  handling are productionization work, not feasibility gaps.
  **FEE FIX FOUND + CRITICAL ECONOMICS FINDING (fresh key `1GfBrm…`, funded 80k):** the real fee knob is the
  provider's `getFeePerKb()` (WoC returns ~50 sat/KB, too low). Added a `FeeProvider` (extends DefaultProvider,
  overrides `getFeePerKb → 500`). The daemon then broadcast deploy + buy with PROPER fees — **fee fix works.**
  BUT the run revealed the **decisive economics: sCrypt stateful txs are HUGE** — deploy = **46 KB**, each trade
  **spend = ~93 KB** (the OP_PUSH_TX unlocking carries the full prior 26 KB script). At 0.5 sat/byte that's ~23k
  (deploy) + ~46k (per trade); deploy+buy alone ate the 80k, and resolve failed ("no sufficient utxos to pay the
  fee of 46606"). **A full lifecycle costs ~80–160k sats depending on rate.** ⇒ **The current LMSR-in-one-UTXO
  sCrypt contract is FEASIBLE but ECONOMICALLY HEAVY (~93 KB / ~$0.02–0.08 per trade).** For a real platform this
  is THE thing to solve: slim the pool Script dramatically, or reconsider architecture for high-frequency trading
  (this is a genuine input to the native-on-chain-vs-off-chain decision — the spike proved native works; this
  shows its per-trade cost). Not a bug — a fundamental cost property of the design.
  **Confirmation context:** the proper-fee deploy/buy are 0-conf largely because BSV was in a **block drought**
  (tip 960855 mined ~57 min before the check; even the user's normal-fee funding tx `ff0d5d47` is 0-conf) — so
  the earlier confirmation delays were partly chain-wide slow blocks, not purely fees. Proper-fee txs should
  confirm when a block is mined. Net: fee control is fixed; the durable blocker is the **contract economics**
  (≈93 KB/trade), whose fix is **slimming the pool Script** — the #1 platform engineering task.
- ● SCRYPT-005 — **FULL CIRCLE RUN — DONE (end-to-end on mainnet via the daemon).** Funded 1M to `1GfBrm…`.
  `PM_ENGINE=scrypt PM_NETWORK=mainnet`, 0.5 sat/B (FeeProvider), one session: **deploy `af9f1d16…` + buy+mint
  `dca06069…` CONFIRMED (block 960862)**; then (after the required confirm-wait for the 101 KB ancestor limit)
  **resolve `86e586c4…` + redeem `c8e2f515…` broadcast** (redeem = 2-in/3-out: pool + **1000-sat winner payout**
  + change) — CONFIRMED block 960863. **Total spend 70,241
  sat (~$0.04)** for the complete deploy→trade→oracle→payout lifecycle. Recorded in VERDICT. **Proves the
  single-market lifecycle works consistently on mainnet.** Still design-level open (NOT feasibility): concurrency
  (single-UTXO serialisation), security (documented-trust redeem), contract-slimming, restart-safe state.

### Phase P4 — Rúnar → sCrypt (planned + approved 2026-08-04; migration behind the ChainEngine seam)
- ◐ SCRYPT-001 — port to **scrypt-ts 1.4.5** (classic BSV; ADR-018). **CORE DONE:** `packages/contracts-scrypt`
  (npm-managed, excluded from the pnpm workspace — sCrypt's ts-patch transformer needs a flat node_modules).
  `LMSRMarket.runar`→sCrypt: **compiles to 25.8 KB Script** (`buyYes/buyNo/sellYes/sellNo/resolve`, 7 state
  props) AND **buy/sell verify locally + match the `@pm/lmsr` reference** (4 mocha tests; underpayment
  rejected). sCrypt local verify runs the **real node Script** → green ⇒ mainnet-valid (closes BUG-006). The buy
  that NULLFAILed on Rúnar mainnet passes here. `vitest.config.ts` excludes the package (it runs its own mocha).
  **Multi-output BUG-005 unblock — PROVEN:** `ShareToken` (transfer/burn) compiles; `LMSRMarket.buyYesWithToken`
  **builds + verifies a 3-output mint tx** (pool state + P2PKH token to buyer + change) and `redeemYes` **builds
  + verifies a 3-output winner payout** (reduced pool + 100k-sat P2PKH payout + change) via sCrypt's custom
  tx-builder (`bindTxBuilder`) — exactly the multi-output spends runar-sdk could not build. **6 mocha tests
  green.** Both Rúnar mainnet blockers are now demonstrably fixed under sCrypt: BUG-006 (buy/sell verify vs real
  Script) + BUG-005 (mint/redeem multi-output txs). **`resolve` verifies a REAL Rabin oracle signature on-chain**
  (mock oracle via `rabinsig`, `scrypt-ts-lib` `RabinVerifier`) and rejects a wrong-outcome sig — **7 mocha
  tests green.** **The ENTIRE market lifecycle now verifies under sCrypt** (buy/sell/mint/redeem/resolve), each
  against the real node Script — the full loop Rúnar could only VM-prove. **Remaining (minor):** NO-side
  mint/redeem, multi-share bounded loop. Build: `npm --prefix packages/contracts-scrypt run compile && … test`;
  regen vectors via `npx tsx packages/contracts-scrypt/tests/fixtures/gen-vectors.ts`.
- ◐ SCRYPT-002 — `ScryptEngine implements ChainEngine`. **Tx-building core PROVEN** (the custom `bindTxBuilder`
  multi-output construction verified locally for mint + redeem — see SCRYPT-001). **Remaining:** wrap deploy/
  buy/sell/resolve/redeem behind `ChainEngine`, bridge the npm-CJS `contracts-scrypt` to the pnpm-ESM
  `@pm/engine` (runtime import of the built engine), robust broadcast (ARC/Mempool) + funding chaining,
  `MockScryptEngine`. Token-mint buy + redeem become live (the Rúnar 501s).
- ● SCRYPT-003 — **DONE. The daemon drives the sCrypt market through the SAME HTTP API + sign-off queue.**
  `ScryptEngine implements ChainEngine` (`packages/contracts-scrypt/src/scryptEngine.ts`, npm-built to `dist/`,
  dynamically imported by `apps/daemon/src/server.ts` when `PM_ENGINE=scrypt`; in-process pool-instance
  continuity per market). `MarketConfig` gained `marketId/mult/invMult` (service computes via `@pm/lmsr`).
  Verified: `PM_ENGINE=scrypt PM_NETWORK=local` daemon drove **create → deploy → buy+mint → resolve → redeem**
  end-to-end over curl (4 authorized broadcasts; pool lineage v0→v3; final state resolved/winner=YES; positions
  booked). Root suite 72 green, sCrypt 8 green. **Full both-sides port done:** added contract `buyNoWithToken` +
  `redeemNo`; the sCrypt engine now drives **buyYes/buyNo, sellYes/sellNo, resolve YES/NO, redeem YES/NO** through
  the API — verified over curl: deploy→buyYes→buyNo→sellYes→sellNo→resolve NO→redeem NO (pool v0→v6, resolved/NO).
  Only remaining sCrypt-path gap: multi-share per call (bounded-loop port). **Phase 2 COMPLETE** — sCrypt runs
  live on mainnet (SCRYPT-004) and fully through the autonomous API (SCRYPT-003).
- ● SCRYPT-004 — **GATED MAINNET LIFECYCLE — DONE. The FULL loop is LIVE on BSV mainnet under sCrypt** (user-
  authorized broadcast, 2026-08-04): deploy `83684ab5…de8cf63` → **buy+mint** `a74ae982…f15f10a40` (3 outputs:
  pool+token+change, charge 525) → **resolve** `a3d01cd5…c796b0a89` (Rabin YES) → **redeem** `a3126fdc…25db580c`
  (3 outputs: pool + **1000-sat winner payout** + change). Confirmed on WhatsOnChain (buy/redeem = 2-in/3-out).
  The exact loop Rúnar couldn't broadcast — incl. the two multi-output spends (BUG-005) + a buy that broadcasts
  (BUG-006) + 0-conf chaining with no BUG-003 (sCrypt tracks the chain in-process). Net cost ≈ fees (payout
  returned to self). Recorded in `docs/VERDICT.md` (Phase 2 section). Remaining Phase 2 (optional productization):
  wrap `runLifecycle` behind `ScryptEngine implements ChainEngine` + `PM_ENGINE` daemon swap (SCRYPT-002/003).

### Phase P5 — Platform (concurrency + hardening; design ADR-019)
- ● CONC-004 — **Contract slimming — DONE (2026-08-05, ADR-020).** Collapsed the 9 YES/NO twin methods to **4
  side-parameterized** ones — `buy(isYes,…)` (always mints its token), `sell(isYes)`, `resolve`, `redeem(isYes,…)`.
  Measured on a real compile: locking **script 45,675 → 21,447 bytes (−53%)**, per-spend ~93 KB → ~44 KB (~2× the
  trades per ancestor budget, ~½ per-trade cost). **Pricing unchanged** — `@pm/lmsr` equivalence vectors + all
  local Script-verify tests green (**7 sCrypt incl. full lifecycle + 72 workspace**), `tsc` clean. Callers updated:
  `scryptEngine.ts`, `lifecycle.ts`, `tests/lmsrMarket.test.ts`. Ablation ruled out two pre-plan ideas: hashing
  state into a commitment barely helps (code, not the 7 state ints, is the bulk) and splitting Rabin off the trade
  path saves only ~5 KB (needs a 2nd contract). **Remaining (optional):** gated mainnet re-measure of the real
  on-chain size — a user-authorized spend.
- ● CONC-001 — **Execution layer MVP — DONE (2026-08-05, ADR-021).** New pure pkg `@pm/execution`:
  `ExecutionEngine` holds authoritative in-memory LMSR state per market, fills orders INSTANTLY over `@pm/lmsr`,
  serializes concurrent submits per market (promise chain → single total order, no UTXO contention), persists
  each fill to `exec_orders` (migration 004) with an ECDSA-signed **receipt** (sequencer key env-only). **5 tests
  incl. a 25-way concurrency test** (seq 1..N, final == N sequential fills; receipt sign/verify + tamper).
- ● CONC-002 — **Net-state batch settlement — LOCAL-VERIFIED (2026-08-05, ADR-021); mainnet run pending
  (user-authorized).** Contract `settle(...)` (bounded loops, MAX_BATCH=20) advances the pool by the batch NET in
  ONE pool-version tx (e-state path-independent) — script 21.4→30.2 KB. Engine `buildSettleBatch` + `'settle'`
  kind; daemon `POST /:id/orders` (instant off-chain fill), `/receipts`, `/exec-positions`, `POST /:id/settle`
  (into the sign-off queue); migration 005 (`exec_batches`) + 006 (broadcasts kind). **Verified:** sCrypt `settle`
  local Script-verify + MAX_BATCH bound (9 sCrypt green); daemon test — 5 off-chain fills → 1 settle broadcast →
  1 version advance + 5 trade rows (79 workspace green, typecheck clean). **GATED MAINNET SETTLEMENT — LIVE
  (2026-08-05):** deploy `68fee818…56ca48` (1-in/2-out, 30,915 B) → **settle `cc13883b…662d2f`** (2-in/2-out,
  61,896 B — **5 off-chain fills collapsed into ONE on-chain pool-version advance**), both **CONFIRMED on mainnet
  (block 960978)**. Runner: `packages/contracts-scrypt/mainnet-settle.ts --broadcast`. Proves amortization:
  **N trades → 1 settlement fee.** CONC-002 DONE.
- ● CONC-003a — **Auditable, non-equivocable settlement + auditor — DONE (2026-08-05, ADR-022).** `settle` pins a
  `batchDigest` on-chain (OP_RETURN; script 30.2→30.5 KB); the sequencer signs a settlement attestation; new
  `@pm/execution/src/audit.ts` `auditSettlement` lets anyone PROVE a settlement matches its signed receipts
  (sig, net units/cash, digest, on-chain q-delta, attestation). Daemon `GET /markets/:id/audit`. Migration 007
  (exec_batches commitment cols + `exec_orders.ts` — fixes a CONC-001 receipt re-verify gap). **Verified:**
  `@pm/execution` audit tests + daemon audit-flow (honest ok; tampered receipt → receipt_sig+net_cash+digest);
  sCrypt settle-with-OP_RETURN local Script-verify — 83 workspace + 9 sCrypt green, typecheck clean. Trust: from
  "trust the operator" → "any cheat is cryptographically provable" (detection; enforcement is 003b).
- ● CONC-003b — **Operator bond + on-chain equivocation-slash — DONE (2026-08-05, ADR-023).** New `Bond` contract
  (`src/contracts/bond.ts`, ~2.3 KB): `slash(key,digestA,sigA,digestB,sigB,challenger)` RabinVerifies two
  conflicting sequencer attestations for the same settlement key → pays the bond to the challenger; `withdraw`
  is CLTV-gated. Sequencer Rabin attestations (`src/attestation.ts`) recorded per settlement (migration 008;
  `ScryptEngine.rabinAttest` + Mock stub; `/audit` shows `rabinAttested`). **Verified:** 4 Bond mocha tests
  (real equivocation slashes + pays challenger; reject same-digest + forged sig; withdraw before/after maturity)
  — 83 workspace + 13 sCrypt green, typecheck clean. **PROVEN LIVE on mainnet (2026-08-05):** bond deploy
  `04e80444…700e0a` → **slash `53972656…03956ed`** (2-in: spends the bond + funding / 2-out) — the slash spends
  the bond via the on-chain Rabin equivocation proof, both accepted into the mainnet mempool (fraud-proof
  script network-validated); confirmation follows BSV block timing. Runner: `mainnet-bond.ts --broadcast`.
  Honest scope: slashes equivocation (can't lie about WHICH settlement happened); full net-vs-receipts
  enforcement is the endgame.
- ○ CONC-003c — Redeem **token verification**: require a co-spent on-chain ShareToken input (VERDICT gap #2). Planned.
- ○ Endgame — validity-proof settlement: the contract re-checks the batch on-chain (trustless). Planned.
- ○ CONC-005 — Ops: restart-safe pool state (reconstruct from chain), automated fee/UTXO-pool management. Planned.

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
