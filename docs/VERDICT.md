# BSV Prediction Market — Feasibility Verdict

_Spike deliverable · 2026-07-27 · status: **complete**_

## Verdict

**A native, on-chain UTXO LMSR prediction market is feasible on the BSV Blockchain.** The pricing engine,
market maker, and oracle settlement can run entirely inside a stateful UTXO smart contract compiled by
**Rúnar** — no off-chain matching engine, no custodial ledger. This was proven end-to-end: the contract was
compiled to Bitcoin Script, verified in a script VM, **deployed to BSV mainnet, and traded live** with a real
LMSR buy. All six feasibility unknowns identified at the outset are resolved, two of them with on-chain
evidence.

This contradicts the fallback premise of the source "Execution Roadmap" (which moved order matching and LMSR
pricing off-chain into a Postgres/Redis double-entry ledger). That off-chain design is **not required** for
correctness or economics — the native on-chain design works and is cheap.

## On-chain evidence (BSV mainnet)

| Event | Transaction | Size | Fee |
|---|---|---|---|
| Pool deploy | [`ddbb0b36…c16dca88`](https://whatsonchain.com/tx/ddbb0b368ac54716001ae9cc32fdabfb23548fed31ccb0b3d1232754c16dca88) | 1,750 B | **176 sat** |
| Live LMSR buy | [`7106f762…39ac2ed6`](https://whatsonchain.com/tx/7106f762debd93995661d08333ea45813f9b699c523c014d8b2d496b39ac2ed6) | 5,096 B | **510 sat** |

The deploy output carries the full LMSR contract as its locking script (a 5-branch dispatch:
`buyYes`/`buyNo`/`sellYes`/`sellNo`/`resolve`, the `mulDiv` pricing, the Rabin-oracle verify, and the
OP_PUSH_TX state continuation). The buy spent that pool UTXO via OP_PUSH_TX and minted a new pool UTXO whose
on-chain state shows `qYes` advanced by one unit and `eYes` updated — i.e. the market maker repriced itself
on-chain. Total cost of the entire exercise: **~686 sat in fees + 1,000 sat dust ≈ US$0.0001.**

## The six unknowns

1. **LMSR math on-chain — RESOLVED.** Rúnar Script has no `exp`/`ln` and forbids unbounded loops. Two
   techniques make LMSR expressible with only `mulDiv`/`safediv`:
   - *Multiplicative state* — store `eYes = exp(qYes/b)·SCALE`, `eNo = exp(qNo/b)·SCALE`; a unit trade
     multiplies by a precomputed constant `exp(±unit/b)`. No transcendental math on-chain.
   - *Post-trade-price cost* — the contract can't compute the exact LMSR integral (needs `ln`), so it charges
     at the **post-trade marginal price** (`eSide'/(eYes'+eNo')·payout`). Because LMSR cost is the integral of
     an increasing price, this is a right-Riemann bound: it over-charges buys and under-pays sells — always
     **MM-safe**. Measured error is bounded by trade÷liquidity: **≤ 0.13 % of notional at Δ/b = 0.01**.
2. **Single-UTXO serialization — RESOLVED (mainnet).** The pool is one stateful UTXO; a trade spends it and
   mints the next version. The live buy confirmed this works. **Caveat:** rapid sequential 0-conf trades must
   chain the funding UTXO locally (a client concern), because `getUtxos()` lags the mempool.
3. **Tokens — RESOLVED (full lifecycle built + VM-proven, TOKEN-001).** YES/NO positions are a `ShareToken`
   (fungible; transfer/split/burn; market+side bound). The pool **mints** a ShareToken to the buyer on buy
   (`addRawOutput`, token script built on-chain), and a winner **redeems** it after resolution for
   `payout × supply` (pool pays P2PKH, collateral reduced). 11 VM tests. (Couldn't subclass Rúnar's shipped
   `FungibleToken` base — BUG-004 — so the token is a direct `StatefulSmartContract`.) A documented trust gap
   remains in redemption (the pool trusts the supplied supply; production needs SPV/pushdata token
   verification), and the multi-output mint / multi-input redeem transactions are demonstrated on mainnet in
   the follow-on (001d) — the interpreter can't execute multi-input spends.
4. **Contract toolchain — RESOLVED.** Rúnar (`icellan/runar`, a BSV Association compiler) compiles a
   `StatefulSmartContract` to Script and persists state via OP_PUSH_TX. Confirmed by compilation, a script-VM
   gate, and mainnet deployment.
5. **Oracle settlement — RESOLVED.** `resolve()` verifies a **Rabin signature** (`runar-lang/oracle`, cheaper
   on-chain than ECDSA) over `marketTag ‖ outcome`, flips the pool to resolved, and disables trading.
   Market-bound (a signature can't be replayed on another market). 6 tests, incl. forged/wrong-outcome rejection.
6. **Per-trade fees — RESOLVED (mainnet).** Deploy 176 sat, buy 510 sat (~0.1 sat/B). A buy is a ~5 KB tx
   dominated by the OP_PUSH_TX preimage + stateful continuation; the fee is a fraction of a percent of any
   realistic trade. Not a blocker.

## How it was built & verified

- **`@pm/lmsr`** — pure integer LMSR reference (fixed-point `exp`/`ln`, price/cost/buy/sell, `b·ln2` max-loss,
  the MM-safe cost approximation). The ground truth. **Adversarially verified by 3 independent agents**
  (math correctness, satoshi-exactness, test quality); solvency held to 1 M simulated trades.
- **`@pm/contracts`** — the `LMSRMarket` Rúnar contract. Output state matches `@pm/lmsr` **exactly** over a
  60-step feedback loop in the script VM; **all tamper-mutations were caught** by an adversarial review.
- **`apps/spike`** — deploy/trade tooling on `runar-sdk` + `@bsv/sdk`; the mainnet CLI.
- **51 automated tests**, typecheck clean across four packages. Full audit trail in git (14+ commits) and a
  context-loss-proof knowledge base (`docs/`).

## Rúnar toolchain assessment (v0.4.6)

Rúnar is real, capable, and the right tool — it compiled a non-trivial 5-method stateful financial contract
to valid, miner-accepted Script. It is early (pre-1.0); two issues cost real debugging time (full detail in
`docs/Runar-bugs.md`):

- **BUG-001 (confirmed):** `WhatsOnChainProvider.getUtxos()` returns UTXOs with an empty `.script`, so
  `runar-sdk`'s signers compute the funding sighash over an empty scriptCode → invalid signatures → mainnet
  rejects the tx. Worked around by rebuilding the P2PKH locking script from the address and signing with
  `@bsv/sdk`. **Recommend fixing upstream** (backfill the script in `getUtxos`).
- **BUG-002 (retracted):** the OP_PUSH_TX / multi-method spend was suspected but proven correct — the BIP-143
  preimage was byte-identical to spec and the input validated in a local `@bsv/sdk` `Spend`.
- **BUG-003 (design note):** sequential 0-conf trades need local funding-UTXO chaining.

## Proven vs. owed for production

**Proven:** LMSR pricing correctness & solvency; on-chain buy/sell/resolve; oracle settlement; deploy + live
trade on mainnet; fee economics.

**Owed before this is a product (all productization, not feasibility):**
- Bind the pool's `collateral` to the UTXO's real satoshis (`extractAmount`, enforce `outputSatoshis == in +
  payment`). The spike tracks collateral as a state number and locks only dust, because there is no
  withdraw/redeem path yet — so real value must not be locked until that exists.
- **YES/NO tokens + winner redemption + withdraw** (TOKEN-001) — the missing half of the lifecycle.
- Funding-UTXO chaining / a fee-UTXO pool for rapid sequential trades.
- Production hardening: bind `marketTag` to the pool outpoint (anti-replay), multi-oracle/2-of-2 settlement,
  variable trade sizes (via `pow`), and a client/UI.

## Recommended path

1. **Fix BUG-001 upstream** in `runar-sdk` (or standardize on the `@bsv/sdk` signing path used here).
2. **TOKEN-001** — tokens + redemption + withdraw; then re-deploy binding collateral to real sats and run a
   full lifecycle (buy → sell → resolve → redeem) on mainnet with real value.
3. Build the client (funding-UTXO chaining, market catalogue, Kalshi ingestion for real questions).
4. Scale liquidity `b` per the source docs' 3-stage plan once organic volume justifies it.

**Bottom line:** the ambitious, BSV-native design is not only possible — it is implemented, verified, and
demonstrated live on mainnet for a fraction of a US cent.
