# Roadmap

Feasibility spike. Each milestone attacks the cheapest-to-falsify unknown first. The deliverable is a
verdict, not a product.

## The six feasibility unknowns (the spike exists to answer these)
1. ✅ **LMSR exp/log on-chain** — Rúnar has no exp/log/loops. **RESOLVED:** multiplicative-state trick (ADR-007)
   for state; post-trade marginal price (ADR-011, LMSR-002) for MM-safe cost — both need only `mulDiv`. Error
   bounded by trade÷liquidity (cap Δ/b≤~0.01). Remaining work is to enforce it in the Rúnar contract → CONTRACT-002.
2. **Single-UTXO serialization** — one pool UTXO; concurrent trades race. Real throughput/UX? **Still fully
   open — needs real chain.** → DEPLOY-001.
3. **Token mint per trade** — mint YES/NO on buy, redeemable on settle. **Primitive found:** `runar-lang/tokens`
   (not "BRC-100"). → TOKEN-001.
4. ✅ **Contract toolchain** — does Rúnar compile & run a stateful contract? **RESOLVED:** yes, offline gate
   passed (CONTRACT-001, ADR-009). No scrypt-ts fallback.
5. **Oracle settlement sighash** — redeem token + resolved pool via ANYONECANPAY/SINGLE for exactly 100k.
   **Primitive found:** Rabin sigs (`runar-lang/oracle`). → SETTLE-001.
6. **Per-trade fee economics** — every micro-trade is a full tx. Fee-to-trade-size at realistic sizes?
   **Needs real chain.** → DEPLOY-001.

## Phases
| Phase | Name | Covers unknowns | Status |
|---|---|---|---|
| **P0** | Foundation (repo + KB + data model) | — | ● done |
| **P1** | Feasibility core (LMSR math + Rúnar toolchain gate) | 1 (partial), 4 | ◐ CONTRACT-002 left |
| **P2** | On-chain lifecycle (cost-verify, tokens, settlement, first deploy) | 1, 2, 3, 5, 6 | ○ planned |
| **P3** | Mainnet proof + written feasibility verdict | all | ○ planned |

## Milestone → ticket map (see STATE.md for live status)
- **M0 — de-risk math off-chain:** LMSR-001 ●, LMSR-002 ● (on-chain cost-without-`ln`, ADR-011).
- **M1 — contract feasibility:** CONTRACT-001 ● (gate), CONTRACT-002 ◐ (LMSR buy in Rúnar).
- **M2 — on-chain cost verification + tokens:** CONTRACT-003, TOKEN-001.
- **M3 — oracle + redemption + first real deploy:** SETTLE-001, DEPLOY-001 (throughput + fee numbers — decides native vs hybrid).
- **M4 — mainnet proof + verdict:** OPS-004 (gated mainnet run + report on all six unknowns with real data).

## Exit criteria (what "done" means for the spike)
A written verdict: **native viable / native-for-settlement-only / hybrid required**, each unknown answered
with evidence (test results, a mainnet txid trail, measured fee & throughput), and a recommended next step.
