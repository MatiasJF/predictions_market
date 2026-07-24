# STATE — living

_Last updated: 2026-07-24 — CONTRACT-001 gate PASSED offline (Rúnar compiles+runs a stateful contract). Next: CONTRACT-002._

## Current phase
**P1 — Feasibility core.** LMSR-001 (math) and CONTRACT-001 (Rúnar toolchain gate) both complete. Rúnar
compiles a `StatefulSmartContract` to Script and executes state transitions offline — toolchain proven, no
scrypt-ts fallback needed. **Next ticket: CONTRACT-002** (LMSRMarket buy() in Rúnar via multiplicative
state — the real on-chain-math feasibility test). Nothing on real chain yet (offline VM only).

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
- ○ LMSR-002 — Quantify **exact LMSR cost** vs on-chain-expressible approximations (price-based / unit-quantized).
  Output: max error in sats per trade size → decides whether an on-chain cost check is acceptable. Feeds Open Q1.
- ● CONTRACT-001 — Rúnar toolchain gate. **Re-scoped to OFFLINE** (the real unknown was "does Rúnar compile
  +run a stateful contract", not "can we broadcast"): `Counter.runar.ts` compiles to 148 bytes of Script and
  executes 0→1→2 via `runar-testing`'s VM. 2 tests green. Gate met → no scrypt-ts fallback. See ADR-009.
  Files: `packages/contracts/src/Counter.runar.ts`, `packages/contracts/test/counter.gate.test.ts`.
- ◐ CONTRACT-002 — `LMSRMarket` buy() in Rúnar using multiplicative state (`mulDiv`/`pow`); compiles; unit
  test vs `@pm/lmsr` reference via `runar-testing`. **The crux math-feasibility ticket. Next up.**

### Phase P2 — On-chain lifecycle (see ROADMAP for M2–M4; tickets created when P1 clears)
- ○ CONTRACT-003 (planned) — sell/burn path + on-chain cost-verification approach (resolves Open Q1) in Rúnar.
- ○ TOKEN-001 (planned) — YES/NO tokens via `runar-lang/tokens`; mint on buy, redeem on settle.
- ○ SETTLE-001 (planned) — Rabin oracle resolution (`runar-lang/oracle`) + winner redemption sighash composition.
- ○ DEPLOY-001 (planned) — FIRST real testnet deploy+spend of the pool UTXO; measure single-UTXO
  serialization, throughput, and per-trade fee (Open Q3, unknowns #2/#6). **Chain interaction — gated.**
- ○ OPS-004 (planned) — Mainnet proof run (gated) + feasibility verdict report on all six unknowns.

## Known issues
- Deps installed with `pnpm install --ignore-scripts`, so **`better-sqlite3`'s native binary is NOT built yet**.
  `@pm/persistence` typechecks (types present) but won't run at runtime until we install without
  `--ignore-scripts` (or run its build) — do this when the first ticket needs the DB at runtime (apps/spike).
- Node is v20.19.5 → no `node:sqlite`; we use `better-sqlite3`. `sqlite3` CLI 3.43.2 is available for schema checks.
- `runar-testing` needs `fast-check` at import time but doesn't declare it; added as a `@pm/contracts` devDep.
- Rúnar is v0.4.6 (pre-1.0) — treat compiler behavior as verify-empirically, not assume.

## Open questions (the crux — feed the feasibility verdict)
1. **Cost without `ln`:** the contract can update `e_yes/e_no` by multiplication, but LMSR *cost*
   `= b·(ln S_new − ln S_old)` needs `ln`, which Rúnar lacks. How does the contract reject underpayment?
   Candidates: (a) quantize to unit trades so cost is a computable closed form; (b) bounded price-based
   approximation with the error bounded by LMSR-002; (c) bounded on-chain lookup table. **Undecided.**
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
- None for CONTRACT-002 (offline, proceeds on defaults). **DEPLOY-001** (first real testnet spend) will need a
  testnet funding decision: plan is to generate a fresh testnet key locally, surface only the address for
  faucet funding — never accept a pasted private key (Golden Rule 6). Any **mainnet** broadcast (OPS-004) is
  gated behind explicit confirmation per ADR-005.
