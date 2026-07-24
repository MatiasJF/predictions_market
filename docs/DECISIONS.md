# Decision Log (ADRs)

Append-only. Newest last. Never edit a past ADR's decision; supersede it with a new one.

Template:
```
## ADR-NNN · <title> · <Accepted|Superseded by ADR-MMM> · <YYYY-MM-DD>
- Context: <why this came up>
- Options: (a) … · (b) … · (c) …
- Decision: <the chosen option and what it means>
- Consequences: <trade-offs, follow-ups, what it unblocks>
```

---

## ADR-001 · TypeScript + pnpm monorepo + Node ≥20 · Accepted · 2026-07-24
- Context: Need a stack for a BSV feasibility spike. Rúnar, `@bsv/sdk`, and the source sample are all
  TypeScript-first; the team is BSVA.
- Options: (a) TypeScript monorepo · (b) Rust (Rúnar also targets Rust) · (c) mixed.
- Decision: TypeScript, Node ≥20, pnpm workspaces. Packages: `@pm/lmsr` (pure math), `@pm/persistence`
  (SQLite), `@pm/contracts` (Rúnar), app `spike` (CLI harness).
- Consequences: One language across contract, tx-building, and harness. Rúnar TS ↔ its Script output must
  be verified (CONTRACT-001). Native `better-sqlite3` needs a build step at install time.

## ADR-002 · Rúnar as the on-chain contract language · Accepted · 2026-07-24
- Context: The contract must be a stateful UTXO smart contract on BSV. Candidates: Rúnar (the sample's
  language), scrypt-ts, hand-rolled Script.
- Options: (a) Rúnar · (b) scrypt-ts · (c) raw Script via `@bsv/sdk`.
- Decision: **Rúnar.** Verified real: a BSV Association compiler (repo `icellan/runar`, technical report
  Mar 2026) that compiles TS/Rust/Go/Python to Bitcoin Script and supports **stateful** contracts via
  OP_PUSH_TX. Install: `pnpm add runar-lang runar-compiler runar-cli`; SDK `runar-sdk`.
- Consequences: **Hard constraint discovered:** Rúnar Script exposes only arbitrary-precision integers,
  bitwise/comparison/arithmetic, hashes, `checkSig` — **no exp/log/fixed-point primitives, and no
  unbounded loops or recursion.** Therefore LMSR `exp`/`ln` CANNOT be computed on-chain; forces the
  multiplicative-state design (ADR-007) and leaves the cost-verification-without-`ln` open question.
  **Fallback:** if Rúnar cannot express the contract (CONTRACT-001/002 gate), supersede with scrypt-ts.

## ADR-003 · SQLite for local spike state · Accepted · 2026-07-24
- Context: The harness must track deployed markets, the pool-UTXO version lineage, tokens, and trades
  across a run, and satisfy the workflow's "encode a data model + migration" step.
- Options: (a) SQLite (`better-sqlite3`) · (b) flat JSON files · (c) in-memory only.
- Decision: SQLite with SQL migrations. Blockchain is the real ledger; SQLite is the run's audit trail.
- Consequences: Real schema + integrity constraints; resumable experiments. Requires a native module build.

## ADR-004 · Build the native on-chain UTXO AMM (not the off-chain ledger) · Accepted · 2026-07-24
- Context: The two source PDFs describe two different systems. The off-chain roadmap explicitly excludes
  the on-chain AMM; the UTXO doc makes it the whole point.
- Options: (a) native on-chain UTXO AMM · (b) off-chain custodial double-entry ledger · (c) thin LMSR-only slice.
- Decision: **(a) native on-chain UTXO AMM.** The spike's job is to prove the novel BSV-native design.
- Consequences: Highest technical risk and the highest-value answer for BSVA. Confronts single-UTXO
  serialization, on-chain math limits, token mint/redeem, and oracle settlement head-on.

## ADR-005 · Testnet dev loop, single mainnet proof run · Superseded by ADR-010 · 2026-07-24
- Context: User chose "mainnet" as the target environment; iterating a novel contract on mainnet burns
  real sats on every failed broadcast, and fee/Script semantics are identical on testnet.
- Options: (a) mainnet from trade #1 · (b) testnet-only · (c) testnet dev loop + one mainnet proof.
- Decision: (c). Develop/iterate on testnet (free); run one canonical end-to-end proof on **mainnet** with
  tiny amounts as the feasibility sign-off. Any mainnet broadcast is gated behind explicit confirmation.
- Consequences: Honors the mainnet goal without wasting funds. Mainnet run is a checklist item, not the loop.

## ADR-006 · Store LMSR numeric state as decimal-integer TEXT (BigInt), sats as INTEGER · Accepted · 2026-07-24
- Context: LMSR multiplicative state `e_yes/e_no = exp(q/b)·SCALE` can exceed SQLite's signed 64-bit
  INTEGER; satoshi-exactness is non-negotiable.
