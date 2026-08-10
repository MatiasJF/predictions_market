# STATE — living

_Last updated: 2026-08-10 — **THE ROUND TRIP IS CLOSED ON MAINNET** (Phase P6, FUND-001, ADR-043). A trader's
own satoshis funded a bet and came back into their own wallet as spendable balance. Market #7: deploy
`9798adff…` (block 961665) → settle `cddc3a89…` → resolve `a743e25c…` → payout `7c8be780…` (all block 961684),
audit 4 receipts / 0 violations, **28,601 sat total fees — 5× cheaper than the comparable 143,017 sat run** on a
bigger contract. Paid in: `7e6f5874…` 1,002 sat + `2b0748b8…` 1,000 sat. Claimed out: 2,000 sat via
`internalizeAction` from 82,316 B of AtomicBEEF. The pay-once guard also fired on live state. Everything before
this proved the mechanism; this proved a market. **Three defects were found and fixed during the run**
(MAINNET-008/009/010 — all one root cause: a transient condition cached as a permanent verdict). **Sells are now
payable too** (ADR-044): a sell books a debt at fill time and is paid out of the staked satoshis themselves —
built and tested, **not yet run on mainnet**, with market #7's 998 sat waiting as the first real one. 185
workspace tests green._

_Previously: 2026-08-07 — PLATFORM (Phase P5). **A person with a browser wallet can now trade this market on
mainnet and get paid.** `apps/web` gives traders a market list → order ticket → sign → position/receipts, and the
operator a **sign-off queue** where every on-chain action waits for a human (UI-001, ADR-029). The whole journey
was **clicked through the UI on mainnet** on 2026-08-07: deploy `e7f46a7b…` → settle `35da80d1…` (2 wallet-signed
fills in one tx) → resolve `9a9e4130…` → payout `b3fc3b49…`, audit ok, **143,017 sat vs 142,968 predicted**.
An earlier run exposed a real defect — winners could be **paid twice** (block 961150) — now closed at both layers,
with the contract's `paid` flag verifiable in the live pool's own locking script and a replay **rejected by Script**
(MAINNET-004/005, ADR-034/035/036). 120 workspace + 29 sCrypt tests green. Funding wallet ~155k sat._

