# INDEX — where is what (living)

Topic → path. `(stub)` = file exists, not implemented. `(planned)` = not created yet, path is reserved.

## Knowledge base
| Topic | Path |
|---|---|
| Boot file / read-order / golden rules | `CLAUDE.md` |
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
| LMSRMarket ↔ @pm/lmsr equivalence test | `packages/contracts/test/lmsr-market.test.ts` |
| Rúnar toolchain: compiler / test-VM / SDK / contract lib | `runar-compiler`, `runar-testing`, `runar-sdk`, `runar-lang` (npm 0.4.6) |
| Token base contracts (YES/NO) | `runar-lang/tokens` (FungibleToken / NonFungibleToken) |
| Oracle Rabin-sig verification | `runar-lang/oracle#verifyRabinSig` |
| SQLite migrations | `packages/persistence/migrations/` |
| SQLite open/migrate helpers | `packages/persistence/src/db.ts` |
| DB row types + BigInt boundary helpers | `packages/persistence/src/types.ts` |
| Persistence package entry | `packages/persistence/src/index.ts` |
| Market config: compile artifact + constructor args/state | `apps/spike/src/market.ts` |
| Offline deploy+buy measurement (tx sizes → fees) | `apps/spike/src/measure.ts` |
| Dry-run CLI (`pnpm --filter @pm/spike dry-run`) | `apps/spike/src/dry-run.ts` |
| Deploy tooling test | `apps/spike/test/deploy.test.ts` |
| Mainnet keygen (WIF→.env, prints address) | `apps/spike/src/keygen.ts` |
| Mainnet ops CLI (`mainnet balance\|deploy\|buy [--broadcast]`) | `apps/spike/src/mainnet.ts` |
| Correct @bsv/sdk-based Signer (BUG-001 workaround) | `apps/spike/src/bsv-signer.ts` |
| .env loader | `apps/spike/src/env.ts` |
| Rúnar toolchain bugs + workarounds | `docs/Runar-bugs.md` |

## Config / ops
| Topic | Path |
|---|---|
| Workspace definition | `pnpm-workspace.yaml`, root `package.json` |
| Shared TS config | `tsconfig.base.json` |
| Env template (keys via env only — never committed) | `.env.example` |
| Ignore rules (secrets, db, artifacts) | `.gitignore` |
| Local spike DB (git-ignored, created at runtime) | `data/spike.db` (planned) |
| Rúnar compiled artifacts (git-ignored) | `artifacts/` (planned) |