- Options: (a) all numerics as INTEGER · (b) REAL/float · (c) BigInt-valued columns as TEXT.
- Decision: LMSR-scaled columns (`b`, `scale`, `q_yes`, `q_no`, `e_yes`, `e_no`, `shares`) as **TEXT**
  decimal strings parsed to `BigInt`; plain sat amounts that safely fit (`sats`, `cost_sats`, `fee_sats`,
  `payout_unit`) as **INTEGER**. Never REAL — floats break satoshi-exactness.
- Consequences: No overflow, exact math. Code must parse/serialize BigInt at the DB boundary.

## ADR-007 · Multiplicative-state LMSR; off-chain exact reference is ground truth · Accepted · 2026-07-24
- Context: Rúnar has no exp/log and no loops (ADR-002), so classic LMSR (`C=b·ln(Σ exp(qᵢ/b))`) is not
  directly computable on-chain.
- Options: (a) on-chain series-approx exp (blocked: no loops) · (b) multiplicative exponential state +
  precomputed unit constant · (c) off-chain compute, on-chain verify a cheap invariant.
- Decision: (b)+(c). Store `e_yes/e_no` as state; a fixed-unit trade multiplies by constant `exp(u/b)`
  (pure mul/div). `@pm/lmsr` holds an exact integer LMSR reference off-chain as ground truth for tests and
  for computing what the contract must enforce.
- Consequences: **Unblocks** an on-chain-expressible buy. **Open question (see STATE.md):** verifying LMSR
  *cost* on-chain still needs `ln`; candidate resolutions — quantize to unit trades, bounded price-based
  cost approximation (quantify error in LMSR-002), or bounded lookup. Variable trade sizes without loops
  is the second open question.

## ADR-008 · MM-safe rounding directions + q≥0 invariant for sells · Accepted · 2026-07-24
- Context: LMSR-001 adversarial verification (3 agents) confirmed the buy math is correct/solvent but found:
  (a) sell was advertised yet unimplemented/untested; (b) the div-by-zero / negative-`C` branches become
  reachable the moment a sell drives `e` below WAD.
- Options: (a) implement sell with an explicit non-negativity guard · (b) ship buy-only and drop the sell
  claim from the docs.
- Decision: (a). **Buys charge `ceil` (round up), sells pay `floor` (round down)** — the tiny bid/ask
  rounding spread always favors the pool, so it can never overpay. **Sells guard `delta ≤ q`** so net
  shares stay ≥ 0; since `q ≥ 0 ⇒ e = exp(q/b) ≥ WAD`, the sum is always ≥ 2·WAD and the underflow
  branches stay unreachable. Exact buy/sell paths also reject negative deltas.
- Consequences: Reference now matches the market lifecycle (early-exit before close). Verified: buy→sell
  round-trips return to the opening state; real pool (`seed + Σcost`) ≥ liability every trade over 100k.
  **Known, benign property:** the two sides' displayed prices can differ by 1 sat (floor asymmetry); the
  on-chain contract must respect the same rounding direction. The exact-vs-multiplicative drift is
  ~5e-13 relative and non-compounding (measured to 1M trades).

## ADR-009 · Rúnar toolchain gate passed; token & oracle primitives chosen; offline test harness · Accepted · 2026-07-24
- Context: CONTRACT-001 had to prove Rúnar compiles+runs a stateful contract before building the LMSR
  market on it. Inspected the installed v0.4.6 packages directly (not the earlier page summary).
- Findings:
  - `StatefulSmartContract` (runar-lang) is exactly the Market Pool pattern: mutable props → state via
    OP_PUSH_TX; `addOutput(sats, ...stateValues)` enforces the continuation output; the compiler
    auto-injects the preimage check + state-continuation assert.
  - Compiled a minimal `Counter` to **148 bytes of Bitcoin Script** and executed 0→1→2 **offline** via
    `runar-testing`'s `TestContract` (Script VM + mock preimage). No chain, no funds needed for the gate.
  - Script math available: `mulDiv(a,b,c)`, `pow`, `sqrt`, `log2` (approx floor), `percentOf` (bps),
    `min/max/within/clamp`, `safediv`. Still **no exp/ln** (confirms ADR-002) — but mulDiv+pow are what the
    multiplicative-state trick (ADR-007) needs.
- Decisions:
  - Contract toolchain = Rúnar, gate met → **ADR-002 fallback (scrypt-ts) not needed.**
  - **Token primitive = `runar-lang/tokens`** (`FungibleToken`/`NonFungibleToken`), replacing the docs'
    vague "BRC-100" → resolves Open Q4.
  - **Oracle = Rabin signatures** via `runar-lang/oracle#verifyRabinSig` (cheaper on-chain than ECDSA);
    sign/verify in tests with `runar-testing`'s rabin helpers.
  - **Contract development is offline** via `runar-testing` (`TestContract`, `ScriptVM`, mock preimage);
    real testnet/mainnet deploy is a separate, later, explicitly-gated ticket (DEPLOY-001).