_Previously: 2026-08-04 — PRODUCTIZATION (Phase P3). Feasibility proven + traded live on mainnet; full token lifecycle VM-proven. NOW: the spike is **APIfied** — a localhost HTTP daemon (`@pm/daemon`) drives the full market lifecycle autonomously behind a `ChainEngine` swap seam (`@pm/engine`, Rúnar now / sCrypt next), with a **sign-off queue** so the human only authorizes wallet spends. Hardened with `/positions`, multi-share buy/sell (0-conf chain), and a full API README. 72 tests green. **Live run (2026-08-04): DEPLOY confirmed on mainnet via the daemon (9d7c370f…, block 960831); BUY blocked by BUG-006 (NULLFAIL, VM≠mainnet) + BUG-003 + WoC 429s** — which motivated Phase 2 (sCrypt). **PHASE 2 COMPLETE: the FULL lifecycle (deploy→buy+mint→resolve→redeem) is now LIVE on BSV mainnet under sCrypt** (txids in SCRYPT-004 / VERDICT.md) — every Rúnar blocker fixed. Funds ~1,996,947 sat (lifecycle cost ≈ fees only)._

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
  the bond via the on-chain Rabin equivocation proof — both **CONFIRMED on mainnet (block 960994)**. Runner:
  `mainnet-bond.ts --broadcast`.
  Honest scope: slashes equivocation (can't lie about WHICH settlement happened); full net-vs-receipts
  enforcement is the endgame.
- ● CONC-003c — **Backtrace-verified token redeem — DONE (contract + engine) (2026-08-05, ADR-024).** `buy` mints a
  data-carrying token `<push marketTag‖side‖supply(8)‖holderPKH> OP_DROP P2PKH(holder)`; `redeem` co-spends it as
  input #1 and BACKTRACES it (reconstruct token output → mint txid → bind via hashPrevouts) so supply/holder/side
  come from the chain — no token-less redeem, no over-claim, no redirection. Pool script 30.5→32.9 KB.
  **Verified:** `tests/redeemBacktrace.test.ts` — a real mint→co-spend redeem passes the node Script for all
  inputs; over-claim / redirection / wrong-vout all rejected. **Engine integration DONE:** `ScryptEngine` tracks
  each buy's minted token + split mint-tx pieces (reconstruction verified vs the real txid) and `execRedeem`
  builds the explicit co-spend (pool #0, token #1, funding #2), signs the P2PKH inputs, reserves fee for the
  covenant unlock, and refuses a token-less redeem. `tests/engineRedeem.test.ts` drives **deploy→buy→resolve→
  redeem** through the engine vs real Script (**18 sCrypt + 83 workspace green**, typecheck clean).
  **PROVEN LIVE on mainnet (2026-08-06)** via `mainnet-redeem.ts --broadcast` — a 3-tx proof (the hardened pool is
  ~33 KB so a 4-tx chain exceeds the ~101 KB ancestor budget): mint `8328f669…444337` → deploy already-resolved
  pool `1c1660e3…a5c1f2` → **redeem `c6d8900f…e469e5`** (67,749 B; in[0]=pool, **in[1]=the real token**,
  in[2]=funding; out[1]=100-sat payout to the holder) — **CONFIRMED, block 961048** ⇒ the backtrace covenant
  executed and passed on-chain. First attempt hit `txn-mempool-conflict` (BUG-003, stale WoC UTXO set) — fixed by chaining
  each stage's own change in-process. VERDICT gap #2 is closed.
- ○ Endgame — validity-proof settlement: the contract re-checks the batch on-chain (trustless). Planned.
- ● CONC-006 — **Square-and-multiply batch cap — DONE (2026-08-06, ADR-025).** Benchmarked the shipped engine:
  **~1,240 fills/sec, ~0.8 ms each** (ECDSA signing = 99.7 % of cost; LMSR 0.3 µs, SQLite 2.3 µs). Found the real
  constraint: `settle`'s **linear** loop capped the NET move at 20, and directional flow (which is when markets
  get busy) blew through it — 1,000 all-buy fills net 530 ⇒ **27 settlements**. Replaced with square-and-multiply
  over 12 bits (`MAX_NET = 4095`); canonical `powFixed` in `@pm/lmsr`, mirrored by the contract + both engines,
  pinned by `pow` vectors in the fixtures. **Script got SMALLER: 32,889 → 29,801 B (−3,088)** while the cap rose
  ~200×. **Every measured flow shape now settles in ONE tx.** Also fixed a real gap the vectors exposed: `settle`
  never asserted `q ≥ 0` (a net-sell could drive shares negative) — now guarded. Added
  `ExecutionEngine.resyncState` (chain is authoritative at settlement boundaries). **20 sCrypt + 88 workspace
  green**, typecheck clean.
- ● MAINNET-005 — **`payout` is idempotent ON CHAIN + proven live — DONE (2026-08-07, ADR-035/036).** The
  2026-08-06 run paid a winner TWICE (`6dd31acc…` then `9a1879b2…`, both block 961150): `payout` was replayable,
  because the replay just spent the pool output the first payout produced and `collateral` (seeded at 1e9) never
  bound. Fixed at both layers — the daemon refuses a second payout naming the tx that already paid, and the
  contract carries a **`paid` state flag** (`assert(this.paid == 0n)`), costing script 36,762 → **40,073 B**
  (+9%) and a journey 131,570 → **142,969 sat** (+8.7%). **Proven live:** the full journey clicked through the
  UI on mainnet with a real BRC-100 wallet — deploy `e7f46a7b…`, settle `35da80d1…` (2 signed fills → 1 tx),
  resolve `9a9e4130…`, payout `b3fc3b49…` paying 3,000 sat to the winner's own key; audit ok, 0 violations.
  **143,017 sat actual vs 142,968 predicted (0.03% out).** Reading the LIVE pool's locking script back gives
  `resolved=1 winner=1 paid=1`, and replaying the payout against that real UTXO is **rejected by Script —
  `already paid`**. 120 workspace + 29 sCrypt tests green.
- ● UI-002 — **Four defects the first real user hit — FIXED (2026-08-06, ADR-030).** The first human-driven
  session broke at step 2 and step 4; the acceptance test missed all of it because it only ever ran against an
  **empty DB**. (1) The console defaulted to the *oldest* market and "new market" didn't select what it created,
  so every action silently targeted a stale market — now defaults to newest + selects on create, pinned by a
  regression check. (2) **Nothing said which network the daemon was on**, and `.env` defaults to *mainnet* — one
  authorize click from an irreversible real spend. Now `/health` reports the network, the header shows a
  **MAINNET · real money** badge, and mainnet authorize needs a second *confirm — spend N sat* click. (3) Markets
  were indistinguishable, so an old 100,000-sat/share market got traded at **52,497 sat/share** unnoticed — cards
  and selectors now show id, sat/share and b. (4) A pool from an older contract build failed at authorize time
  with sCrypt's unreadable `raw script cannot match the ASM template`; now `ChainEngine.poolSpendable()` surfaces
  `pool.spendable` so the UI **flags and disables** it up front, and the engine's error explains the mismatch in
  bytes. Verified against the user's **actual DB** (Rúnar-era market correctly `spendable=false`). **115 tests
  green.** Also closed UI-001's gap: a **real BRC-100 wallet** signed an order and the daemon verified it.
- ● UI-001 — **The face: trader app + operator console — DONE (2026-08-06, ADR-029).** `apps/web` (Vite + React
  + TS) over the daemon's existing API. **Trader:** live prices → order ticket (side/buy-sell/size + live quote)
  → sign → submit, own position/receipts/payout. **Operator:** the **sign-off queue** as the centrepiece (every
  state change parks there with a plain-English summary and a sat cost until a human authorizes), plus deploy /
  settle / resolve / pay-winners, the audit report, payout preview, wallet balance. Signing stays with the user
  behind a `Signer` seam: `WalletSigner` (**real BRC-100 wallet**, key never leaves it; the daemon verifies with
  `ProtoWallet('anyone')` so **no server-side wallet is needed**) and `LocalSigner` (dev key, with a visible
  warning banner). Migration 012 records `ecdsa`|`brc100` per order; the mainnet-proven ECDSA path is untouched.
  **Security fix forced by this:** the daemon had **no auth at all** — any local caller could authorize a
  broadcast and spend the wallet. Money routes now require `x-pm-operator-token`; CORS is localhost-only.
  **Acceptance met — the whole journey driven through the UI** (`apps/web/test/ui-journey.test.tsx`, live daemon
  on `PM_NETWORK=local`): create → deploy → signed order → settle → **audit ok** → resolve → **1 winner paid
  5,000 sat**, all 4 broadcasts authorized through the queue. **114 workspace tests green**, typecheck + build
  clean. **Honest gaps:** components are driven in **jsdom, not a real browser** (no layout/paint coverage), and
  **no BRC-100 wallet was installed**, so `WalletSigner` is unit-tested, not proven against a live wallet.
- ● PAYOUT-001 — **Receipt → on-chain payout bridge — DONE + PROVEN LIVE (2026-08-06, ADR-028).** Closed the
  last hole in the user journey: winners could not collect. New `payout` contract method pays every winner in
  ONE tx (bounded loop, MAX_PAYOUTS=8) while the contract asserts resolved + `collateral >= total` and
  decrements collateral by exactly what leaves; `winningPayouts` derives the list from the audited receipts
  (losers/flat traders get nothing) and the digest is pinned on-chain. Payout address = `hash160(trader pubkey)`
  — the key you trade with is the key you get paid to. Script 29,801 → 36,762 B. **PROVEN ON MAINNET:** deploy
  `6ab9da17…` → settle `3092f3dc…` (26 real signed fills → 1 tx) → resolve `81d94c76…` → **payout `4332b024…`,
  block 961094, 4 winners paid 15,000 sat**; trader-2's address independently confirmed holding 4,000 sat.
  **98 workspace + 28 sCrypt green.** Remaining: on-chain verification of each winner's receipts
  (validity-proof settlement).
- ● LIVE-001 — **Trader-authenticated orders + the REAL multi-wallet market — DONE (2026-08-06, ADR-027).**
  Found and fixed a real security gap: `submit()` verified nothing, so the operator could fabricate fills in any
  user's name. Traders now sign `marketId|trader|side|action|units|nonce`; the engine verifies BEFORE filling
  (migration 010 + UNIQUE replay guard). Cost: **1,240 → 404 fills/sec** (an extra ECDSA verify per fill) —
  recorded, not hidden. New `trader-keygen` (WIFs git-ignored) + `live-market.ts`, which spawns the REAL daemon
  and drives it over HTTP. **PROVEN LIVE on mainnet:** 4 distinct wallets, **26 real signed fills → ONE
  settlement** (deploy `b8473fd2…` + settle `0c90cc39…`, block 961087; resolve `8782ed70…`, block 961088).
  Verified after the fact: **audit ok, 26 receipts, 0 violations, Rabin-attested**, 26/26 orders signed.
  **Honest gap surfaced:** settled off-chain positions have **no on-chain payout path** (traders hold receipts,
  not per-participant tokens) — the remaining piece of the user journey.
- ● CONC-005 — **Restart-safe engine state — DONE (2026-08-06, ADR-026).** A daemon restart used to strand a
  market (`no live pool for market N`). Now every build descriptor carries the pool UTXO (txid/vout/sats/
  lockingScript) — already persisted in `broadcasts.plan` — and `exec*` rebuilds via `LMSRMarket.fromUTXO`, which
  was **measured** to restore all 7 state props + all 7 consts + marketTag with a byte-identical script (no
  network call, no new storage). Token identity now persists to the previously-unused `tokens` table (migration
  009 adds `script`/`holder_pkh`/`sats`; written on buy, burned on redeem) while the ~30 KB backtrace pieces are
  **re-derived from the chain** at redeem time. **Verified:** `tests/restart.test.ts` drives a genuinely NEW
  engine through resolve + settle from the persisted plan alone (**24 sCrypt + 88 workspace green**, typecheck
  clean). Remaining ops work: automated fee/UTXO-pool management; cold-restart token recovery depends on the
  provider's `getTransaction`.

### Phase P6 — The money leg (FUND-001; ADR-039/040/041)
- ◐ FUND-001 — **A bet is now an actual bet.** The defect, found by the user in one question: *"if no money
  leaves my balance at any time then I am not betting, I am just winning or not."* No satoshi belonging to a
  trader had ever entered the system — a trader signed a message, the engine recorded `costSats`, nothing
  collected it, and winners were paid real money from the operator's wallet. Every trader held a **free
  option**. Not an off-chain oversight either: the on-chain `buy` compares `paymentSats` (a free method
  argument) to a number and relates it to no input or output. Shipped so far:
  - ● **step 1 — `@pm/wallet`.** BRC-29 derivation (`protocolID [2,'3241645161d8']`), payment verification, and
    a `ChainCheck` seam. Round-trip proven: the recipient derives a key that spends what the payer built.
  - ● **step 2 — migration `014_funding.sql`.** `payment_intents` (a quoted, payable order), `exec_orders +=
    payment_intent_id/paid_sats`, `payouts +=` the derivation nonces. Unique index on `(txid, output_index)`:
    one payment output funds at most one fill.
  - ● **step 3 — the execution-engine gate.** A buy with no `FundingProof`, or one that does not cover the
    computed cost, is refused — **after** the cost is computed but **before** `m.state`/`m.seq` mutate, so a
    refused buy cannot move the price for everyone else.
  - ● **step 4 — the daemon collects before it fills.** Quote an intent → verify the trader's transaction pays
    it → confirm it is on the network (the never-broadcast side door) → only then fill.
  - ● **step 5 — the UI pays.** `Signer.pay()` via `createAction`; `LocalSigner` refuses, because a dev key
    holds no funds. The order ticket is quote → approve in your wallet → filled.
  - ● **step 6 — winnings land where a wallet can see them (ADR-041).** Payouts go to a one-time BRC-29
    destination derived for the winner instead of `hash160(identity key)`, which no wallet watches; the
    remittance is persisted and served at `GET /markets/:id/payouts`. Nonces are **scoped** to
    `(market, trader)`, so the destination survives a restart (the payout digest commits to it) and is
    recoverable from the market id alone — that class of money-loss is now impossible. `MockEngine` gained
    `buildPayout` so this bookkeeping has coverage without minutes of Script verification. 7 new tests; the
    load-bearing one derives the winner's key and checks it unlocks the exact output that was paid.
  - ● **step 7a — one-click claiming (ADR-042).** `GET /markets/:id/claim` returns the prepared
    `internalizeAction` call; the winner's wallet verifies the merkle proof and credits the balance itself.
    **A payout is claimable once MINED, not once broadcast** — a wallet wants a proof, and the covenant's
    ancestry is far too heavy to carry instead. Two dependency landmines dealt with: `@bsv/wallet-toolbox`
    declares `@bsv/sdk ^2.1.8` but needs 2.3.x (workspace moved 2.1.9 → 2.3.1, all tests still pass), and it
    runs `dotenv.config({override:true})` **on import**, which would have rewritten `PM_NETWORK` mid-session —
    the import is now snapshot-and-restore wrapped.
  - ● **step 8 — THE MAINNET ROUND TRIP (ADR-043).** Market #7, 2026-08-10. Money left a real BRC-100 wallet on
    two buys and came back as spendable balance on the payout claim. Four txs, 28,601 sat total fees (5× cheaper
    than the 143,017 sat comparable run), audit clean, pay-once guard fired on live state. Three defects found
    and fixed mid-run — MAINNET-008 (a propagation race permanently burned a quote the trader had already paid,
    stranding 1,002 sat), MAINNET-009 (`poolSpendable` cached a verdict reached before the artifact loaded, so a
    healthy pool read as "wrong contract build" and restarting reproduced it), MAINNET-010 (the trader's wallet
    signed three payments and broadcast one — the daemon now publishes the payment itself). Same root cause in
    all three: **a transient or uninitialised condition recorded as a permanent verdict.**
  - ◐ **step 7b — sells are a debt the market pays (ADR-044).** A sell now books a `sell_proceeds` row at fill
    time and the operator clears it from the sign-off queue. **The money comes from the stakes**: each stake is
    a one-time BRC-29 UTXO, and the proceeds payment spends exactly those — so the pot is a fact about the chain,
    not an accounting entry, and the operator is not quietly subsidising the market. Refusals are total: an
    underfunded pot pays nobody rather than some. Migration 015 backfills debts that predate it, **including
    market #7's 998 sat**, verified against a backup of the live mainnet DB. 15 new tests.
    **Not yet run on mainnet** — market #7's 998 sat is the intended first, and costs ~1 sat in fees.
    (No wallet-toolbox server wallet was needed after all: `@bsv/sdk` builds and signs the payment directly.)
  - ○ **step 9 — recover a stranded payment.** A buy whose intent was burned leaves the trader's satoshis at an
    operator-derived address with nothing to show for them (1,002 sat at `17WV463R…` from this run). Pressing
    "buy" again mints a *new* intent and pays *again*: an intent whose address is already funded must be reused,
    not re-quoted.
  - ● **CURVE-001 — `b` is an operator setting now (ADR-045).** Prices always were a bonding curve (LMSR), but
    `b` was hard-coded to 1000, which against 2-share trades pinned every displayed price at 500 sat and made
    the curve look flat. `b` and the payout unit are now inputs on the create-market form, with the resulting
    curve and the operator's maximum loss (`b·ln2·payout`) shown beside them; default `b` is 20, not 1000.
    The float preview is pinned within 1 sat of the exact integer engine by `apps/web/test/curve.test.ts`.
  - ● **CURVE-001b — the displayed price was reading the pool, not the trades (ADR-046).** `b=20` still looked
    frozen because `getMarket` priced from the on-chain pool, which only advances at settlement — so the
    headline price ignored every fill and jumped at the batch. Now priced from the execution engine's live
    state, with the pool's price reported alongside as `settled_prices`; the gap between them is the unsettled
    batch, and the trader UI shows it. **Second occurrence of this exact defect** (ADR-040 fixed it for payment
    quotes): the same question answered in two places, and the untested one was wrong. 6 tests, 4 of which
    fail against the old behaviour.
  - ◐ **UI-010 — a real design system, both surfaces (ADR-047).** Tokens + primitives, light and dark, no new
    runtime deps. Fixed two defects hiding in the old stylesheet: `--no` and `--err` were the same hex (NO is
    now orange; red belongs to danger alone), and `msg.startsWith('✗')` was deciding success from failure.
    Stage 0 re-anchored the journey test on roles/labels **before** any pixel moved, so it could act as the
    contract — and it caught a bug where the home screen showed the market's aggregate position as the
    viewer's. The journey test now also refuses to run against a mainnet daemon. Slide-to-confirm went to the
    operator rather than the trader (the trader's wallet already confirms; the operator has nothing else).
    **Still unverified: how it LOOKS** — the headless browser here cannot execute localhost bundles, so nobody
    has seen it in a browser yet. Remaining: keyboard pass, three widths, both themes by eye.
  - ◐ **UI-011 — the chassis (ADR-048).** ADR-047 was judged "just a little improvement", and rightly: it
    restyled a dashboard. Rebuilt on the fintech shape — bottom tabs (a left rail when wide), circular Buy
    YES / Buy NO actions on each card, a stake **bottom sheet** with preset chips, avatar list rows, filter
    chips, search, and a new **Positions** tab. **Discover** is a swipe card stack, one market per card:
    a swipe picks a side and opens the sheet, it never places a bet. One shared `StakeSheet` for every route
    into a trade. **Appearance still unverified** — the headless browser here cannot run localhost bundles.
  - ○ **step 10 — `apps/daemon` `dev` has no watch mode** (plain `tsx src/server.ts`). Cost two false diagnoses
    during the live run, both settled by comparing file mtimes to the process start time. Use `tsx watch`.

## Known issues
- **`better-sqlite3` native binary is now BUILT** (API-001). If a fresh clone hits "Could not locate the
  bindings file", run `npm --prefix node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 run
  build-release` (node-gyp). Note: a machine-level pnpm store move required `pnpm config set store-dir
  ~/Library/pnpm/store/v3 --global` to relink; `pnpm rebuild` silently no-ops, hence the direct node-gyp build.
- The daemon DB defaults to `data/spike.db` (`PM_DB_PATH` overrides). The old `apps/spike/data/pool.json` is
  legacy CLI scratch — the daemon uses `pool_utxos` full-state instead (ADR-016).
- **Node 22 is a hard floor** (ADR-039, `.nvmrc` 22.23.0) — not a preference. A shell still on v20 fails every
  DB-touching test with `NODE_MODULE_VERSION 127 … requires 115`: the native `better-sqlite3` binary is built
  per ABI. `nvm use` before running the suite, and `pnpm rebuild -r` after any Node switch.
  We use `better-sqlite3` rather than `node:sqlite`; `sqlite3` CLI 3.43.2 is available for schema checks.
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
