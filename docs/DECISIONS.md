# Decision Log (ADRs)

Append-only. Newest last. Never edit a past ADR's decision; supersede it with a new one.

Template:
```
## ADR-NNN · <title> · <Accepted|Superseded by ADR-MMM> · <YYYY-MM-DD>
- Context: <why this came up>
- Options: (a) … · (b) … · (c) …
- Decision: <the chosen option and what it means>
- Consequences: <trade-offs, follow-ups, what it unblocks>
```

---

## ADR-001 · TypeScript + pnpm monorepo + Node ≥20 · Accepted · 2026-07-24
- Context: Need a stack for a BSV feasibility spike. Rúnar, `@bsv/sdk`, and the source sample are all
  TypeScript-first; the team is BSVA.
- Options: (a) TypeScript monorepo · (b) Rust (Rúnar also targets Rust) · (c) mixed.
- Decision: TypeScript, Node ≥20, pnpm workspaces. Packages: `@pm/lmsr` (pure math), `@pm/persistence`
  (SQLite), `@pm/contracts` (Rúnar), app `spike` (CLI harness).
- Consequences: One language across contract, tx-building, and harness. Rúnar TS ↔ its Script output must
  be verified (CONTRACT-001). Native `better-sqlite3` needs a build step at install time.

## ADR-002 · Rúnar as the on-chain contract language · Accepted · 2026-07-24
- Context: The contract must be a stateful UTXO smart contract on BSV. Candidates: Rúnar (the sample's
  language), scrypt-ts, hand-rolled Script.
- Options: (a) Rúnar · (b) scrypt-ts · (c) raw Script via `@bsv/sdk`.
- Decision: **Rúnar.** Verified real: a BSV Association compiler (repo `icellan/runar`, technical report
  Mar 2026) that compiles TS/Rust/Go/Python to Bitcoin Script and supports **stateful** contracts via
  OP_PUSH_TX. Install: `pnpm add runar-lang runar-compiler runar-cli`; SDK `runar-sdk`.
- Consequences: **Hard constraint discovered:** Rúnar Script exposes only arbitrary-precision integers,
  bitwise/comparison/arithmetic, hashes, `checkSig` — **no exp/log/fixed-point primitives, and no
  unbounded loops or recursion.** Therefore LMSR `exp`/`ln` CANNOT be computed on-chain; forces the
  multiplicative-state design (ADR-007) and leaves the cost-verification-without-`ln` open question.
  **Fallback:** if Rúnar cannot express the contract (CONTRACT-001/002 gate), supersede with scrypt-ts.

## ADR-003 · SQLite for local spike state · Accepted · 2026-07-24
- Context: The harness must track deployed markets, the pool-UTXO version lineage, tokens, and trades
  across a run, and satisfy the workflow's "encode a data model + migration" step.
- Options: (a) SQLite (`better-sqlite3`) · (b) flat JSON files · (c) in-memory only.
- Decision: SQLite with SQL migrations. Blockchain is the real ledger; SQLite is the run's audit trail.
- Consequences: Real schema + integrity constraints; resumable experiments. Requires a native module build.

## ADR-004 · Build the native on-chain UTXO AMM (not the off-chain ledger) · Accepted · 2026-07-24
- Context: The two source PDFs describe two different systems. The off-chain roadmap explicitly excludes
  the on-chain AMM; the UTXO doc makes it the whole point.
- Options: (a) native on-chain UTXO AMM · (b) off-chain custodial double-entry ledger · (c) thin LMSR-only slice.
- Decision: **(a) native on-chain UTXO AMM.** The spike's job is to prove the novel BSV-native design.
- Consequences: Highest technical risk and the highest-value answer for BSVA. Confronts single-UTXO
  serialization, on-chain math limits, token mint/redeem, and oracle settlement head-on.

## ADR-005 · Testnet dev loop, single mainnet proof run · Superseded by ADR-010 · 2026-07-24
- Context: User chose "mainnet" as the target environment; iterating a novel contract on mainnet burns
  real sats on every failed broadcast, and fee/Script semantics are identical on testnet.
- Options: (a) mainnet from trade #1 · (b) testnet-only · (c) testnet dev loop + one mainnet proof.
- Decision: (c). Develop/iterate on testnet (free); run one canonical end-to-end proof on **mainnet** with
  tiny amounts as the feasibility sign-off. Any mainnet broadcast is gated behind explicit confirmation.
- Consequences: Honors the mainnet goal without wasting funds. Mainnet run is a checklist item, not the loop.

## ADR-006 · Store LMSR numeric state as decimal-integer TEXT (BigInt), sats as INTEGER · Accepted · 2026-07-24
- Context: LMSR multiplicative state `e_yes/e_no = exp(q/b)·SCALE` can exceed SQLite's signed 64-bit
  INTEGER; satoshi-exactness is non-negotiable.