- Consequences: Unblocks CONTRACT-002 (LMSRMarket buy in Rúnar). `fast-check` added as a devDep (an
  undeclared transitive of runar-testing). Contract sources are valid TS and are typechecked. Single-UTXO
  throughput / fee economics (Open Q3, unknowns #2/#6) still require a real-chain ticket to measure.

## ADR-010 · Mainnet only; no testnet · Accepted · 2026-07-24 (supersedes ADR-005)
- Context: User directive — "we will never touch testnet, we will do all in mainnet." Avoids testnet
  faucet/coin friction.
- Options: (a) testnet dev loop + mainnet proof (ADR-005) · (b) mainnet only.
- Decision: **(b) all on-chain interaction targets BSV mainnet; no testnet at all.** Development,
  compilation, and full contract execution still happen **offline** in the Rúnar VM (`runar-testing`) —
  free, no chain — and only actual broadcasts (deploy pool, trades, settle, redeem) touch mainnet, with
  tiny satoshi amounts.
- Safety floors (unchanged, non-negotiable): (1) every mainnet broadcast is gated behind explicit
  per-action user confirmation before sending; (2) Golden Rule 6 — never handle/echo/store a private key
  or WIF; keys stay in the user's wallet or a user-funded key; I build/inspect txs and surface addresses /
  unsigned txs only; (3) prove each contract path offline in the VM before any broadcast.
- Consequences: Supersedes ADR-005. `DEPLOY-001` and later are mainnet. Real-money risk bounded by
  tiny amounts + offline-first verification. Throughput/fee unknowns (#2/#6) get measured on mainnet.

## ADR-011 · On-chain cost verification without `ln`: post-trade marginal price (MM-safe) · Accepted · 2026-07-24 (resolves Open Q1)
- Context: Rúnar has no `ln`, so the contract cannot compute exact LMSR cost `C(new)−C(old)`. LMSR-002 had
  to find an on-chain-expressible cost rule that is MM-safe and low-error.
- Options: (a) price at the post-trade state (right-Riemann bound) · (b) bounded lookup table for `ln` ·
  (c) buyer-supplied cost verified on-chain (needs exp/ln — infeasible).
- Decision: **(a).** The contract charges/pays at the **post-trade marginal price**
  `eSide'/(eYes'+eNo')·payout·Δ`, computable with one `mulDiv`. **Buys round UP, sells round DOWN.** Because
  LMSR cost is the integral of an increasing price curve, the post-trade price is a right-Riemann bound:
  buys overcharge, sells underpay — both MM-safe — and `ceil`/`floor` monotonicity preserves the bound
  after integer rounding. Implemented as `buyChargeApproxSats` / `sellPayoutApproxSats` in `@pm/lmsr`.
- Evidence (LMSR-002, measured; `packages/lmsr/test/cost-approx.test.ts`): MM-safe direction holds across a
  b×side×skew grid (0 undercharges). Overcharge grows with Δ/b (trade ÷ liquidity): **0% for tiny trades,
  ≤0.13% of notional at Δ/b=1e-2, ~1.3–2.4% at Δ/b=0.1, ~8–19% at Δ/b=1**.
- Consequences: **Resolves Open Q1 / de-risks unknown #1.** CONTRACT-002's `buy()` enforces
  `payment ≥ buyChargeApproxSats`. Design rule: **cap trade size to Δ/b ≤ ~0.01** (overcharge <~0.13% of
  notional) — matches the source docs' per-trade caps + `b`-scaling. The buyer pays a tiny, bounded premium
  for not having `ln` on-chain; this premium accrues to the pool (extra safety margin).

## ADR-012 · LMSRMarket contract shape for the feasibility spike · Accepted · 2026-07-24
- Context: CONTRACT-002 needed a Rúnar contract proving the on-chain LMSR buy math, exercisable in the
  offline interpreter.
- Decisions:
  - **`addOutput` continuation pattern** — compute new values as locals, `this.addOutput(outputSatoshis,
    ...newState)`, no `this` reassignment. This is the pattern proven by Rúnar's own FungibleToken /
    multi-output tests; the compiler's state-continuation hash constrains the untouched side + readonly
    params. The new state appears in `result.outputs[0]`, not `this`.
  - **Collateral tracked as STATE** (a bigint field, like a token balance), NOT bound to the UTXO's
    satoshis. Binding it to real sats via `extractAmount(txPreimage)` compiles but can't be exercised in
    the offline interpreter (needs a real BIP-143 preimage), so it's deferred to DEPLOY-001. Keeps the
    buy-math fully testable now.
  - **`unit == scale`** (one-share unit, WAD) so the charge needs no unit factor; multi-unit trades (via
    `pow`) deferred to a later ticket.
- Verification: 1 adversarial agent could not refute correctness or test adequacy — contract charge ≡
  reference exactly (algebra + independent 120-step feedback loop), all 6 mutations caught red. Captured a
  60-step feedback-loop regression test in the suite.
- Consequences: On-chain LMSR buy proven feasible (software). Owed at DEPLOY-001: bind collateral to UTXO
  sats (`extractAmount`), constrain `outputSatoshis`, handle buyer change / token mint as additional
  outputs, and measure real throughput/fees. Resolves unknown #1 fully; completes P1.
