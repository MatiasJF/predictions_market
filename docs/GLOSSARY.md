# Glossary

**LMSR (Logarithmic Market Scoring Rule)** — an automated market maker that always quotes a buy/sell price.
Cost function `C(q) = b · ln( Σ exp(qᵢ / b) )`; marginal price of outcome i `= exp(qᵢ/b) / Σ exp(qⱼ/b)`.
YES + NO prices always sum to the payout unit. Provides liquidity from t=0, unlike an empty order book.

**b (liquidity parameter)** — controls price sensitivity. Higher `b` = deeper liquidity, smaller price moves
per trade, but larger max loss. Scaled to an integer in our code.

**b·ln2 (max loss ceiling)** — the LMSR market maker's maximum possible loss for a binary market is exactly
`b · ln(2)`. This many sats are locked into the pool at creation so winners can always be paid. e.g.
`b=200,000 → 138,630 sats`.

**Payout unit** — sats a winning share redeems for at settlement. Fixed at `100,000 sats` per share here.

**Market Pool UTXO** — the single stateful UTXO holding the market's reserve sats and LMSR state
(`q_yes/q_no`, `e_yes/e_no`). Each trade spends it and creates the next version (v0 → v1 → v2 …).

**Multiplicative-state trick** — because Rúnar has no `exp`, we store `e_yes = exp(qYes/b)·SCALE` and
`e_no = exp(qNo/b)·SCALE` as state. A fixed-unit buy multiplies the stored value by the precomputed constant
`exp(u/b)` — pure bigint mul/div, no transcendental math, no loop. Core technique under test (ADR-007).

**SCALE** — fixed-point scaling factor for integer math (e.g. `1e8`). All prices/state are integers × SCALE.

**Rúnar** — BSV Association compiler (repo `icellan/runar`) turning TypeScript/Rust/Go/Python into Bitcoin
Script. Supports stateful contracts via **OP_PUSH_TX**. Packages: `runar-lang`, `runar-compiler`,
`runar-cli`; SDK `runar-sdk`. **Constraints that shape this project: no exp/log/fixed-point primitives; no
unbounded loops or recursion.** Only bigint arithmetic, bitwise, comparison, hashes, `checkSig`.

**OP_PUSH_TX** — technique letting a Bitcoin Script inspect the spending transaction (via a pushed,
signature-checked preimage), enabling a contract to enforce properties of its own next state/output. How
Rúnar persists stateful-contract state across transactions.

**Stateful smart contract** — a contract whose state must persist across multiple transactions (vs a
stateless true/false unlock). Realised on BSV by carrying state in the output and constraining the next
output via OP_PUSH_TX.

**Token UTXO (YES/NO)** — the claim ticket a buyer receives. At settlement a winning token is spent together
with the resolved pool to extract `payout_unit` sats. Docs call these "BRC-100"; that standard's fitness is
unverified (STATE.md Open Q4) — a minimal token-UTXO representation suffices for the spike.

**Oracle** — the platform/Kalshi key that signs the real-world outcome ("Market N = YES") at close. Mocked
in this spike (a signed message), not the live Kalshi API.

**Settlement / redemption** — after the oracle signs, the pool enters resolved mode and pays a flat
`payout_unit` per winning share. Winners spend token + resolved pool (ANYONECANPAY/SINGLE sighash) to claim.

**0-conf** — accepting an unconfirmed transaction. Relevant to trade UX and the single-UTXO race (Open Q3).

**BEEF / SPV** — Background Evaluation Extended Format / Simplified Payment Verification: how a wallet proves
a UTXO's validity without a full node. Referenced by the source docs' wallet-connection design (out of spike scope).