- Options: (a) all numerics as INTEGER · (b) REAL/float · (c) BigInt-valued columns as TEXT.
- Decision: LMSR-scaled columns (`b`, `scale`, `q_yes`, `q_no`, `e_yes`, `e_no`, `shares`) as **TEXT**
  decimal strings parsed to `BigInt`; plain sat amounts that safely fit (`sats`, `cost_sats`, `fee_sats`,
  `payout_unit`) as **INTEGER**. Never REAL — floats break satoshi-exactness.
- Consequences: No overflow, exact math. Code must parse/serialize BigInt at the DB boundary.

## ADR-007 · Multiplicative-state LMSR; off-chain exact reference is ground truth · Accepted · 2026-07-24
- Context: Rúnar has no exp/log and no loops (ADR-002), so classic LMSR (`C=b·ln(Σ exp(qᵢ/b))`) is not
  directly computable on-chain.
- Options: (a) on-chain series-approx exp (blocked: no loops) · (b) multiplicative exponential state +
  precomputed unit constant · (c) off-chain compute, on-chain verify a cheap invariant.
- Decision: (b)+(c). Store `e_yes/e_no` as state; a fixed-unit trade multiplies by constant `exp(u/b)`
  (pure mul/div). `@pm/lmsr` holds an exact integer LMSR reference off-chain as ground truth for tests and
  for computing what the contract must enforce.
- Consequences: **Unblocks** an on-chain-expressible buy. **Open question (see STATE.md):** verifying LMSR
  *cost* on-chain still needs `ln`; candidate resolutions — quantize to unit trades, bounded price-based
  cost approximation (quantify error in LMSR-002), or bounded lookup. Variable trade sizes without loops
  is the second open question.

## ADR-008 · MM-safe rounding directions + q≥0 invariant for sells · Accepted · 2026-07-24
- Context: LMSR-001 adversarial verification (3 agents) confirmed the buy math is correct/solvent but found:
  (a) sell was advertised yet unimplemented/untested; (b) the div-by-zero / negative-`C` branches become
  reachable the moment a sell drives `e` below WAD.
- Options: (a) implement sell with an explicit non-negativity guard · (b) ship buy-only and drop the sell
  claim from the docs.
- Decision: (a). **Buys charge `ceil` (round up), sells pay `floor` (round down)** — the tiny bid/ask
  rounding spread always favors the pool, so it can never overpay. **Sells guard `delta ≤ q`** so net
  shares stay ≥ 0; since `q ≥ 0 ⇒ e = exp(q/b) ≥ WAD`, the sum is always ≥ 2·WAD and the underflow
  branches stay unreachable. Exact buy/sell paths also reject negative deltas.
- Consequences: Reference now matches the market lifecycle (early-exit before close). Verified: buy→sell
  round-trips return to the opening state; real pool (`seed + Σcost`) ≥ liability every trade over 100k.
  **Known, benign property:** the two sides' displayed prices can differ by 1 sat (floor asymmetry); the
  on-chain contract must respect the same rounding direction. The exact-vs-multiplicative drift is
  ~5e-13 relative and non-compounding (measured to 1M trades).

## ADR-009 · Rúnar toolchain gate passed; token & oracle primitives chosen; offline test harness · Accepted · 2026-07-24
- Context: CONTRACT-001 had to prove Rúnar compiles+runs a stateful contract before building the LMSR
  market on it. Inspected the installed v0.4.6 packages directly (not the earlier page summary).
- Findings:
  - `StatefulSmartContract` (runar-lang) is exactly the Market Pool pattern: mutable props → state via
    OP_PUSH_TX; `addOutput(sats, ...stateValues)` enforces the continuation output; the compiler
    auto-injects the preimage check + state-continuation assert.
  - Compiled a minimal `Counter` to **148 bytes of Bitcoin Script** and executed 0→1→2 **offline** via
    `runar-testing`'s `TestContract` (Script VM + mock preimage). No chain, no funds needed for the gate.
  - Script math available: `mulDiv(a,b,c)`, `pow`, `sqrt`, `log2` (approx floor), `percentOf` (bps),
    `min/max/within/clamp`, `safediv`. Still **no exp/ln** (confirms ADR-002) — but mulDiv+pow are what the
    multiplicative-state trick (ADR-007) needs.
