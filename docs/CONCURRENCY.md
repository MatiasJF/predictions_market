# Concurrency architecture — from a proven single-market core to a many-user platform

_Design doc · 2026-08-04 · follows the mainnet full-circle proof (VERDICT.md). Decision recorded as ADR-019._

## The problem, stated precisely

The LMSR market is **one stateful pool UTXO**. Every trade spends the current pool UTXO and creates the next
version (`eYes/eNo/qYes/qNo/collateral` advanced). On a UTXO chain a given UTXO can be spent by **exactly one**
transaction, so:

- Two users trading at the *same* pool version both build a tx spending the *same* UTXO → only one is valid; the
  other is a double-spend and must retry against the new version.
- Trades against a pool are therefore **totally ordered** — one state-transition per tx, strictly serial.

This isn't a bug or a sCrypt limitation — it is an **inherent property of a single-UTXO AMM on any UTXO chain**.
The question is not "how do we remove the serialization" (we can't, on-chain) but **"where does serialization
happen, and how do we get throughput + good UX + trust-minimized settlement around it."**

### What the mainnet run taught us (hard numbers, not theory)

- A stateful **spend is ~93 KB** (OP_PUSH_TX re-carries the whole pool script). Deploy ~46 KB.
- BSV's unconfirmed-ancestor budget is ~**101 KB / 25 txs**. At 93 KB/tx that's **~1 unconfirmed trade at a
  time** — you must wait for a **confirmation between trades**. Even a slim 5 KB contract only buys ~20 chained
  trades per confirmation window.
- So **naive on-chain trading tops out at roughly one trade per block (~10 min)** until the contract is slimmed —
  and even then it's tens-per-block, not thousands-per-second. Confirmed live: deploy+buy, wait a block,
  resolve+redeem.
- Per-trade cost ≈ **15–20k sat (~$0.01–0.02)** at a confirm-worthy fee.

**Conclusion:** pure on-chain, one-tx-per-trade cannot serve concurrent users at interactive latency. A platform
needs an **execution layer that serializes trades fast (off-chain), and an on-chain layer that settles
trust-minimized (batched).**

## The design space

| Option | Idea | Throughput | Trust | Verdict |
|---|---|---|---|---|
| **A. Pure on-chain, serial** | one tx per trade, an operator chains pool versions | ~1/block (or ~tens/block if slimmed) | trustless settlement; operator can reorder | too slow for interactive use; keep as the *settlement primitive*, not the trading path |
| **B. Sharded / parallel pools** | N pool UTXOs, trades spread across them | N× | trustless | ✗ **breaks LMSR**: LMSR price needs a *single global* `q`; splitting it destroys the invariant and invites cross-shard arb. Not viable for an AMM. |
| **C. Off-chain match + on-chain settle** | authoritative LMSR runs off-chain, instant fills; settle net state periodically | very high | custodial during the window → reducible with proofs | ✓ the roadmap's instinct — but now anchored to a *proven* on-chain settlement |
| **D. Batched on-chain** | a sequencer clears a short window of orders into ONE pool-version tx | high (amortized) | operator computes the batch | ✓ the settlement mechanics for C |
| **E. State channels** | pool state in a channel | high | 2-party | ✗ a market is N-party; channels don't fit |

Sharding (B) is the tempting "just parallelize it" answer and it's the one to *rule out explicitly*: an AMM's
whole point is a single consistent price surface from one state. You cannot split that state and keep the price
correct without a cross-shard consensus that costs more than it saves.

## Recommended architecture: off-chain execution + on-chain batched settlement (C + D)

Think of it as an **app-specific rollup for the market**: execute fast off-chain, settle trust-minimized
on-chain. Three layers:

```
 users ──signed orders──▶  EXECUTION LAYER (off-chain, authoritative, fast)
                            • @pm/lmsr runs the live LMSR state in memory
                            • serialises concurrent orders instantly (no UTXO contention)
                            • instant fills at the current marginal price
                            • issues a SIGNED RECEIPT per fill (position + state commitment)
                            • @pm/persistence = the order/position/receipt ledger
                                    │
                                    ▼  every N trades / T seconds / per block
                        SETTLEMENT LAYER (on-chain, trust-minimized)
                            • ONE pool-version tx advances eYes/eNo/collateral to the batch's net state
                            • mints/burns the batch's ShareTokens (multi-output — sCrypt does this)
                            • the ScryptEngine we built, extended from 1-trade-per-tx → 1-batch-per-tx
                                    │
                                    ▼
                        BSV mainnet — the single pool UTXO, one writer (the sequencer)
```

**Why this dissolves the concurrency problem:**
- Concurrent trades are ordered by the **off-chain engine** (in-memory, microseconds) — there is no user-vs-user
  UTXO race, ever.
- The **single pool UTXO has exactly one writer** (the sequencer), so no on-chain double-spend contention.
- Users get **interactive fills** (off-chain latency); the chain sees **one amortized settlement per batch**
  (cost/trade → cents/hundreds → sub-cent).

### The trust spectrum (ship custodial, harden toward trustless)

The only thing users trust off-chain is the window between settlements. That trust is *tunable*, and you can ship
early and harden:

1. **Custodial + signed receipts (MVP).** The sequencer holds collateral in the pool; every fill is a signed
   receipt the user keeps. Frequent settlement (seconds) bounds exposure. Good enough to launch + measure.
2. **Bonded + fraud proofs.** The operator posts a bond; anyone can submit an on-chain fraud proof that a
   settlement doesn't match the receipts / LMSR rules, slashing the bond. Now cheating is unprofitable.
   _Progress: CONC-003a (ADR-022, DONE) delivered the auditability substrate — each settlement pins a `batchDigest`
   commitment on-chain (OP_RETURN) + a sequencer attestation, and `auditSettlement` lets anyone PROVE a settlement
   matches its signed receipts (detection). **CONC-003b (ADR-023, DONE)** added the enforcement: a `Bond` contract
   holding the operator's stake, slashable on-chain by anyone presenting an equivocation proof (two conflicting
   Rabin-signed attestations for one settlement), verified via `RabinVerifier`. Equivocation is now unprofitable.
   Remaining: full net-vs-receipts enforcement (validity proof / dispute game) — step 3 below._
