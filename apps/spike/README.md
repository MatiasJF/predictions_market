# apps/spike — CLI harness (stub)

Thin wiring over `@pm/lmsr`, `@pm/contracts`, `@pm/persistence`, and `@bsv/sdk` to run feasibility
experiments (deploy a market, execute trades, resolve, redeem) and record results in SQLite.

Planned entry points:
- `src/migrate.ts` — apply DB migrations (`pnpm db:migrate`).
- `src/*` — experiment commands, created alongside P1/P2 tickets.

Any **mainnet** broadcast is gated behind explicit confirmation (ADR-005, Golden Rule 6).
