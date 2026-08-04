# INDEX — where is what (living)

Topic → path. `(stub)` = file exists, not implemented. `(planned)` = not created yet, path is reserved.

## Knowledge base
| Topic | Path |
|---|---|
| Boot file / read-order / golden rules | `CLAUDE.md` |
| **Feasibility verdict (the deliverable)** | `docs/VERDICT.md` |
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
| Broadcastable state-only buy (no token mint) | `buyYesPlain`/`buyNoPlain` in `packages/contracts/src/LMSRMarket.runar.ts` |
| **Swap seam: ChainEngine interface + TxPlan/PoolRef types** | `packages/engine/src/types.ts` |
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
| SQLite migrations (001 init · 002 broadcasts · 003 pool-state) | `packages/persistence/migrations/` |
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
