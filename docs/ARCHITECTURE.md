# Architecture

A feasibility spike with a deliberately thin shell around tested core logic (Golden Rule 5).

## Modules
```
packages/
  lmsr/         @pm/lmsr        Pure integer LMSR. No I/O, no chain, no DB. The GROUND TRUTH.
                                 price(), cost(), buy/sell deltas, b·ln2 max-loss, multiplicative state.
  contracts/    @pm/contracts   Rúnar StatefulSmartContract sources → compiled Bitcoin Script.
                                 counter (toolchain gate), then LMSRMarket. Thin: enforces what @pm/lmsr defines.
  persistence/  @pm/persistence SQLite: open/migrate + typed row access. The run's audit trail (not the ledger).
apps/
  spike/        CLI harness. Wires @pm/lmsr + @pm/contracts + @pm/persistence + @bsv/sdk to run experiments
                (deploy a market, execute trades, resolve, redeem) and record results.
```
Dependency direction: `apps/spike` → (`@pm/lmsr`, `@pm/contracts`, `@pm/persistence`). `@pm/lmsr` depends on
nothing. Contracts depend only on Rúnar. No cycles.

## The on-chain / off-chain boundary
The chain is the real ledger; everything local is either ground-truth math or an audit trail.
- **On-chain (BSV, via Rúnar + @bsv/sdk):** the Market Pool stateful UTXO (holds reserve sats + `q`/`e`
  state), YES/NO token UTXOs, oracle-signed resolution, winner redemption.
- **Off-chain (local):** `@pm/lmsr` exact reference math; SQLite tracking of market/UTXO-version/token/trade
  lineage; the CLI that builds and broadcasts txs. No custodial user balances — this is NOT the off-chain
  ledger design from the roadmap PDF (ADR-004).

## Data flow — a buy (target design under test)
1. CLI reads current unspent pool UTXO (v_n) for the market from SQLite (+ confirms against chain).
2. `@pm/lmsr` computes the exact cost/new-state for the requested unit trade (ground truth).
3. CLI builds a tx spending pool v_n (+ buyer funding), producing pool v_{n+1} with updated `e_yes/e_no`
   and a YES/NO token UTXO to the buyer. The Rúnar contract enforces the multiplicative state transition
   and the payment rule in Script (OP_PUSH_TX carries the new state).
4. Broadcast to mainnet (ADR-010; gated per-action, tiny amounts). On confirm, SQLite records v_{n+1},
   marks v_n spent, inserts the trade + token rows.

## The central constraint (why this is a real spike)
Rúnar Script has **no exp/log/fixed-point and no unbounded loops/recursion** (ADR-002). Classic LMSR needs
both `exp` and `ln`. The design answer is the **multiplicative-state trick** (ADR-007): keep the expensive
transcendental work off-chain / precomputed, and let Script do only bigint mul/div/compare against
precomputed constants and OP_PUSH_TX-carried state. Whether *cost verification* survives this constraint is
the open question the spike must answer (STATE.md Open Questions 1–2).

## Orchestration policy (Golden Rule 7)
This session has the `orchestrator:*` agents/skills available. Routing:
- **Build directly** (do NOT fan out): the scaffold, the SQLite schema, a single Rúnar contract, and any
  tightly-coupled code around one schema — coherence matters more than parallelism.
- **Verify by fan-out:** after a substantial build (e.g. the LMSR module or a contract), run an adversarial
  verification pass — independent agents each attacking one dimension (math correctness, satoshi-exactness /
  overflow, Rúnar-constraint compliance, test coverage), then synthesize. State the agent count first.
- **Fan out workers** only for genuinely parallel work: the six-unknown feasibility audit, independent
  research angles (e.g. Rúnar cost-verification techniques vs token-standard options), wide sweeps.
- Verifiers are skeptical by default; "failed to verify" ≠ "refuted"; any finding that drives action gets an
  independent adversarial pass. If the orchestrator plugin were absent, this degrades to "build + verify by
  hand (typecheck/test/render)".