3. **Validity-proof settlement (endgame).** The pool contract verifies, on-chain, that the batch's net state
   change and token issuance are a correct LMSR transition from the prior state (a compact proof / the contract
   re-checks the net `eYes/eNo` update against the batch's signed orders). Now settlement is **trustless** — the
   sequencer *cannot* settle a wrong state. This is where the spike's on-chain-LMSR proof pays off: we already
   proved the pool can verify an LMSR state transition + oracle sig + multi-output payout on-chain.

Start at (1), design toward (3). Each step reuses the same execution + settlement split.

### Batch settlement mechanics (concrete)

- The engine accumulates net `ΔqYes, ΔqNo` and the set of `(holder, side, shares)` mints/burns over the window.
- One settlement tx: spend pool `v_n` → pool `v_{n+1}` with `eYes' = eYes·mult^ΔqYes` (bounded `pow`, or the
  exact recompute off-chain + on-chain post-trade-price bound, ADR-011), collateral adjusted by net cash, plus
  the batch's ShareToken outputs. This is the multi-output tx we **already proved** on mainnet — generalized from
  one mint to a batch.
- Because it's **one pool-version advance per batch**, the mempool-ancestor limit is a non-issue (you settle,
  wait one confirmation, settle the next batch) — and cost is amortized across the whole batch.

### Measured throughput (2026-08-06, `scratchpad/bench.ts` on the shipped engine)

- **~404 fills/sec, ~2.5 ms per fill** now that orders are trader-authenticated (LIVE-001a adds an ECDSA
  verify per fill; it measured ~1,240 fills/sec before that), flat from 100 → 5,000 concurrent (1,000 simultaneous bettors are all
  filled in **806 ms**). No collapse under load.
- **ECDSA receipt signing is 99.7 % of the cost** (790 µs/fill, ~1,266/sec ceiling). LMSR math is 0.3 µs and the
  SQLite insert 2.3 µs — both free by comparison. Native secp256k1 bindings are the obvious 10–20× lever.
- Many markets in one process does **not** raise aggregate throughput (single-threaded + signing-bound) —
  scale-out means sharding markets across processes/cores.