- Decisions:
  - Contract toolchain = Rúnar, gate met → **ADR-002 fallback (scrypt-ts) not needed.**
  - **Token primitive = `runar-lang/tokens`** (`FungibleToken`/`NonFungibleToken`), replacing the docs'
    vague "BRC-100" → resolves Open Q4.
  - **Oracle = Rabin signatures** via `runar-lang/oracle#verifyRabinSig` (cheaper on-chain than ECDSA);
    sign/verify in tests with `runar-testing`'s rabin helpers.
  - **Contract development is offline** via `runar-testing` (`TestContract`, `ScriptVM`, mock preimage);
    real testnet/mainnet deploy is a separate, later, explicitly-gated ticket (DEPLOY-001).
- Consequences: Unblocks CONTRACT-002 (LMSRMarket buy in Rúnar). `fast-check` added as a devDep (an
  undeclared transitive of runar-testing). Contract sources are valid TS and are typechecked. Single-UTXO
  throughput / fee economics (Open Q3, unknowns #2/#6) still require a real-chain ticket to measure.

## ADR-010 · Mainnet only; no testnet · Accepted · 2026-07-24 (supersedes ADR-005)
- Context: User directive — "we will never touch testnet, we will do all in mainnet." Avoids testnet
  faucet/coin friction.
- Options: (a) testnet dev loop + mainnet proof (ADR-005) · (b) mainnet only.
- Decision: **(b) all on-chain interaction targets BSV mainnet; no testnet at all.** Development,
  compilation, and full contract execution still happen **offline** in the Rúnar VM (`runar-testing`) —
  free, no chain — and only actual broadcasts (deploy pool, trades, settle, redeem) touch mainnet, with
  tiny satoshi amounts.
- Safety floors (unchanged, non-negotiable): (1) every mainnet broadcast is gated behind explicit
  per-action user confirmation before sending; (2) Golden Rule 6 — never handle/echo/store a private key
  or WIF; keys stay in the user's wallet or a user-funded key; I build/inspect txs and surface addresses /
  unsigned txs only; (3) prove each contract path offline in the VM before any broadcast.
- Consequences: Supersedes ADR-005. `DEPLOY-001` and later are mainnet. Real-money risk bounded by
  tiny amounts + offline-first verification. Throughput/fee unknowns (#2/#6) get measured on mainnet.

## ADR-011 · On-chain cost verification without `ln`: post-trade marginal price (MM-safe) · Accepted · 2026-07-24 (resolves Open Q1)
- Context: Rúnar has no `ln`, so the contract cannot compute exact LMSR cost `C(new)−C(old)`. LMSR-002 had
  to find an on-chain-expressible cost rule that is MM-safe and low-error.
- Options: (a) price at the post-trade state (right-Riemann bound) · (b) bounded lookup table for `ln` ·
  (c) buyer-supplied cost verified on-chain (needs exp/ln — infeasible).
- Decision: **(a).** The contract charges/pays at the **post-trade marginal price**
  `eSide'/(eYes'+eNo')·payout·Δ`, computable with one `mulDiv`. **Buys round UP, sells round DOWN.** Because
  LMSR cost is the integral of an increasing price curve, the post-trade price is a right-Riemann bound:
  buys overcharge, sells underpay — both MM-safe — and `ceil`/`floor` monotonicity preserves the bound
  after integer rounding. Implemented as `buyChargeApproxSats` / `sellPayoutApproxSats` in `@pm/lmsr`.
- Evidence (LMSR-002, measured; `packages/lmsr/test/cost-approx.test.ts`): MM-safe direction holds across a
  b×side×skew grid (0 undercharges). Overcharge grows with Δ/b (trade ÷ liquidity): **0% for tiny trades,
  ≤0.13% of notional at Δ/b=1e-2, ~1.3–2.4% at Δ/b=0.1, ~8–19% at Δ/b=1**.
- Consequences: **Resolves Open Q1 / de-risks unknown #1.** CONTRACT-002's `buy()` enforces
  `payment ≥ buyChargeApproxSats`. Design rule: **cap trade size to Δ/b ≤ ~0.01** (overcharge <~0.13% of
  notional) — matches the source docs' per-trade caps + `b`-scaling. The buyer pays a tiny, bounded premium
  for not having `ln` on-chain; this premium accrues to the pool (extra safety margin).

## ADR-012 · LMSRMarket contract shape for the feasibility spike · Accepted · 2026-07-24
- Context: CONTRACT-002 needed a Rúnar contract proving the on-chain LMSR buy math, exercisable in the
  offline interpreter.
- Decisions:
  - **`addOutput` continuation pattern** — compute new values as locals, `this.addOutput(outputSatoshis,
    ...newState)`, no `this` reassignment. This is the pattern proven by Rúnar's own FungibleToken /
    multi-output tests; the compiler's state-continuation hash constrains the untouched side + readonly
    params. The new state appears in `result.outputs[0]`, not `this`.
  - **Collateral tracked as STATE** (a bigint field, like a token balance), NOT bound to the UTXO's
    satoshis. Binding it to real sats via `extractAmount(txPreimage)` compiles but can't be exercised in
    the offline interpreter (needs a real BIP-143 preimage), so it's deferred to DEPLOY-001. Keeps the
    buy-math fully testable now.
  - **`unit == scale`** (one-share unit, WAD) so the charge needs no unit factor; multi-unit trades (via
    `pow`) deferred to a later ticket.
- Verification: 1 adversarial agent could not refute correctness or test adequacy — contract charge ≡
  reference exactly (algebra + independent 120-step feedback loop), all 6 mutations caught red. Captured a
  60-step feedback-loop regression test in the suite.
- Consequences: On-chain LMSR buy proven feasible (software). Owed at DEPLOY-001: bind collateral to UTXO
  sats (`extractAmount`), constrain `outputSatoshis`, handle buyer change / token mint as additional
  outputs, and measure real throughput/fees. Resolves unknown #1 fully; completes P1.

## ADR-013 · Oracle resolution via Rabin signature on the pool contract · Accepted · 2026-07-24 (resolves unknown #5)
- Context: SETTLE-001 needed to prove the market can be resolved on-chain by a trusted oracle. Rúnar
  provides `verifyRabinSig` (`runar-lang/oracle`) — cheaper on-chain than ECDSA.
- Decisions:
  - `resolve()` lives on `LMSRMarket` (faithful lifecycle): the pool UTXO flips `resolved` 0→1 and records
    `winner`. buy/sell `assert(resolved == 0)`, so trading is disabled post-resolution; no double-resolve.
  - The oracle Rabin-signs `msg = cat(marketTag, num2bin(outcome,1))`; the readonly `marketTag` binds the
    signature to THIS market (stops replaying an outcome sig elsewhere). `oracleN` (Rabin modulus) is baked
    in readonly. `padding` is passed as LE-hex ByteString (read as unsigned LE bigint); `sig`/`oracleN` are bigints.
- Evidence: 6 tests via `runar-testing` `rabinSign`/`RABIN_TEST_KEY` — valid YES/NO resolve, forged sig
  rejected, wrong-outcome sig rejected (binding), trading disabled after resolve, double-resolve rejected.
  Offline-testable (verifyRabinSig is preimage-independent).
- Consequences: **Resolves unknown #5.** Owed later: winner REDEMPTION (burn winning token for
  `payoutUnit`) needs tokens → TOKEN-001; production hardening = bind `marketTag` to the UTXO outpoint (not a
  static tag) to stop cross-instance replay, and consider a 2-of-2 / multi-oracle scheme.

## ADR-014 · DEPLOY-001 approach: SDK tooling, offline dry-run first, gated mainnet, key-safety · Accepted · 2026-07-24
- Context: The only unresolved unknowns (#2 throughput, #6 fees) need real mainnet trades against the single
  pool UTXO. User chose the mainnet-deploy path. Rúnar's `runar-sdk` provides the full stack.
- Tooling (in `apps/spike`): `RunarContract(artifact, constructorArgs).connect(provider, signer)` →
  `.deploy({satoshis})` and `.call(method, args, {newState, satoshis})` (SDK builds the OP_PUSH_TX
  continuation). Providers: `WhatsOnChainProvider` (mainnet broadcast + UTXO fetch), `MockProvider` (offline
  dry-run that yields the real `@bsv/sdk` tx objects → exact byte sizes). Signer: `LocalSigner` (WIF/hex).
- Decisions:
  - **Offline dry-run first (DEPLOY-001a):** compile → emit `artifacts/LMSRMarket.json`, then deploy + N buys
    through `MockProvider`, measuring tx byte-sizes → fee/trade (#6) with zero spend. Also harden the contract
    to bind collateral to real UTXO sats (`extractAmount`, enforce `outputSatoshis == inAmount + payment`) —
    compile-verifiable offline (interpreter can't exercise extractAmount), validated for real on mainnet.
  - **Gated mainnet (DEPLOY-001b):** a `keygen` script generates a fresh key, writes the WIF to the
    git-ignored `.env` (PM_FUNDING_WIF) and prints ONLY the address; the user funds it from their wallet. The
    tooling loads the WIF at runtime (`LocalSigner`); **I never see, echo, or commit the key** (Golden Rule 6).
    Each broadcast pauses for explicit user confirmation. Use a small `b` so `b·ln2` collateral is tiny.
- Consequences: #6 gets a strong offline answer from tx sizes; #2 (throughput / single-UTXO serialization,
  0-conf behaviour) and real fees confirmed on mainnet. Completes the six-unknown verdict.

## ADR-015 · Productization API: HTTP daemon + `ChainEngine` swap seam + sign-off queue · Accepted · 2026-08-04
- Context: Feasibility is proven; the next goal is **autonomous operation** — Claude drives the full market
  lifecycle (create → quote → buy/sell → resolve) unattended, with the human involved ONLY to authorize wallet
  spends. Separately, Rúnar's SDK bugs (BUG-001/005) block real on-chain use beyond the simplest paths, so we
  will migrate to **sCrypt** later. Both needs are served by making the API the stable contract and the
  contract toolchain a swappable adapter.
- Decisions:
  - **HTTP REST daemon** (`apps/daemon`, `@pm/daemon`) on Node's built-in `http`, bound to **127.0.0.1 only**,
    driven by `curl`/Bash. Endpoints: `POST /markets`, `GET /markets[/:id]`, `GET /markets/:id/quote`,
    `POST /markets/:id/{deploy,buy,sell,resolve,redeem}`, `GET /wallet/balance`, `GET /broadcasts[/:id]`,
    `POST /broadcasts/:id/{authorize,reject}`.
  - **Three layers, one seam:** HTTP (`http.ts`) → `MarketService` (HTTP-agnostic orchestration, Golden Rule 5)
    → `ChainEngine` (`@pm/engine`). `ChainEngine` abstracts compile + tx-building + broadcast; `RunarEngine`
    implements it now (absorbing the proven `mainnet.ts` tx-building), a `ScryptEngine` will implement the SAME
    interface in Phase 2 with **zero** service/HTTP/DB/LMSR changes. `MockEngine` (extends `RunarEngine`,
    overrides chain I/O) backs the service tests with no network.
  - **Sign-off queue (the human gate):** state-changing ops build a `TxPlan` (unsigned descriptor + DB effects,
    NO key material) and INSERT a `pending` row in the new `broadcasts` table. `POST /broadcasts/:id/authorize`
    is the **only** path that loads the funding WIF — it asks the engine to rebuild+sign+broadcast, then applies
    the plan's effects atomically. Nothing reaches mainnet without an explicit authorize call (extends ADR-010).
    Invariant: **at most one pending broadcast per market** (keeps queued plans fresh against the pool head).
  - **Engine honesty:** `RunarEngine` supports the broadcastable-today paths (deploy, plain buy, sell, resolve);
    token-mint buy and multi-input redeem throw `EngineLimitation` → HTTP **501** with a pointer to BUG-005 and
    the Phase-2 (sCrypt) unblock. Read ops and quotes work for everything.
  - Security: the daemon may derive the PUBLIC funding address/pubkey from the WIF in-memory (address/pubkey are
    public) for balance reads and `markets` provenance; the WIF is used to SIGN only in `authorizeAndBroadcast`,
    never returned by an endpoint, logged, or persisted (Golden Rule 6).
- Consequences: Claude can run the market end-to-end unattended; every spend is a one-line human authorize; the
  Rúnar→sCrypt migration becomes a single new engine behind an unchanged API. Detailed sCrypt planning is a
  follow-on pass once this lands.

## ADR-016 · Pool state lives in SQLite (`pool_utxos` full state); broadcastable plain-buy method · Accepted · 2026-08-04
- Context: The daemon needs a durable, multi-market home for pool state (the CLI used a single
  `apps/spike/data/pool.json`). And the current `LMSRMarket.buyYes/buyNo` always mint a token via
  `addRawOutput`, which `runar-sdk` cannot build (BUG-005) — so the *only* broadcastable buy is a state-only one.
- Decisions:
  - **`pool_utxos` becomes the full pool-state home** (migration `003_pool_state.sql`): added `collateral`,
    `resolved`, `winner`, `locking_script`. One unspent row per market is the live pool head; the daemon advances
    a new version per authorized spend and marks the previous spent — replacing `pool.json` (which stays only as
    the legacy CLI's scratch file).
  - **`broadcasts` sign-off queue** (migration `002_broadcasts.sql`): id, market_id, kind, summary, spend_sats,
    `plan` (JSON `TxPlan`, public data only), status (pending→broadcast|rejected|failed), txid, error, timestamps.
  - **Plain buy methods** `buyYesPlain`/`buyNoPlain` added to `LMSRMarket`: identical LMSR update + MM-safe charge
    as `buyYes`/`buyNo` but a single continuation output (no mint) — the runar-sdk-broadcastable path (the exact
    shape proven live, tx `7106f762…`). Under Rúnar the buyer's claim is tracked off-chain in `trades` (the
    "documented-trust" model); on-chain minting returns in Phase 2 (sCrypt). VM tests assert a single output.
- Consequences: pool lineage is queryable and multi-market; the autonomous loop create→deploy→buy→sell→resolve is
  live-capable under Rúnar; token mint/redeem remain the documented Phase-2 gap.

## ADR-017 · Multi-share buy/sell via a 0-conf tx-chain overlay; positions from the trades ledger · Accepted · 2026-08-04
- Context: A buy/sell of N shares is N unit-txs against the single pool UTXO (multiplicative state has no bounded
  N-step op under Rúnar). Chaining them means each tx spends the previous tx's pool + change outputs while
  unconfirmed — but WhatsOnChain still reports the just-spent confirmed funding UTXO as unspent, so the SDK
  re-selects it and double-spends (BUG-003).
- Decisions:
  - **`ChainingProvider` overlay** (`@pm/engine`): wraps the base provider; after each step's tx is built,
    `register(tx)` hides its spent inputs and exposes its change output as a 0-conf funding UTXO, and serves the
    tx hex for the next step. `authorizeAndBroadcast` builds the N-tx chain (step 0 on confirmed UTXOs, later
    steps on the overlay), broadcasts each through the real network, and returns the FINAL pool head. Capped at
    `MAX_UNITS = 100` per call; single-step calls use the base provider unchanged (the proven path).
  - **DB model:** a multi-share call records **one aggregate `trades` row** (N shares, summed cost) and advances
    the pool **one** version to the final state — the intermediate pool UTXOs are created and spent inside the
    chain, so they never persist. Quote/position/DB paths are unit-tested; the live multi-tx chain awaits a gated
    mainnet run (all mainnet behaviour in this project is gated-verified).
  - **`positions`**: `GET /markets/:id/positions` aggregates the `trades` ledger into net YES/NO shares +
    net cost (buys − sells); a summary is folded into `GET /markets/:id`. This is the off-chain position book
    under the documented-trust model (on-chain token UTXOs are Phase 2).
- Consequences: the API accepts N-share trades end-to-end with an honest BUG-003 caveat; the trades ledger
  becomes a readable book; nothing here changes the ChainEngine seam, so sCrypt still drops in cleanly.

## ADR-018 · Adopt sCrypt (scrypt-ts 1.4.5) for the on-chain contracts; npm-isolated package · Accepted · 2026-08-04
- Context: the gated live run proved the LMSR design sound but the Rúnar toolchain unfit for on-chain use —
  BUG-003 (stale-UTXO), BUG-005 (no multi-output/multi-input tx build), and BUG-006 (a buy that passed 72 VM
  tests NULLFAILed on mainnet: **VM ≠ mainnet**). Decision: migrate the contracts to **sCrypt**, behind the
  unchanged `ChainEngine` seam.
- Decisions:
  - **Framework:** classic BSV **`scrypt-ts` 1.4.5** (`class extends SmartContract`, `@prop()/@prop(true)/
    @method()`, `buildStateOutput()`, `this.ctx.hashOutputs` assertion) — NOT the newer `@scrypt-inc/cli-btc` /
    Covenant BTC stack. Rabin oracle via `scrypt-ts-lib` (`RabinVerifier.verifySig`).
  - **Packaging:** `packages/contracts-scrypt` is **npm-managed and excluded from the pnpm workspace**
    (`!packages/contracts-scrypt`). sCrypt's ts-patch transformer needs a flat `node_modules`; pnpm's isolated
    store breaks it (transpiler unresolvable → no Script emitted). The package compiles standalone to
    `artifacts/*.json`, which `@pm/engine` consumes. Root `vitest.config.ts` excludes it (it runs its own mocha).
  - **Local testing = the mainnet guarantee:** sCrypt's `NETWORK=local`/`DummyProvider` verify executes the
    **real node Script** (green ⇒ mainnet-valid), which is exactly what closes the BUG-006 gap. Ephemeral
    in-memory keys only (Golden Rule 6).
  - **Design preserved:** same `@pm/lmsr` ground truth + multiplicative state (ADR-007) + post-trade-price
    MM-safe charge (ADR-011) + Rabin resolution (ADR-013). sCrypt has bigint mul/div but no exp/ln (same as
    Rúnar), and adds **bounded loops** (multi-share buy in one tx) + **native multi-output/multi-input** (token
    mint + redeem — the BUG-005 unblock).
- Evidence (SCRYPT-001): `LMSRMarket` compiles to 25.8 KB Script; **buy/sell verify locally and reproduce the
  `@pm/lmsr` reference** (underpayment rejected) — the buy that NULLFAILed on Rúnar mainnet passes under sCrypt.
- Consequences: the engine swap is a new `ScryptEngine implements ChainEngine`; the daemon/service/DB/HTTP/queue
  are untouched. The Rúnar engine stays for side-by-side comparison; `PM_ENGINE` selects at runtime.

## ADR-019 · Concurrency: off-chain execution + on-chain batched LMSR settlement · Accepted · 2026-08-04
- Context: the single-market lifecycle is proven + confirmed on mainnet, but the market is ONE pool UTXO —
  concurrent trades contend for the same UTXO (only one spend is valid per version), so trading is inherently
  serial. Mainnet numbers: a stateful spend is ~93 KB; BSV's ~101 KB unconfirmed-ancestor budget ⇒ ~1
  unconfirmed trade at a time ⇒ naive on-chain trading is ~1 trade/block. Cannot serve concurrent users.
- Options: (a) pure on-chain serial (too slow) · (b) sharded/parallel pools (**rejected** — LMSR needs a single
  global `q`; sharding breaks pricing) · (c) off-chain match + on-chain settle · (d) batched on-chain · (e) state
  channels (**rejected** — N-party market ≠ 2-party channel).
- Decision: **(c)+(d) — an app-specific-rollup shape.** Execute trades OFF-chain over `@pm/lmsr` (authoritative,
  in-memory, instant fills, signed receipts) so concurrency is serialized off-chain with no UTXO contention;
  SETTLE on-chain in **batches** — one pool-version tx advances the net LMSR state + mints/burns the batch's
  ShareTokens (the multi-output tx already proven on mainnet), one writer (the sequencer) to the pool UTXO.
  Trust is tunable and hardened over time: custodial+receipts (MVP) → operator bond + fraud proofs → on-chain
  validity check (trustless), the last reusing the spike's proven on-chain LMSR-state verification.
- Consequences: interactive trading latency + high throughput (off-chain), amortized sub-cent settlement cost;
  the pool contract/`ScryptEngine`/daemon/`@pm/lmsr`/`@pm/persistence` are all reused (extend one-trade-per-tx →
  one-batch-per-tx). Resolves the project's founding native-vs-off-chain tension as a **synthesis**: off-chain
  execution + native on-chain settlement. Full rationale + phased build (CONC-001..005) in `docs/CONCURRENCY.md`.

## ADR-020 · Slim the pool contract by collapsing YES/NO twins to side-parameterized methods · Accepted · 2026-08-05
- Context: OP_PUSH_TX re-carries the ENTIRE compiled pool script on every spend, so script size sets the
  per-spend footprint (~93 KB, the biggest lever on per-trade cost + how many trades chain per block — CONC-004).
- Empirical ablation (real compiles, artifact `hex` measured): baseline nine methods = **45,675 B**; removing
  `resolve`/Rabin = 40,714 B (Rabin ≈ **5 KB**); collapsing the YES/NO twins to `buy/sell/resolve/redeem`
  (5 methods) = 26,557 B; **4 methods (buy always mints) = 21,447 B (−53%)**.
- Decision: **collapse the 9 twins to 4 side-parameterized methods** — `buy(isYes,…)`, `sell(isYes)`, `resolve`,
  `redeem(isYes,…)` — passing side as a `boolean`. Drop the state-only no-token buy (a spike artifact): every buy
  mints its position token. Semantics/pricing unchanged, proven by the `@pm/lmsr` equivalence vectors + all local
  Script-verify tests staying green.
- Rejected/deferred (ruled out by the ablation, correcting the pre-measurement plan): (a) **state → hash
  commitment** — barely helps size (the bulk is method *code*, not the 7 state ints) while adding covenant-
  verification risk; dropped. (b) **split `resolve`+Rabin into a separate contract** to give trades a Rabin-free
  script — only ~5 KB, needs a 2nd contract/UTXO; deferred as low-priority.
- Consequences: locking script 45.7 KB → **21.4 KB**, per-spend ~93 KB → ~44 KB (~2× more trades per ancestor
  budget, ~½ per-trade cost). Callers updated (`scryptEngine.ts`, `lifecycle.ts`, tests). Further slimming now
  needs opcode-level work (shared math helpers), with diminishing returns vs. this collapse. Optional gated
  mainnet re-measure of the real on-chain size remains (a user-authorized spend).

## ADR-021 · Off-chain execution engine + net-state batch settlement (CONC-001/002) · Accepted · 2026-08-05
- Context: ADR-019 chose off-chain execution + on-chain batched settlement. This ADR records the concrete MVP.
- CONC-001 — **execution layer.** New pure package `@pm/execution`: `ExecutionEngine` holds the authoritative
  in-memory LMSR state per market and fills orders instantly over `@pm/lmsr`; concurrent submits for a market
  are serialized by a per-market promise chain (a single total order, no UTXO contention). Each fill persists to
  `exec_orders` with an ECDSA-signed **receipt** (trader's proof + a state commitment); the sequencer key is
  env-only (Golden Rule 6). Proven by a 25-way concurrency test (seq 1..N, final state == N sequential fills).
- CONC-002 — **net-state settlement (MVP scope, chosen over full per-participant minting).** Because
  `eYes = exp(qYes/b)` depends only on NET `qYes`, a whole batch's e-state effect is `eYes *= mult^(net units)`
  (or `invMult` if net-negative) — a bounded multiplicative move. New contract method `settle(netYesUnits,
  netYesIsBuy, netNoUnits, netNoIsBuy, collateralDelta, collateralIsUp)` (bounded loops, `MAX_BATCH=20`) advances
  the pool by the batch net in ONE pool-version tx; the sequencer computes the identical net move, so state
  matches by construction. New engine path `buildSettleBatch` + `'settle'` BroadcastKind; daemon gains
  `POST /markets/:id/orders` (instant off-chain fill), `/receipts`, `/exec-positions`, and `POST /:id/settle`
  (enqueues into the SAME human sign-off queue). `applyEffects` writes one `exec_batches` row + N `trades` rows
  + stamps the settled orders, for one pool-version jump.
- Integer-rounding caveat: net-from-baseline `mult^net` equals the fill-by-fill state exactly for single-direction
  batches; mixing buys+sells on a side drifts sub-ppm (q stays exact). The settled state is DEFINED by the net
  computation (contract == engine), so the pool lineage is self-consistent across batches. Local test uses a
  buys-only batch for an exact three-way check (contract == engine == `@pm/lmsr` sequential).
- Trust scope (MVP): the contract verifies the net state transition + solvency, NOT per-fill cash validity, and
  position tokens stay as the signed receipts (no per-participant on-chain mint). Exact-cash validity + trustless
  settlement are CONC-003 (bond + fraud proofs → on-chain validity check). Reuses `@pm/lmsr`, `@pm/persistence`,
  `ScryptEngine`, and the daemon sign-off queue unchanged in shape. Contract script 21.4 → **30.2 KB** (settle's
  two bounded loops); still 34% below the pre-slim baseline, and amortized across a whole batch.
- Consequences: interactive off-chain trading with no UTXO contention; on-chain load = batches, not trades;
  per-trade cost → sub-cent amortized. Verified: `@pm/execution` 5 tests (incl. concurrency), daemon settle test,
  sCrypt `settle` local Script-verify + MAX_BATCH bound — 79 workspace + 9 sCrypt green, typecheck clean.

## ADR-022 · Auditable, non-equivocable settlement + fraud-proving auditor (CONC-003a) · Accepted · 2026-08-05
- Context: the CONC-002 settlement verifies the net state transition + solvency on-chain but TRUSTS the operator
  for which signed receipts a batch contains and how much cash it moves — it could settle a net that doesn't match
  the receipts users hold, drop/fabricate fills, or equivocate. This is the first trust-hardening step (ADR-019
  spectrum: custodial → **auditable/bonded** → validity-proof).
- Decision: bind every settlement to its exact batch of signed receipts and make it publicly auditable.
  (1) **On-chain commitment** — `settle` gains a `batchDigest` param and emits an OP_RETURN output pinning it
  (via `Utils.buildOpreturnScript`/`buildOutput`); no pool-state/constructor change, script 30.2→30.5 KB.
  (2) **Sequencer attestation** — the sequencer signs `marketId|fromVersion|toVersion|batchDigest|netYes|netNo|
  netCash|newStateHash`; two attestations for one `toVersion` = provable equivocation. Stored in `exec_batches`
  (migration 007). (3) **Off-chain auditor** (`@pm/execution/src/audit.ts` `auditSettlement`) — anyone can verify:
  every receipt's sig, receipts→net (units + cash), digest recompute, on-chain q-delta == receipts net×unit, and
  the attestation. Returns typed violations. Daemon: `GET /markets/:id/audit`.
- Also fixed a CONC-001 gap: the receipt's signed `ts` wasn't persisted, so a stored receipt couldn't be
  re-verified — added `exec_orders.ts` (007) + persist it. The batch digest = `sha256` over the ordered receipt
  payloads (flat; a Merkle root for compact per-receipt inclusion proofs is the CONC-003b upgrade).
- Trust move: from "trust the operator" to "the operator's settlement is publicly auditable and any cheat is
  cryptographically PROVABLE" — the substrate the bond + on-chain fraud-proof slash (CONC-003b) needs. NOT yet
  trustless: detection/proof exists, on-chain enforcement (bond slash) + validity-proof settlement are next.
- Consequences: reuses receipts/`ExecutionEngine`/`ScryptEngine`/daemon; only the settle path + a new auditor
  changed. Verified: `@pm/execution` audit tests (digest determinism/order/tamper, ts-persist re-verify,
  attestation sign/verify+tamper), daemon audit-flow (honest ok; tampered receipt → receipt_sig+net_cash+digest
  violations), sCrypt settle-with-OP_RETURN local Script-verify — 83 workspace + 9 sCrypt green, typecheck clean.
