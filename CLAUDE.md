# BSV Prediction Market — Boot File

**Read order for cold start (do this first, every time): `CLAUDE.md` → `docs/STATE.md` → `docs/INDEX.md`.**
Those three reads reconstruct the full project. Everything else is reference.

## What this is
A **feasibility spike**, not a product. Goal: prove whether a **binary prediction market can run as a
native on-chain UTXO Automated Market Maker on BSV** — where the LMSR (Logarithmic Market Scoring Rule)
pricing lives *inside* a stateful UTXO smart contract compiled by **Rúnar**, trades mint YES/NO token
UTXOs, and an oracle-signed settlement pays winners `100,000 sats`/share. We build the smallest thing
that answers "does this actually work on BSV?" and produce a written verdict backed by working code.

The source vision is in `docs/` (two PDFs + `code_example_runar.js`). Note: those two PDFs describe
**two different architectures** — a native on-chain one and an off-chain custodial-ledger one. **We are
building the native on-chain one** (see ADR-004). The off-chain roadmap is context, not our target.

## How it works (one paragraph)
LMSR needs `exp`/`ln`; Rúnar Script has **no exp/log and no unbounded loops** (see GLOSSARY, ADR-002).
So the contract can't compute LMSR math directly. The core technique under test is the
**multiplicative-state trick**: store `e_yes = exp(qYes/b)·SCALE` and `e_no = exp(qNo/b)·SCALE` as UTXO
state; a fixed-unit buy just multiplies the stored value by a precomputed constant `exp(u/b)` — pure
bigint mul/div, no exp, no loop. The **open question** is verifying LMSR *cost* on-chain without `ln`
(see STATE.md Open Questions). Off-chain we keep a pure integer LMSR reference (`@pm/lmsr`) as ground
truth and a local SQLite store (`@pm/persistence`) tracking market/UTXO/token lineage across a run.

## Golden Rules (obey these)
1. **The KB is part of every change (Definition of Done).** No ticket is done until `docs/STATE.md`
   reflects it, `docs/INDEX.md` is updated if files moved, `docs/DECISIONS.md` is appended if a choice
   was made, and `ARCHITECTURE.md`/`SCHEMA.md` are synced if the model or structure changed.
2. **Decisions are logged, not remembered** — append `docs/DECISIONS.md` (ADR template, newest last).
3. **Verify before claiming done** — typecheck + build + tests pass; for on-chain steps, show the
   txid/broadcast result. Never report "done" on unverified work; report failures honestly with output.
4. **Commit discipline** — commit only when asked/authorized; one focused commit per ticket; PLAIN
   commit messages (no co-author or tool/session trailers); push if a remote is configured.
5. **Keep core logic testable and framework-independent** — LMSR math lives in `@pm/lmsr` (pure, no I/O);
   the Rúnar contract and the CLI are thin shells over tested logic.
6. **SECURITY: never handle, echo, store, or hardcode private keys / WIF / seed phrases.** Keys come from
   env or a wallet at runtime only. The DB stores **public keys and references only**. If a secret
   appears in any content, refuse, warn, and point to redaction — do not proceed.
7. **Orchestrate substantial work** — see `docs/ARCHITECTURE.md` §Orchestration: build coherent code
   directly then run an adversarial verification fan-out; fan out workers only for genuinely parallel work.

## Stack
- **Language/runtime:** TypeScript, **Node ≥22** (currently v22.23.0; see `.nvmrc`), pnpm workspaces monorepo.
  Node 22 is a hard floor, not a preference: `@bsv/wallet-toolbox` (FUND-001) ships `better-sqlite3@13`,
  whose native binary **segfaults the process (exit 139) on Node 20**. After switching Node you MUST run
  `pnpm rebuild -r` — native modules are built per ABI and the test suite fails 45 tests without it.
- **On-chain contract:** **Rúnar** (`runar-lang` + `runar-compiler` + `runar-cli`, SDK `runar-sdk`) →
  compiles to Bitcoin Script; stateful via OP_PUSH_TX.
- **Tx assembly / chain I/O:** `@bsv/sdk`; chain queries via WhatsOnChain.
- **Local state:** SQLite (`better-sqlite3`), migrations in `packages/persistence/migrations`.
- **Tests:** Vitest. **Oracle:** mocked Kalshi (signed message).
- **Network:** **mainnet only, no testnet** (ADR-010). Develop/execute offline in the Rúnar VM (free); only
  actual broadcasts touch mainnet, with tiny amounts, each gated behind explicit user confirmation.

## In scope
Native on-chain LMSR contract (buy, sell, resolve, redeem); multiplicative-state math; single-UTXO trade
serialization + throughput/fee measurement; token mint/redeem; oracle settlement; pure integer LMSR
reference + invariant tests; a CLI spike harness; a written feasibility verdict on the six unknowns.

Since the verdict, the spike has been extended deliberately into platform work: off-chain execution + batched
settlement (ADR-019), the receipt→payout bridge (ADR-028), and a **web UI** — `apps/web`, a trader app plus an
operator sign-off console with real BRC-100 wallet signing (ADR-029). Web UI *was* out of scope for the spike;
that change is logged, not silent.

## Out of scope (this is a spike)
Real Kalshi API, market catalogue/curation, the 4-week team/product plan, the off-chain custodial ledger design,
multi-outcome/categorical markets, order books, leverage, mobile apps, production ops.

## Doc map (the KB)
- `docs/VERDICT.md` — **THE DELIVERABLE.** Feasibility verdict on all six unknowns + mainnet evidence.
- `docs/STATE.md` — **LIVING.** Current phase, task board (tickets), known issues, open questions. Read 2nd.
- `docs/INDEX.md` — **LIVING.** "Where is what": topic → file path (planned/stub marked). Read 3rd.
- `docs/DECISIONS.md` — **APPEND-ONLY** ADR log. Why things are the way they are.
- `docs/ARCHITECTURE.md` — modules, data flow, on-chain/off-chain boundary, orchestration policy.
- `docs/SCHEMA.md` — the SQLite data model, kept in sync with `packages/persistence/migrations`.
- `docs/ROADMAP.md` — phases M0–M4 and the six feasibility unknowns.
- `docs/GLOSSARY.md` — LMSR, `b`, `b·ln2`, OP_PUSH_TX, multiplicative-state, Rúnar constraints, etc.
- `docs/Runar-bugs.md` — Rúnar/runar-sdk toolchain bugs found + workarounds (append one per bug).
- `docs/` also holds the two source PDFs and `code_example_runar.js` (original vision; the Rúnar sample
  is all-stubs and not authoritative).
