# @pm/contracts — Rúnar stateful contracts (stub)

Rúnar sources that compile to Bitcoin Script (ADR-002). Nothing implemented yet.

Planned:
- `src/Counter.runar.ts` — trivial `StatefulSmartContract` used as the **toolchain gate** (CONTRACT-001):
  prove install → `runar compile` → deploy → spend → state-update works end-to-end on testnet before
  touching LMSR. If this cannot be made to work, invoke the ADR-002 fallback (scrypt-ts).
- `src/LMSRMarket.runar.ts` — the market pool contract (CONTRACT-002): enforces the multiplicative-state
  transition (ADR-007) and the payment rule, mirroring the exact integer math in `@pm/lmsr`.

Toolchain (added when CONTRACT-001 starts): `pnpm add runar-lang runar-compiler runar-cli runar-sdk`.
Constraints to respect: no exp/log/fixed-point, no unbounded loops/recursion (see GLOSSARY, ADR-002).
Compiled artifacts land in `artifacts/` (git-ignored).
