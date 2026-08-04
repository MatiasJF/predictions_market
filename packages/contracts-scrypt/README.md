# @pm/contracts-scrypt — sCrypt port of the LMSR market contracts (Phase 2)

The Rúnar→sCrypt migration (see `docs/DECISIONS.md` ADR-018). Ports the LMSR prediction-market contracts to
**scrypt-ts 1.4.5** (the classic BSV framework), keeping `@pm/lmsr` as the ground truth and the same on-chain
design (multiplicative state ADR-007, post-trade-price MM-safe charge ADR-011, Rabin oracle ADR-013).

## Why this package is npm-managed (not in the pnpm workspace)

sCrypt's compiler toolchain uses **ts-patch + a TypeScript transformer** (`scrypt-ts-transpiler`) that needs a
**flat `node_modules`**. pnpm's isolated store breaks it (the transpiler isn't resolvable, so no Script is
emitted). So this package is **excluded from the pnpm workspace** (`pnpm-workspace.yaml`: `!packages/contracts-scrypt`)
and managed with **npm**. It compiles standalone to `artifacts/*.json`, which `@pm/engine`'s `ScryptEngine`
consumes.

## Build & test

```bash
cd packages/contracts-scrypt
npm install            # flat node_modules (npm, not pnpm)
npm run compile        # scrypt-cli → artifacts/lmsrMarket.json (compiled Bitcoin Script)
# regenerate @pm/lmsr equivalence vectors (run from the MONOREPO root, where @pm/lmsr resolves):
#   npx tsx packages/contracts-scrypt/tests/fixtures/gen-vectors.ts
npm test               # NETWORK=local mocha — offline verify on a DummyProvider
```

`NETWORK=local` runs entirely offline: sCrypt executes the **real node Script** against fabricated UTXOs, so a
green test means mainnet-valid — the guarantee Rúnar lacked (BUG-006). Tests use an **ephemeral in-memory key**
(no `.env` key is written — Golden Rule 6).

## Status (SCRYPT-001)

- `LMSRMarket` (`src/contracts/lmsrMarket.ts`) — **compiles** (25.8 KB Script) and its **buy/sell verify
  locally, matching the `@pm/lmsr` reference** (4 passing). Methods: `buyYes/buyNo/sellYes/sellNo/resolve`
  (Rabin). Stateful via `@prop(true)` + `buildStateOutput()`; each public method ends with the `hashOutputs`
  assertion sCrypt requires.
- **Next:** `ShareToken` + token mint in buy (multi-output) + `redeem` (multi-input) — the runar BUG-005
  unblock; a Rabin-oracle `resolve` test; then the `ScryptEngine` (SCRYPT-002).
