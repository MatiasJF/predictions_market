# Roadmap

Feasibility spike. Each milestone attacks the cheapest-to-falsify unknown first. The deliverable is a
verdict, not a product.

## The six feasibility unknowns (the spike exists to answer these)
1. **LMSR exp/log on-chain** — Rúnar has no exp/log/loops. Can the contract price/verify a trade at all?
   → multiplicative-state trick (ADR-007). Attacked by LMSR-001/002, CONTRACT-002.
2. **Single-UTXO serialization** — one pool UTXO; concurrent trades race. Real throughput/UX? → CHAIN-001.
3. **Token mint per trade** — mint YES/NO on buy, redeemable on settle. "BRC-100" status unverified. → CHAIN-002.
4. **Contract toolchain** — does Rúnar compile & run a stateful contract end-to-end? → CONTRACT-001 (gate).
5. **Oracle settlement sighash** — redeem token + resolved pool via ANYONECANPAY/SINGLE for exactly 100k. → SETTLE-001.
6. **Per-trade fee economics** — every micro-trade is a full tx. Fee-to-trade-size at realistic sizes? → CHAIN-001.

## Phases
| Phase | Name | Covers unknowns | Status |
|---|---|---|---|
| **P0** | Foundation (repo + KB + data model) | — | ● done |
| **P1** | Feasibility core (LMSR math + Rúnar toolchain gate) | 1, 4 | ◐ starting |
| **P2** | On-chain lifecycle (trade serialization, tokens, settlement) | 2, 3, 5, 6 | ○ planned |
| **P3** | Mainnet proof + written feasibility verdict | all | ○ planned |

## Milestone → ticket map (see STATE.md for live status)
- **M0 — de-risk math off-chain:** LMSR-001, LMSR-002.
- **M1 — contract feasibility:** CONTRACT-001 (gate), CONTRACT-002.
- **M2 — live trade serialization:** CHAIN-001 (throughput + fee numbers — decides native vs hybrid).
- **M3 — tokens + oracle + redemption:** CHAIN-002, SETTLE-001.
- **M4 — mainnet proof + verdict:** OPS-004 (gated mainnet run + report on all six unknowns with real data).

## Exit criteria (what "done" means for the spike)
A written verdict: **native viable / native-for-settlement-only / hybrid required**, each unknown answered
with evidence (test results, a testnet txid trail, measured fee & throughput), and a recommended next step.