- **Fills per on-chain settlement (CONC-006):** after replacing `settle`'s linear loop with square-and-multiply
  (`MAX_NET = 4095`), **every measured flow shape settles in ONE tx** — balanced (net 16), 55 % skew (88), 70 %
  skew (238), and all-buys (530). Under the old linear cap of 20 those needed 1 / 5 / 12 / **27** settlements.

### Throughput / latency / cost, honestly

- **Trading latency:** off-chain, milliseconds (interactive). ✓
- **Settlement latency:** one batch per few seconds–one block; a user's fill is *economically final* on a signed
  receipt immediately, *chain-final* at the next settlement.
- **Throughput:** thousands of orders/sec off-chain; on-chain load = batches/hour, independent of trade count. ✓
- **Cost:** ~$0.01–0.02 per *batch* settlement amortized over many trades → sub-cent/trade. ✓ (Slimming the
  contract, item below, cuts this further.)

## What this reuses (we are not starting over)

- **`@pm/lmsr`** — already the authoritative, tested integer LMSR engine → *is* the execution layer's pricing.
- **`@pm/persistence`** — the SQLite ledger → orders/positions/receipts/settlement lineage.
- **`ScryptEngine` + the sCrypt contracts** — the settlement layer; extend "one trade → one tx" to "one batch →
  one tx" (net state + batch token set). The multi-output tx, oracle resolve, and payout are proven on mainnet.
- **The daemon + sign-off queue** — becomes the sequencer's control plane; human authorization gates settlements
  (and later, an automated bonded operator).
- The **`ChainEngine` seam** means the settlement engine stays swappable.

## The synthesis (and the answer to the project's founding tension)

The two source PDFs proposed opposite designs: **native on-chain** vs **off-chain custodial ledger**. This spike
proved native-on-chain is **feasible and confirmed on mainnet**. This analysis shows that for **concurrent
users**, native-on-chain-per-trade **cannot** scale — you need off-chain execution. **The resolution is not
either/or: it's off-chain *execution* + on-chain *LMSR settlement*.** The roadmap was right that trading must be
off-chain; the spike was right that settlement can be native on-chain and trust-minimized. The platform is the
synthesis — and crucially, the hard part (a pool contract that can verify LMSR state + oracle + multi-output
payout on-chain) is the part we already built and confirmed.

## Concrete next build (proposed phases)

- **CONC-001 — Execution layer MVP: DONE (2026-08-05, ADR-021).** `@pm/execution` fills orders instantly over
  `@pm/lmsr`, serializes concurrent submits per market (no UTXO contention), persists signed receipts to
  `exec_orders`. Proven by a 25-way concurrency test (seq 1..N, final == N sequential fills).
- **CONC-002 — Batched settlement: LOCAL-VERIFIED (2026-08-05, ADR-021); mainnet run pending.** Net-state MVP —
  a whole batch collapses into ONE pool-version tx via the `settle` contract method (`eYes *= mult^(net units)`,
  path-independent), enqueued through the human sign-off queue. Position tokens stay as signed receipts (full
  per-participant on-chain minting + exact-cash validity are CONC-003). Local Script-verify green; gated mainnet
  settlement is the remaining step.
- **CONC-003 — Trust hardening:** signed-receipt verification → operator bond → fraud-proof path; then design the
  on-chain validity check (trustless settlement).
- **CONC-004 — Contract slimming (parallel): FIRST CUT DONE (2026-08-05, ADR-020).** Collapsed the 9 YES/NO
  twin methods to 4 side-parameterized ones (`buy/sell/resolve/redeem`) — measured **45.7 KB → 21.4 KB locking
  script (−53%)**, per-spend ~93 KB → ~44 KB, pricing unchanged (equivalence + local-verify tests green). Note:
  the ablation showed pushing state off the covenant into a commitment barely helps (the bulk is method *code*,
  not the state ints), and moving Rabin off the trade path saves only ~5 KB (needs a 2nd contract) — so further
  slimming is opcode-level (shared math), with diminishing returns vs. this collapse.
- **CONC-005 — Ops:** restart-safe state (reconstruct pools from chain), automated fee/UTXO-pool management (the
  fee-control + funding findings from SCRYPT-005 become the sequencer's job).
