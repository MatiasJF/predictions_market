# STATE — living

_Last updated: 2026-07-24 — P2 started: on-chain sell (CONTRACT-003) matches reference, 44 tests. Next: SETTLE-001 (Rabin oracle)._

## Current phase
**P1 — Feasibility core: COMPLETE.** The native on-chain LMSR AMM buy is proven feasible on Rúnar and
adversarially verified: `LMSRMarket.buyYes/buyNo` compiles to 466 bytes of Script and produces output state
**exactly matching** the `@pm/lmsr` reference (verified over a 60-step feedback loop; all 6 tamper-mutations
caught). 40 tests green, typecheck clean. **All software-side feasibility unknowns are resolved.** The only
open unknowns are on-chain reality — single-UTXO throughput (#2) and per-trade fees (#6) — answerable only by
a mainnet deploy. **P2 in progress:** sell done (CONTRACT-003). Remaining: Rabin oracle resolve (SETTLE-001, offline-testable),
YES/NO tokens + ownership (TOKEN-001), bind collateral to real UTXO sats (`extractAmount`) + constrain
`outputSatoshis`, then the gated mainnet DEPLOY-001.

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
- ○ TOKEN-001 (planned) — YES/NO tokens via `runar-lang/tokens`; mint on buy, redeem on settle.
- ○ SETTLE-001 (planned) — Rabin oracle resolution (`runar-lang/oracle`) + winner redemption sighash composition.
- ○ DEPLOY-001 (planned) — FIRST real **mainnet** deploy+spend of the pool UTXO (ADR-010); measure
  single-UTXO serialization, throughput, and per-trade fee (Open Q3, unknowns #2/#6). **Real-money chain
  interaction — gated per-action; tiny amounts.**
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
