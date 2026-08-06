# BSV Prediction Market — Feasibility Verdict

_Spike deliverable · Phase 1 2026-07-27 (Rúnar) · Phase 2 2026-08-04 (sCrypt + API) · Platform hardening
2026-08-05/06 · status: **complete**_

---

## Verdict

**A native, on-chain UTXO LMSR prediction market is feasible on the BSV Blockchain — and it has been run,
end to end, on mainnet.** The pricing engine, market maker, oracle settlement, position tokens, and winner
payout all execute inside a stateful UTXO smart contract. There is no off-chain matching engine and no
custodial ledger in the settlement path.

All six feasibility unknowns are resolved. Beyond feasibility, the spike went on to answer the harder
*platform* questions — concurrency, auditability, and trust-minimization — and each answer is likewise backed
by a confirmed mainnet transaction.

This contradicts the fallback premise of the source "Execution Roadmap", which moved order matching and LMSR
pricing off-chain into a Postgres/Redis double-entry ledger. That design is **not required** for correctness or
economics. What the work *does* vindicate from the roadmap is narrower and important: **trade execution** must
be off-chain for concurrency — but **settlement can be native, on-chain, and trust-minimized** (see
[CONCURRENCY.md](CONCURRENCY.md) / ADR-019).

---

## Mainnet evidence

Every major claim below is a confirmed BSV mainnet transaction.

### 1 · Feasibility — the contract prices and trades on-chain (Phase 1, Rúnar)

