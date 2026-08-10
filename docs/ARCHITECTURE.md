# Architecture

A feasibility spike with a deliberately thin shell around tested core logic (Golden Rule 5).

## Modules
```
packages/
  lmsr/         @pm/lmsr        Pure integer LMSR. No I/O, no chain, no DB. The GROUND TRUTH.
                                 price(), cost(), buy/sell deltas, b·ln2 max-loss, multiplicative state.
  contracts/    @pm/contracts   Rúnar StatefulSmartContract sources → compiled Bitcoin Script.
                                 counter (toolchain gate), then LMSRMarket. Thin: enforces what @pm/lmsr defines.
  engine/       @pm/engine      THE SWAP SEAM. ChainEngine = compile + tx-building + broadcast, abstracted.
                                 RunarEngine now (absorbs the proven mainnet.ts tx-building); ScryptEngine in
                                 Phase 2 — same interface. MockEngine (no network) backs the daemon tests.
  persistence/  @pm/persistence SQLite: open/migrate + typed row access. The run's audit trail (not the ledger).
apps/
  daemon/       @pm/daemon      Long-running HTTP API (127.0.0.1). service.ts = HTTP-agnostic orchestration over
                                 Db + ChainEngine; http.ts = thin router; server.ts = entrypoint. Drives markets
                                 autonomously; state-changing ops park in the sign-off queue.
  spike/        CLI harness. Wires @pm/lmsr + @pm/engine + @pm/persistence + @bsv/sdk to run experiments
                (deploy a market, execute trades, resolve, redeem) and record results.
```
Dependency direction: `apps/{daemon,spike}` → (`@pm/engine`, `@pm/lmsr`, `@pm/persistence`); `@pm/engine` →
(`@pm/lmsr`, Rúnar, `@bsv/sdk`). `@pm/lmsr` depends on nothing. No cycles. **Only `@pm/engine` imports Rúnar —**
the daemon/service/DB never do, which is what makes the sCrypt swap a one-package change.

## The API-as-seam (autonomous operation + engine swap)
```
HTTP (apps/daemon/http.ts, 127.0.0.1)   GET = answer now; state-changing = enqueue a broadcast
        │
MarketService (apps/daemon/service.ts)   markets, LMSR quotes, pool lineage, sign-off queue, DB effects
        ├──► @pm/persistence  (markets, pool_utxos full-state, trades, tokens, broadcasts)
        ├──► @pm/lmsr         (pure quote math — the ground truth)
        ▼
ChainEngine (@pm/engine)   ◄── RunarEngine (now)  →  ScryptEngine (Phase 2), same interface
```
**Sign-off queue (human gate):** a state-changing op builds a `TxPlan` (unsigned descriptor + DB effects, no
keys) → `broadcasts` row `pending`. `POST /broadcasts/:id/authorize` is the ONLY place the funding WIF is used:
the engine rebuilds+signs+broadcasts, then the service applies effects atomically and advances `pool_utxos`.
Nothing reaches mainnet without an authorize call (ADR-010/015). Under Rúnar, deploy/plain-buy/sell/resolve are
live-capable; token-mint buy and redeem return **501** (BUG-005) — the documented Phase-2 (sCrypt) boundary.

## The on-chain / off-chain boundary
The chain is the real ledger; everything local is either ground-truth math or an audit trail.
- **On-chain (BSV, via Rúnar + @bsv/sdk):** the Market Pool stateful UTXO (holds reserve sats + `q`/`e`
  state), YES/NO token UTXOs, oracle-signed resolution, winner redemption.
- **Off-chain (local):** `@pm/lmsr` exact reference math; SQLite tracking of market/UTXO-version/token/trade
  lineage; the CLI that builds and broadcasts txs; and (ADR-019) the **off-chain execution engine** — instant
  fills against signed receipts, batched into one on-chain settlement.

> **Corrected 2026-08-07 (FUND-001 / ADR-040).** This section used to end "No custodial user balances", and the
> buy flow below described "spending pool v_n + buyer funding". Both drifted out of date when off-chain
> execution landed, and the gap was worse than stale prose: for a period **no trader money entered the system at
> all** — a trader signed a message, `cost_sats` was recorded, nothing collected it, and winners were paid from
> the operator's wallet. Today a buy IS funded: the trader pays a BRC-29 destination and the daemon verifies
> that payment before a fill exists. The stake is then **custodied by the operator** between bet and payout,
> which is ADR-019's first trust rung, chosen deliberately. The pool UTXO still holds only dust
> (`POOL_SATS = 1`) and `collateral` remains contract state — moving real satoshis into the pool is the next
> step, and until then the contract's `insolvent` asserts are bookkeeping, not backing.
>
> **Extended 2026-08-10 (ADR-041).** The return leg matched: a winner is paid at a one-time BRC-29 destination
> derived for them, not at `hash160(their identity key)` — which is a real address no wallet watches, so the
> money was on-chain, theirs, and effectively unspendable. The daemon serves the derivation at
> `GET /markets/:id/payouts`, and `GET /markets/:id/claim` returns the prepared `internalizeAction` so the
> winner's wallet credits the balance itself (ADR-042) — **once the payout is mined**, because a wallet wants a
> merkle proof and the covenant's ancestry is far too heavy to carry instead. **Sells remain owed rather than
> paid** until the server wallet lands.

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
