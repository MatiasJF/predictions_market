# STATE — living

_Last updated: 2026-07-27 — ALL 6 UNKNOWNS RESOLVED. LMSR pool deployed AND traded live on mainnet (deploy ddbb0b36…, buy 7106f762…). Feasibility verdict: native on-chain LMSR is viable on BSV. Next: write the verdict / harden for production._

## Current phase
**FEASIBILITY PROVEN — all six unknowns resolved.** The native on-chain UTXO LMSR prediction market is
**buildable, deployable, and tradeable on BSV mainnet**: contract compiles to Script (Rúnar); buy/sell/oracle
logic verified in-VM (51 tests) + adversarially reviewed; and both a **deploy and a live LMSR buy are
confirmed on mainnet** (deploy `ddbb0b36…`, buy `7106f762…`), fees negligible (176-sat deploy, 510-sat buy).
**Remaining work is productization, not feasibility:** collateral↔UTXO-sats binding (`extractAmount`),
funding-UTXO chaining for rapid sequential trades (BUG-003), YES/NO tokens + withdraw/redeem (TOKEN-001).
Suggested next: TOKEN-001, or fix BUG-001 upstream. **Deliverable written: `docs/VERDICT.md`.**

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
  - ○ **001b:** mint-on-buy — pool `buyYes` emits a ShareToken output (multi-output; compile + partial VM).
  - ○ **001c:** winner redemption — burn winning token + resolved pool → payoutUnit×supply (multi-input;
    compile + mainnet, interpreter can't do multi-input). Also the sell-side token-burn ownership check.
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

## Known issues
- Deps installed with `pnpm install --ignore-scripts`, so **`better-sqlite3`'s native binary is NOT built yet**.
  `@pm/persistence` typechecks (types present) but won't run at runtime until we install without
  `--ignore-scripts` (or run its build) — do this when the first ticket needs the DB at runtime (apps/spike).
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
