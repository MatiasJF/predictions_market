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
| Pure integer LMSR reference (price, cost, buy/sell, max-loss) | `packages/lmsr/src/` (stub) |
| LMSR invariant / stress tests | `packages/lmsr/test/` (stub) |
| Rúnar stateful contract(s) — counter gate, LMSRMarket | `packages/contracts/src/` (stub) |
| SQLite migrations | `packages/persistence/migrations/` |
| SQLite open/migrate helpers | `packages/persistence/src/db.ts` |
| DB row types + BigInt boundary helpers | `packages/persistence/src/types.ts` |
| Persistence package entry | `packages/persistence/src/index.ts` |
| CLI spike harness (deploy/trade/settle experiments) | `apps/spike/src/` (stub) |
| Migration CLI entry | `apps/spike/src/migrate.ts` (planned) |

## Config / ops
| Topic | Path |
|---|---|
| Workspace definition | `pnpm-workspace.yaml`, root `package.json` |
| Shared TS config | `tsconfig.base.json` |
| Env template (keys via env only — never committed) | `.env.example` |
| Ignore rules (secrets, db, artifacts) | `.gitignore` |
| Local spike DB (git-ignored, created at runtime) | `data/spike.db` (planned) |
| Rúnar compiled artifacts (git-ignored) | `artifacts/` (planned) |
