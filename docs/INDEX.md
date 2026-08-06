# INDEX — where is what (living)

Topic → path. `(stub)` = file exists, not implemented. `(planned)` = not created yet, path is reserved.

## Knowledge base
| Topic | Path |
|---|---|
| Boot file / read-order / golden rules | `CLAUDE.md` |
| **Feasibility verdict (the deliverable)** | `docs/VERDICT.md` |
| **Concurrency & platform architecture (ADR-019)** | `docs/CONCURRENCY.md` |
| Living state + task board | `docs/STATE.md` |
| This map | `docs/INDEX.md` |
| Decision log (ADRs) | `docs/DECISIONS.md` |
| Architecture, boundaries, orchestration | `docs/ARCHITECTURE.md` |
| Data model | `docs/SCHEMA.md` |
| Phases + six unknowns | `docs/ROADMAP.md` |
| Domain terms | `docs/GLOSSARY.md` |
| Source vision (PDFs, original sample) | `docs/*.pdf`, `docs/code_example_runar.js` |

## Code
| Topic | Path |
|---|---|
| Pure integer LMSR reference (price, cost, buy/sell, max-loss) | `packages/lmsr/src/lmsr.ts` |
| Fixed-point BigInt exp/ln | `packages/lmsr/src/fixed.ts` |
| On-chain cost approx (post-trade price, no-`ln`, MM-safe) | `buyChargeApproxSats`/`sellPayoutApproxSats` in `packages/lmsr/src/lmsr.ts` |
| LMSR invariant / stress tests | `packages/lmsr/test/{fixed,lmsr}.test.ts` |
| Cost-approximation error + MM-safety tests | `packages/lmsr/test/cost-approx.test.ts` |
| Rúnar toolchain gate — stateful Counter contract | `packages/contracts/src/Counter.runar.ts` |
| Rúnar gate test (compile + execute offline) | `packages/contracts/test/counter.gate.test.ts` |
| Rúnar LMSR market contract (buy + sell + oracle resolve) | `packages/contracts/src/LMSRMarket.runar.ts` |
| **sCrypt LMSR market contract (Phase 2 port)** | `packages/contracts-scrypt/src/contracts/lmsrMarket.ts` |
| sCrypt local verify + `@pm/lmsr` equivalence tests | `packages/contracts-scrypt/tests/lmsrMarket.test.ts` |
| sCrypt equivalence-vector generator (from `@pm/lmsr`) | `packages/contracts-scrypt/tests/fixtures/gen-vectors.ts` |
| sCrypt full-lifecycle module (deploy→buy→resolve→redeem) | `packages/contracts-scrypt/src/lifecycle.ts` |
| **sCrypt implementation of ChainEngine (daemon PM_ENGINE=scrypt)** | `packages/contracts-scrypt/src/scryptEngine.ts` |
| sCrypt mock Rabin oracle (sign/verify) | `packages/contracts-scrypt/src/oracle.ts` |
| Gated mainnet lifecycle runner | `packages/contracts-scrypt/mainnet-lifecycle.ts` |
| Daemon engine selector (`PM_ENGINE=runar\|scrypt`) | `apps/daemon/src/server.ts` |
| sCrypt package build/why-npm-isolated | `packages/contracts-scrypt/README.md` |
| Broadcastable state-only buy (no token mint) | `buyYesPlain`/`buyNoPlain` in `packages/contracts/src/LMSRMarket.runar.ts` |
| **Off-chain execution engine (CONC-001): instant fills + serialization** | `packages/execution/src/engine.ts` |
| Signed off-chain receipts (sign/verify, sequencer key) | `packages/execution/src/receipt.ts` |
| **Throughput benchmark (fills/sec + fills per settlement)** | `packages/execution/bench/bench.ts` |
| **Trader-authenticated orders (sign/verify, LIVE-001a)** | `packages/execution/src/order.ts` |
| **Receipt → payout derivation (winningPayouts, PAYOUT-001)** | `packages/execution/src/payout.ts` |
| Multi-winner `payout` contract method + tests | `packages/contracts-scrypt/tests/payout.test.ts` |
| **Real multi-wallet market runner (HTTP against the daemon)** | `apps/spike/src/live-market.ts` |
| Trader wallet keygen (WIFs git-ignored) | `apps/spike/src/trader-keygen.ts` |
| Square-and-multiply `powFixed` (consensus-critical, CONC-006) | `powFixed` in `packages/lmsr/src/fixed.ts` |
| **Settlement auditor + attestation + batch digest (CONC-003a)** | `packages/execution/src/audit.ts` |
| **Operator Bond contract: equivocation slash + CLTV withdraw (CONC-003b)** | `packages/contracts-scrypt/src/contracts/bond.ts` |
| Sequencer Rabin attestation (on-chain-verifiable) | `packages/contracts-scrypt/src/attestation.ts` |
| Bond local tests (slash / reject / withdraw timelock) | `packages/contracts-scrypt/tests/bond.test.ts` |
| Gated mainnet fraud-proof demo (deploy Bond → slash) | `packages/contracts-scrypt/mainnet-bond.ts` |
| **Backtrace-verified token redeem tests (CONC-003c)** | `packages/contracts-scrypt/tests/redeemBacktrace.test.ts` |
| **Restart-safety tests (fresh engine resumes a market, CONC-005)** | `packages/contracts-scrypt/tests/restart.test.ts` |
| Pool/token rehydration (`livePool`/`liveToken`, `fromUTXO`) | `packages/contracts-scrypt/src/scryptEngine.ts` |
| Dedicated sequencer keygen (receipt signing key) | `apps/spike/src/sequencer-keygen.ts` |
| Execution + settlement tests (incl. 25-way concurrency) | `packages/execution/test/execution.test.ts` |
| Net-state batch settlement contract method (`settle`) | `settle()` in `packages/contracts-scrypt/src/contracts/lmsrMarket.ts` |
| Batch settlement engine path (`buildSettleBatch`/`execSettle`) | `packages/contracts-scrypt/src/scryptEngine.ts` |
| **Swap seam: ChainEngine interface + TxPlan/PoolRef/SettleBatch types** | `packages/engine/src/types.ts` |
| RunarEngine (Rúnar tx-building behind the seam) | `packages/engine/src/runar.ts` |
| Multi-share 0-conf chain overlay (BUG-003 workaround) | `packages/engine/src/chaining-provider.ts` |
| MockEngine (no-network engine for tests) | `packages/engine/src/mock.ts` |
| Market compile + setup (shared by CLI + daemon) | `packages/engine/src/market.ts` |
| **HTTP daemon: service (orchestration)** | `apps/daemon/src/service.ts` |
| HTTP daemon: router + JSON I/O (127.0.0.1) | `apps/daemon/src/http.ts` |
| HTTP daemon: entrypoint (`pnpm --filter @pm/daemon dev`) | `apps/daemon/src/server.ts` |
| HTTP daemon: service lifecycle tests (temp DB + MockEngine) | `apps/daemon/test/service.test.ts` |
| **HTTP daemon: API reference + run/authorize guide** | `apps/daemon/README.md` |
| Positions view (net YES/NO from trades ledger) | `positions()` in `apps/daemon/src/service.ts` |
| YES/NO share token (fungible, transfer/split) | `packages/contracts/src/ShareToken.runar.ts` |
| ShareToken tests | `packages/contracts/test/share-token.test.ts` |
| LMSRMarket ↔ @pm/lmsr equivalence test | `packages/contracts/test/lmsr-market.test.ts` |
| Rúnar toolchain: compiler / test-VM / SDK / contract lib | `runar-compiler`, `runar-testing`, `runar-sdk`, `runar-lang` (npm 0.4.6) |
| Token base contracts (YES/NO) | `runar-lang/tokens` (FungibleToken / NonFungibleToken) |
| Oracle Rabin-sig verification | `runar-lang/oracle#verifyRabinSig` |
| SQLite migrations (001–010: init · broadcasts · pool-state · execution · settlement · broadcast-kind · commitment · rabin-attest · token-script · order-auth) | `packages/persistence/migrations/` |
| SQLite open/migrate helpers + default DB path | `packages/persistence/src/db.ts` |
| Migrate CLI (`pnpm db:migrate`) | `packages/persistence/src/migrate-cli.ts` |
| DB row types + BigInt boundary helpers | `packages/persistence/src/types.ts` |
| Persistence package entry | `packages/persistence/src/index.ts` |
| Market config: compile artifact + constructor args/state | `apps/spike/src/market.ts` |
| Offline deploy+buy measurement (tx sizes → fees) | `apps/spike/src/measure.ts` |
| Dry-run CLI (`pnpm --filter @pm/spike dry-run`) | `apps/spike/src/dry-run.ts` |
| Deploy tooling test | `apps/spike/test/deploy.test.ts` |
| Mainnet keygen (WIF→.env, prints address) | `apps/spike/src/keygen.ts` |
| Mainnet ops CLI (`mainnet balance\|deploy\|buy [--broadcast]`) | `apps/spike/src/mainnet.ts` |
| Correct @bsv/sdk-based Signer (BUG-001 workaround) | `apps/spike/src/bsv-signer.ts` |
| BIP-143/OP_PUSH_TX diagnostic + local Spend validation | `apps/spike/src/diag-oppushtx.ts` |
| .env loader | `apps/spike/src/env.ts` |
| Rúnar toolchain bugs + workarounds (internal log) | `docs/Runar-bugs.md` |
| Rúnar bug report for the maintainers (standalone, shareable) | `docs/RUNAR-BUG-REPORT.md` |

## Config / ops
| Topic | Path |
|---|---|
| Workspace definition | `pnpm-workspace.yaml`, root `package.json` |
| Shared TS config | `tsconfig.base.json` |
| Env template (keys via env only — never committed) | `.env.example` |
| Ignore rules (secrets, db, artifacts) | `.gitignore` |
| Local spike DB (git-ignored, created at runtime) | `data/spike.db` (planned) |
| Rúnar compiled artifacts (git-ignored) | `artifacts/` (planned) |