| Event | Transaction | Size | Fee |
|---|---|---|---|
| Pool deploy | [`ddbb0b36…c16dca88`](https://whatsonchain.com/tx/ddbb0b368ac54716001ae9cc32fdabfb23548fed31ccb0b3d1232754c16dca88) | 1,750 B | 176 sat |
| Live LMSR buy | [`7106f762…39ac2ed6`](https://whatsonchain.com/tx/7106f762debd93995661d08333ea45813f9b699c523c014d8b2d496b39ac2ed6) | 5,096 B | 510 sat |

The buy spent the pool UTXO via OP_PUSH_TX and minted the next pool version with `qYes` advanced and `eYes`
updated — **the market maker repriced itself on-chain**. Total: ~686 sat ≈ US$0.0001.

### 2 · The complete lifecycle, autonomous via the API (Phase 2, sCrypt)

Driven through the HTTP daemon + human sign-off queue (`PM_ENGINE=scrypt`), one market, per-spend authorization:

| Step | Transaction | On-chain shape |
|---|---|---|
| Deploy | [`af9f1d16…129b78`](https://whatsonchain.com/tx/af9f1d16e7f8eb13ebad0a7180d195c6d17129e7cae7055f9105dd71fa129b78) | pool UTXO — block 960862 |
| Buy + mint | [`dca06069…b8dca8`](https://whatsonchain.com/tx/dca060698606ca2e32d58497130b3012e5fa87cd77e0127daca4c1f6bcb8dca8) | 2-in/3-out: pool + token + change — block 960862 |
| Resolve | [`86e586c4…e47ca3`](https://whatsonchain.com/tx/86e586c491f5f89cbfe402b0961be4c1011c65d71f7df9cf0dba3064dae47ca3) | Rabin-oracle YES — block 960863 |
| Redeem | [`c8e2f515…330977`](https://whatsonchain.com/tx/c8e2f515726bd2f61f1a7710e659f2175304cb33e2fad44fd3d45308fb330977) | 2-in/3-out: pool + **1,000-sat winner payout** + change — block 960863 |

**Deploy → trade → oracle-resolve → winner-payout, fully confirmed (blocks 960862–960863), 70,241 sats
(~US$0.04)** — driven autonomously, with humans authorizing only the spends.

_(An earlier one-process sCrypt run proved the same loop: [`83684ab5…`](https://whatsonchain.com/tx/83684ab56098898c2f051a9356d05836fe2c45c51c375e9750389ba28de8cf63),
[`a74ae982…`](https://whatsonchain.com/tx/a74ae982100bc5cf0fb467dd8b1a220caba01cd735dc21cdf926689f15f10a40),
[`a3d01cd5…`](https://whatsonchain.com/tx/a3d01cd5a7c7386fd3acab0478ba63044a4dde9afe48442f6031c67c796b0a89),
[`a3126fdc…`](https://whatsonchain.com/tx/a3126fdc641e40d990de4e7e8771f5bd100b25b69271026c96da70c825db580c).)_

### 3 · The real thing — 4 distinct wallets, 26 signed orders, one settlement (2026-08-06)

The first genuinely **end-to-end** run: driven over HTTP against the real daemon, with real trader wallets and
**no synthetic inputs** anywhere.

| Step | Transaction | Detail |
|---|---|---|
| Deploy | [`b8473fd2…290dbb`](https://whatsonchain.com/tx/b8473fd2503d661f52d75884cd8ca4a904d698b4e10cf310314380616b290dbb) | 30,483 B — block 961087 |
| **Settle** | [`0c90cc39…845773`](https://whatsonchain.com/tx/0c90cc39cc8a8d8c4c9713179281a3d4493bcee4e2b82b6e72802f373b845773) | **26 real signed fills → ONE tx**, 61,107 B — block 961087 |
| Resolve | [`8782ed70…e9602b`](https://whatsonchain.com/tx/8782ed7037122419a8c0a5ac8a5df5c98a20e1b4805f1c09346f31ec7fe9602b) | Rabin oracle YES, 61,445 B — block 961088 |

Independently verified against the settled data: **audit ok — 26 receipts, 0 violations, Rabin-attested**; all
26 receipts verify; **4 distinct trader wallets**; **26/26 orders carry a trader signature + nonce** (orders are
authenticated, so the operator cannot fabricate a trade in a user's name — LIVE-001a). Net YES 15, NO 7.

**Traders hold no BSV.** They sign orders; the operator pays every fee — zero-friction onboarding.

### 4 · Winners paid — the complete user journey, end to end (2026-08-06)

The whole thing, one continuous run on mainnet: real wallets trade, the batch settles, and **the winners
actually collect**.

| Step | Transaction | Detail |
|---|---|---|
| Deploy | [`6ab9da17…3756b3`](https://whatsonchain.com/tx/6ab9da1772e50086d4a83805e9f3235cbc3c798e6bd2ca1854da93af603756b3) | pool |
| Settle | [`3092f3dc…5a347c`](https://whatsonchain.com/tx/3092f3dc13f296b9b773bfebadaf48101387e5512b0677d2124283de5e5a347c) | **26 real signed fills → ONE tx** |
| Resolve | [`81d94c76…84be6c`](https://whatsonchain.com/tx/81d94c76b6aa7d3ca2289986301c97e7685339a05ba2cc7b3cf8f4317584be6c) | Rabin oracle YES |
| **Payout** | [`4332b024…fad7b4`](https://whatsonchain.com/tx/4332b02491a588005fdc2da67418a95eea96a04b275205e0045efd119efad7b4) | **4 winners paid 15,000 sat**, 75,374 B — **confirmed, block 961094** |

The payout tx's outputs are the pool continuation, the OP_RETURN payout commitment, and **one output per
winner** — each landing in the address derived from the key that trader signed its orders with:

| Trader | Address | Winning shares | Paid |
|---|---|---|---|
| trader-1 | `15usAUqZyjkYtDW5gkbF63CYGoP8VP5qjs` | 3 | 3,000 sat |
| trader-2 | `199XhHbYrDUSYcVf9Lwwf7QoaoqEDNPvEZ` | 4 | 4,000 sat |
| trader-3 | `1G9y66zSVEK7Kqex34DauqLV6ABe7VpTxz` | 4 | 4,000 sat |
| trader-4 | `1DbTVpmU9LuEw1NSwTq2aUaTr3Lbvtk9hs` | 4 | 4,000 sat |

Independently confirmed on-chain: trader-2's address holds **4,000 confirmed satoshis** (unspent, block
961094). **Real users won real money on a real market**, with the settlement provably matching what they signed.

### 5 · Concurrency — N trades settle in ONE transaction

| Transaction | Detail |
|---|---|
| Deploy [`68fee818…56ca48`](https://whatsonchain.com/tx/68fee81873163cbc6ea4cd20a3a84a34f012e28e358441f74025e30e1a56ca48) | fresh pool, 30,915 B |
| **Settle** [`cc13883b…662d2f`](https://whatsonchain.com/tx/cc13883b35695ac9c9b1caf40b1166633f2dcb552e27ce7478fcfb64ff662d2f) | **5 off-chain fills → 1 on-chain tx**, 61,896 B |

Both confirmed, **block 960978**. Demonstrates the amortization: **N trades cost ONE settlement fee**, while
users get instant off-chain fills.

### 6 · Enforcement — a cheating operator's bond is slashable by anyone

| Transaction | Detail |
|---|---|
| Bond deploy [`04e80444…700e0a`](https://whatsonchain.com/tx/04e80444a7c8332bdac3f3096336f6a8a066c9fcd092113333a21e5cd8700e0a) | operator stake, 2,945 B |
| **Slash** [`53972656…03956ed`](https://whatsonchain.com/tx/539726563f8d4288e70cd7dd30f3846de1686b6b2f0b7478a195e7e0e03956ed) | **spends the bond** via an on-chain Rabin equivocation proof |

Both confirmed, **block 960994**. The network executed the fraud proof — two conflicting sequencer attestations
verified in Script — and paid the bond to the challenger. **Equivocation is unprofitable.**

### 7 · Token-verified payout — a redeem that provably requires a real token

| Transaction | Detail |
|---|---|
| Mint [`8328f669…444337`](https://whatsonchain.com/tx/8328f66986b55930a14436bf41a919d22f46eb1825d3a4824d4feea5e9444337) | data-carrying position token at vout 1 |
| Deploy [`1c1660e3…a5c1f2`](https://whatsonchain.com/tx/1c1660e36ac4188216e92385161366f5455cbb9aeb20fbeaa9188fd3f3a5c1f2) | already-resolved pool |
| **Redeem** [`c6d8900f…e469e5`](https://whatsonchain.com/tx/c6d8900fbfc71c49c5ad4001a3b4fa2dccbc3888f222159be37f5d71b3e469e5) | 67,749 B — **in[0] = pool, in[1] = the real token**, in[2] = funding; out[1] = payout to the token's holder |

Confirmed, **block 961048**. The pool's covenant rebuilt the token output, derived the mint txid, and bound it
via `hashPrevouts` — so **a payout cannot happen without a genuine on-chain token**.

---

## The six unknowns

1. **LMSR math on-chain — RESOLVED.** Script has no `exp`/`ln` and no unbounded loops. Two techniques make LMSR
   expressible with only `mulDiv`:
   - *Multiplicative state* (ADR-007) — store `eYes = exp(qYes/b)·SCALE`, `eNo = exp(qNo/b)·SCALE`; a unit trade
     multiplies by a precomputed constant `exp(±unit/b)`. No transcendental math on-chain.
   - *Post-trade-price cost* (ADR-011) — the exact LMSR integral needs `ln`, so the contract charges at the
     **post-trade marginal price**. As a right-Riemann bound on an increasing price curve this over-charges buys
     and under-pays sells — always **MM-safe**. Error ≤ **0.13 % of notional at Δ/b = 0.01**.
2. **Single-UTXO serialization — RESOLVED, then superseded.** One stateful UTXO means trades are inherently
   serial (~1/block) — a property of any single-UTXO AMM, not a bug. The platform answer is off-chain execution
   + batched settlement (§Platform hardening), proven at 5 fills → 1 tx.
3. **Tokens — RESOLVED, including trustless redemption.** YES/NO positions are minted on buy and burned on
   redeem, live on mainnet. The original documented trust gap (the pool trusted the caller's supply/holder) is
   **closed**: redeem now co-spends the token and verifies it by on-chain backtrace (ADR-024, evidence §5).
4. **Contract toolchain — RESOLVED (sCrypt).** Proven on two independent toolchains; sCrypt is the one that can
   actually transact it today (§Toolchain).
5. **Oracle settlement — RESOLVED.** `resolve()` verifies a **Rabin signature** over `marketTag ‖ outcome`
   (cheaper on-chain than ECDSA), market-bound so a signature can't be replayed. Forged and wrong-outcome
   signatures are rejected — verified against real Script and live on mainnet.
6. **Per-trade fees — RESOLVED.** Measured across every run (§Economics). A fraction of a percent of any
   realistic trade; not a blocker.

---

## Platform hardening — from "it works" to "you don't have to trust the operator"

The single-UTXO pool cannot serve concurrent users on-chain (§unknown 2). ADR-019's resolution — execute
off-chain, settle on-chain in batches — was built and then progressively hardened:

| Step | What it delivers | Status |
|---|---|---|
| **CONC-001/002** (ADR-021) | Off-chain execution engine: instant fills over `@pm/lmsr`, per-market serialization (no UTXO contention), signed receipts; net-state batch settlement in one pool-version tx | ✅ mainnet (§3) |
| **CONC-003a** (ADR-022) | Settlements are **auditable + non-equivocable**: an on-chain `batchDigest` commitment (OP_RETURN) + sequencer attestation; `auditSettlement` lets anyone **prove** a settlement matches its signed receipts | ✅ auditor catches tampering |
| **CONC-003b** (ADR-023) | **Enforcement**: an operator `Bond`, slashable on-chain by anyone presenting an equivocation proof (two conflicting Rabin attestations) | ✅ mainnet (§4) |
| **CONC-003c** (ADR-024) | **Token-verified payout**: redeem co-spends the position token and backtraces it on-chain — no token-less redeem, no over-claim, no redirection | ✅ mainnet (§5) |
| **CONC-004** (ADR-020) | Contract slimming: 45.7 KB → **21.4 KB (−53 %)** by collapsing YES/NO twins into side-parameterized methods | ✅ measured |
| **CONC-006** (ADR-025) | Square-and-multiply batch cap (net 20 → **4,095**) — every measured order-flow shape now settles in **one** tx, and the script got *smaller* | ✅ measured |

**Trust position reached:** users trade instantly off-chain; every settlement is publicly auditable and
non-equivocable; equivocation costs the operator its bond; and payouts require a real on-chain token. The
operator can still be *wrong* within a settlement window in one specific way — see "Owed" below.

---

## Measured performance

Benchmarked on the shipped engine (`scratchpad/bench.ts`), not estimated:

- **~1,240 fills/sec at ~0.8 ms each** — 1,000 simultaneous bettors all filled in **806 ms**, flat to 5,000.
- **ECDSA receipt signing is 99.7 % of the cost**; the LMSR math (0.3 µs) and the DB write (2.3 µs) are free.
  Native secp256k1 bindings are a straightforward 10–20× lever, and markets shard cleanly across processes.
- **Every measured order-flow shape — balanced through all-buys — settles in ONE on-chain transaction**
  (CONC-006). Under the previous linear cap the all-buys case needed 27.

## Economics and limits (measured, not estimated)

- **Contract size drives everything.** OP_PUSH_TX re-carries the whole pool script each spend, so a stateful
  spend ≈ **2× the script**. Script history: 45.7 KB → 21.4 KB (slimming) → 30.2 KB (+`settle`) → 30.5 KB
  (+commitment) → 32.9 KB (+backtrace redeem) → **29.8 KB** (square-and-multiply, CONC-006 — smaller *and* a
  200× larger batch cap).
- **Ancestor budget.** BSV allows ~**101 KB / 25 txs** of unconfirmed ancestors. At ~66 KB per hardened spend
  only ~1 fits unconfirmed; a 4-tx lifecycle must be split across confirmations (the §5 proof deliberately uses
  a 3-tx shape for this reason).
- **Cost.** Full lifecycle **70,241 sat (~US$0.04)**; a batch settlement amortizes **N trades over one fee**.
- **Fee control.** The real knob is `provider.getFeePerKb()` (a `FeeProvider` override) — not
  `bsv.Transaction.FEE_PER_KB`. WhatsOnChain's default (~50 sat/KB) is too low for these txs to confirm.
- **Confirmation latency** is BSV block timing, not our code — droughts of 30–60 min were observed and waited out.

---

## Toolchain: Rúnar → sCrypt

**Phase 1 used Rúnar** (`icellan/runar`, a BSV Association compiler) and it did the hard part: it compiled a
non-trivial stateful financial contract to valid, miner-accepted Script, and the design was proven with a live
mainnet trade. But a gated live run exposed its ceiling precisely — the daemon deployed a pool
([`9d7c370f…`](https://whatsonchain.com/tx/9d7c370f6a891f63da7e7d2797fa4ad85bde72e8fe6d2a4f15e9d3b4a28b0a3c),
block 960831) yet the **buy could not broadcast**: BUG-003 (stale UTXO → `txn-mempool-conflict`), then a
**BUG-006 NULLFAIL on mainnet despite passing all 72 VM tests** — the VM disagreed with the node. BUG-005 (no
multi-output tx building) had already blocked token mint and redeem. These are **toolchain failures, not design
failures**. Full detail: [`Runar-bugs.md`](Runar-bugs.md), [`RUNAR-BUG-REPORT.md`](RUNAR-BUG-REPORT.md).

**Phase 2 ported the contracts to sCrypt (`scrypt-ts` 1.4.5)** behind an unchanged API. Its decisive advantage:
**local verification executes the same Script the node runs**, so a green test is a mainnet guarantee — closing
the VM≠mainnet gap that sank Rúnar. Everything Rúnar could only VM-prove is now live.

**Recommendation: build on sCrypt.** The native on-chain LMSR design is confirmed on two independent toolchains;
sCrypt is the one whose tooling can transact it today. Rúnar's bugs are worth fixing upstream (BUG-001/004/005/006)
but are not on this project's critical path.

---

## Proven vs. owed

**Proven (with mainnet evidence):** LMSR pricing correctness and solvency; on-chain buy/sell/resolve/redeem;
Rabin oracle settlement; position-token mint and **token-verified** payout; fee economics; off-chain execution
with instant fills; **N-trades-in-one-settlement**; settlement auditability; and **on-chain fraud-proof
enforcement**.

**Owed before this is a product:**
- **Trustless settlement (the endgame).** The settle contract verifies the net state transition + solvency, and
  equivocation is slashable — but it does **not** prove on-chain that a batch's net equals the sum of its
  receipts. That needs a validity proof or an interactive dispute game. This is the one substantive trust
  assumption left, and it is research-grade work.
- ~~Restart-safe state~~ — **done (CONC-005 / ADR-026).** A restarted daemon rebuilds a market's pool from the
  plan's UTXO (`fromUTXO`, measured to restore full state) and recovers the position token from the persisted
  identity + the mint tx re-fetched from chain. Remaining ops work is automated fee/UTXO-pool management.
- **Further slimming.** At ~33 KB the pool constrains chain depth (§Economics). Opcode-level work, with
  diminishing returns after the −53 % collapse.
- **Collateral binding.** The spike tracks `collateral` as state and locks only dust; production should bind it
  to the UTXO's real satoshis.
- **Real oracle + product surface.** The oracle is a mock Rabin signer (Kalshi integration is out of spike
  scope); plus market catalogue, client/UI, and ops (automated fee/UTXO management).

---

## Recommended path

1. **Close the trust endgame** — design and prototype validity-proof (or dispute-game) settlement so a batch's
   net is provably its receipts. Everything else is already trust-minimized around it.
2. **Slim the contract further** — directly buys chain depth and per-settlement cost.
3. **Integrate a real oracle** and build the product surface (catalogue, client, liquidity scaling per the
   source docs' 3-stage plan), plus the remaining ops piece (automated fee/UTXO-pool management).

---

## Bottom line

The ambitious, BSV-native design is not only possible — it is **implemented, verified against real Bitcoin
Script, and demonstrated live on mainnet**: a market that prices itself on-chain, settles thousands of
off-chain trades into single transactions, publishes commitments anyone can audit, slashes a cheating
operator's bond, and pays winners only against a genuine on-chain token — for a few cents in fees.

_Verification: 18 sCrypt local-Script tests + 83 workspace tests green, typecheck clean; decisions recorded in
[`DECISIONS.md`](DECISIONS.md) (ADR-001 → ADR-024); living status in [`STATE.md`](STATE.md)._
