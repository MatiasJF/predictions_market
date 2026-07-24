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

## ADR-005 · Testnet dev loop, single mainnet proof run · Accepted · 2026-07-24
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
