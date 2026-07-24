# STATE — living

_Last updated: 2026-07-24 — LMSR-001 done (29 tests green, verified by 3 adversarial agents). Next: CONTRACT-001._

## Current phase
**P1 — Feasibility core.** LMSR-001 complete: pure integer LMSR reference built, adversarially verified,
hardened, and committed. **Next ticket: CONTRACT-001** (Rúnar toolchain gate). P0 committed (`7992157`).
Nothing on-chain yet.

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
- ○ CONTRACT-001 — Rúnar toolchain gate: compile & run a trivial `StatefulSmartContract` (counter) end-to-end
  on testnet. Proves install → compile → deploy → spend → state-update works before touching LMSR. **Gate: if
  this fails, invoke ADR-002 fallback (scrypt-ts).**
- ○ CONTRACT-002 — `LMSRMarket` buy() in Rúnar using multiplicative state; compiles; unit test vs `@pm/lmsr` reference.

### Phase P2 — On-chain lifecycle (see ROADMAP for M2–M4; tickets created when P1 clears)
- ○ CHAIN-001 (planned) — Single pool-UTXO trade serialization + throughput/fee measurement on testnet.
- ○ CHAIN-002 (planned) — Token mint on buy; sell/burn path.
- ○ SETTLE-001 (planned) — Oracle-signed resolution + winner redemption sighash composition.
- ○ OPS-004 (planned) — Mainnet proof run (gated) + feasibility verdict report.

## Known issues
- Deps installed with `pnpm install --ignore-scripts`, so **`better-sqlite3`'s native binary is NOT built yet**.
  `@pm/persistence` typechecks (types present) but won't run at runtime until we install without
  `--ignore-scripts` (or run its build) — do this when the first ticket needs the DB at runtime (apps/spike).
- Node is v20.19.5 → no `node:sqlite`; we use `better-sqlite3`. `sqlite3` CLI 3.43.2 is available for schema checks.

## Open questions (the crux — feed the feasibility verdict)
1. **Cost without `ln`:** the contract can update `e_yes/e_no` by multiplication, but LMSR *cost*
   `= b·(ln S_new − ln S_old)` needs `ln`, which Rúnar lacks. How does the contract reject underpayment?
   Candidates: (a) quantize to unit trades so cost is a computable closed form; (b) bounded price-based
   approximation with the error bounded by LMSR-002; (c) bounded on-chain lookup table. **Undecided.**
2. **Variable trade sizes without loops:** `exp(k·u/b) = (exp(u/b))^k` needs `k` multiplications, but Rúnar
   forbids unbounded loops. Options: one unit per tx, a small fixed menu of sizes (unrolled), or buyer-supplied
   new state verified by a bounded check. **Undecided.**
3. **Single-UTXO throughput:** every trade spends the one pool UTXO → concurrent trades race. Real
   throughput/UX cost is unmeasured (CHAIN-001). This is why the source roadmap went off-chain.
4. **Token standard:** docs say "BRC-100"; its status as the right BSV token primitive is unverified. For the
   spike a minimal token-UTXO representation suffices; confirm before SETTLE-001.

## Decisions needing user input before proceeding
- None right now. P1 can proceed on defaults. First gate needing attention: CONTRACT-001 (Rúnar toolchain);
  any **mainnet** broadcast (OPS-004) is gated behind explicit confirmation per ADR-005 / Golden Rule 6.
