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

## ADR-023 · Operator bond + on-chain equivocation-slash (CONC-003b) · Accepted · 2026-08-05
- Context: CONC-003a made settlements auditable (fraud is DETECTABLE off-chain) but nothing PUNISHES a cheating
  operator. This adds the enforcement layer — a slashable bond — the second step on the ADR-019 trust spectrum
  (custodial → **bonded + fraud-proof** → validity-proof).
- Constraint: Bitcoin OP_CHECKSIG only verifies TX signatures, so an attestation a contract must check over an
  arbitrary message has to be **Rabin**-signed (reusing the oracle machinery: `rabinsig` + `RabinVerifier`).
- Decision: **Bond contract + equivocation-slash.** The sequencer additionally Rabin-signs each settlement
  attestation `key ‖ digest` (`key = int2ByteString(marketId,4) ‖ int2ByteString(toVersion,4)`) — new
  `src/attestation.ts`. A `Bond` contract (`src/contracts/bond.ts`, ~2.3 KB) holds the operator's stake and
  offers: `slash(key, digestA, sigA, digestB, sigB, challenger)` — `RabinVerifier.verifySig` on both (each
  reconstructed as `key ‖ digest`, so same settlement by construction) + `assert(digestA != digestB)` ⇒
  equivocation ⇒ pay the whole bond to the challenger; and `withdraw(sig, pubkey)` — operator reclaim gated by a
  CLTV challenge window (`timeLock(matureAt)` + `checkSig`). No in-script byte-slicing (challenger supplies the
  fields). Daemon records the Rabin attestation per settlement (migration 008; `ScryptEngine.rabinAttest`,
  `MockEngine` stub) so a real equivocation is slashable; `/audit` surfaces `rabinAttested`.
- Honest scope: slashes **equivocation** (double-committing conflicting settlements for one version) — the
  operator cannot lie about WHICH settlement happened without losing the bond. It does NOT alone prove a single
  settlement's net equals its receipts arithmetically (validity-proof/dispute endgame). Challenge-window,
  bond-size, partial-slashing, griefing are noted for production, not tuned.
- Consequences: equivocation is now unprofitable on-chain; combined with the 003a on-chain commitment, the
  canonical settlement can't be contradicted. Verified: 4 Bond mocha tests (slash a REAL equivocation verifies vs
  node Script + pays the challenger; reject same-digest + forged Rabin sig; withdraw CLTV-gated before/after
  maturity), daemon records + surfaces the attestation — 83 workspace + 13 sCrypt green, typecheck clean. Gated
  mainnet demo runner `mainnet-bond.ts` (deploy Bond → slash).

## ADR-024 · Backtrace-verified token redeem (CONC-003c) · Accepted · 2026-08-05
- Context: `redeem` trusted the caller's `supply`/`winner` (VERDICT gap #2) — over-claim / redirection / token-less
  redeem were possible. This closes it: redeem must co-spend a genuine on-chain position token, verified on-chain.
- Constraint: a UTXO contract can't read another input's script from its own ScriptContext, and `scrypt-ts-lib`
  has no Backtrace helper — so the pool must **backtrace** input #1 manually. Confirmed tractable with `slice`,
  `Utils.readVarint`/`buildOutput`, `len`, `ctx.utxo.outpoint`, `ctx.hashPrevouts`.
- Decision: **data-carrying token + reconstruction backtrace.** `buy` mints a token output
  `<push marketTag‖side‖supply(8)‖holderPKH> OP_DROP P2PKH(holder)` (spendable only by the holder, carries the
  fields). `redeem(isYes, supply, holder, tokenSats, prevHeader, poolOut, prevTail, allOutpoints)` REBUILDS the
  token output, requires `poolOut` to be exactly one output (so the token is output index 1), computes the mint
  txid `= hash256(prevHeader‖poolOut‖tokenOutput‖prevTail)`, and binds it via `hashPrevouts`
  (`slice[0:36]==poolOp`, `slice[36:72]==tokenTxid‖1`). No general byte-walk. supply/holder/side/market come from
  the CHAIN ⇒ no token-less redeem, no over-claim, no redirection. Pool script 30.5 → **32.9 KB** (+2.3 KB).
- Verified: `tests/redeemBacktrace.test.ts` — a genuine mint → co-spend redeem **passes the real node Script
  interpreter for all inputs**; and each attack is **rejected** (over-claim, redirection, wrong token vout). The
  co-spent token input is signed with a real key; the offline-only DummyProvider fee simulation (which conflicts
  with bsv's fee guard for this large-covenant multi-input tx) is stubbed — the Script verify is the guarantee.
  16 sCrypt + 83 workspace green, typecheck clean.
- **Engine integration (DONE, same ticket):** `ScryptEngine` now tracks the token minted by each `buy` (script +
  the split mint-tx pieces, with the reconstruction verified against the real txid before use) and `execRedeem`
  builds the co-spend explicitly — pool #0, token #1, funding #2 — so `allOutpoints` is deterministic and matches
  `hashPrevouts`; it signs the two P2PKH inputs with the funding key (NONE|ANYONECANPAY, since the framework
  inserts the pool's covenant unlock afterwards) and reserves fee for that unlock. `autoPayFee:false` stops the
  framework appending inputs after the covenant committed to the outpoint set. Redeeming without a tracked token
  is refused (`EngineLimitation`) rather than broadcasting something the hardened contract would reject.
  Offline `network='local'` uses a `LocalProvider` that stubs the (chainless) broadcast simulation — its fee
  re-check conflicts with bsv's guard on these large multi-input txs and runs only AFTER real Script verification.
- Verified end-to-end: `tests/engineRedeem.test.ts` drives **deploy → buy(mint) → resolve → redeem(co-spend +
  backtrace)** through the engine, all against the real node Script (18 sCrypt + 83 workspace green).
- Honest remaining scope: a **gated mainnet run** of the hardened redeem (a real spend) is not yet done;
  `runLifecycle` still covers deploy→buy→resolve (the engine path is the integrated one).
  _[Update: the gated mainnet run was completed — mint `8328f669…` → deploy `1c1660e3…` → redeem
  `c6d8900f…`, confirmed block 961048.]_

## ADR-025 · Square-and-multiply batch cap: MAX_BATCH 20 → MAX_NET 4095 (CONC-006) · Accepted · 2026-08-06
- Context: a **measured** benchmark of the shipped engine (`scratchpad/bench.ts`) showed the off-chain layer fills
  **~1,240 bets/sec at ~0.8 ms each** (ECDSA receipt signing is **99.7 %** of that cost; LMSR math 0.3 µs and the
  SQLite insert 2.3 µs are free), and that balanced flow batches beautifully. But `settle` advanced a side with a
  **linear** loop, so `MAX_BATCH = 20` capped the **net** move — and prediction markets are directional. Measured
  on 1,000 fills: balanced net 16 (1 settlement) but 55 % skew → 88 (5), 70 % → 238 (12), all-buys → 530 (**27**).
  Under the exact conditions that make a market busy, throughput collapsed to ~20 trades per settlement.
- Decision: compute `mult^n` by **square-and-multiply** over a fixed 12 bits (`MAX_NET_BITS = 12`,
  `MAX_NET = 4095`) instead of `n` linear steps. The bit test is `e - (e/2)*2` (avoids `%`, whose sCrypt support
  is unverified; `*` and `/` are known-good). Canonical definition: `powFixed` in `packages/lmsr/src/fixed.ts`;
  the sCrypt contract and both engines run the identical loop.
- **Consensus-critical detail:** repeated squaring **rounds differently** than multiplying `n` times, so the
  operation order and truncation ARE the definition — the sequencer and the contract must run the same routine or
  the settlement simply fails to verify (a safe failure, not a fund risk). Pinned by `pow` vectors generated from
  `@pm/lmsr` into `tests/fixtures/vectors.json`, asserted by the sCrypt tests — the existing equivalence
  mechanism, since `contracts-scrypt` is npm-isolated and cannot import `@pm/lmsr`.
- **Bug found + fixed along the way:** `settle` never asserted `q ≥ 0`, so a net-sell settlement could drive net
  shares negative (and the stored exponential below `exp(0)`). Added `assert(qYes >= 0)` / `assert(qNo >= 0)`.
  Surfaced by a degenerate `invMult^4095 = 0` vector — the vectors earned their keep immediately.
- Consequences: the cap rises **~200×** and the script got **smaller** — 32,889 → **29,801 B (−3,088)** — because
  2 sides × 12 bit-steps costs less than 2 × 20 linear steps. **Every measured flow shape now settles in ONE tx**,
  including all-buys. Also added `ExecutionEngine.resyncState`, called from the daemon's settle branch, so the
  off-chain state adopts the chain's settled exponentials at each boundary (sub-ppm; also groundwork for CONC-005).
- Verified: 5 new `powFixed` tests; sCrypt **net 530 settles in one tx vs real Script**, net 4096 rejected, oversell
  rejected — **20 sCrypt + 88 workspace green**, typecheck clean. Practical note: the usable net is bounded by
  economics, not the cap — `n/b` must stay sane (at `b = 1000`, net 4095 ⇒ `e^4.1`; a toy `b = 10` would saturate
  long before 4095).

## ADR-026 · Restart-safe engine state: rebuild from the plan + chain, not memory (CONC-005) · Accepted · 2026-08-06
- Context: `ScryptEngine` held every market's live contract instance in `instances`/`tokens` maps, so a daemon
  restart mid-lifecycle **stranded the market** (`no live pool for market N`) even though the pool UTXO was
  healthy on-chain. Last item between the spike harness and an operable service (flagged in VERDICT "owed").
- Enabler (de-risked first, before building on it): sCrypt's `LMSRMarket.fromUTXO({txId,outputIndex,script,
  satoshis})` restores **all 7 mutable state props AND all 7 constructor consts** + `marketTag`, the locking
  script round-trips byte-identically, and the rebuilt instance can produce a continuation — measured, not assumed.
- Decision: **the pool recovers with no network call and no new storage.** Every build descriptor carries a
  `PoolUtxoRef` (txid/vout/sats/lockingScript); those already round-trip through `broadcasts.plan`, so a plan
  enqueued before a restart stays executable after one. `exec*` became
  `this.instances.get(id) ?? await this.livePool(id, b.pool)`. The engine stays DB-free (npm-isolated,
  structurally typed) — the service already computed exactly this `PoolRef` for every `build*`.
- **Token recovery is chain-sourced.** The backtrace needs the mint tx split into `prevHeader‖poolOut‖prevTail`
  (~30 KB — the pool output dominates), so those are **derived, never stored**: `liveToken` re-fetches the mint
  tx by txid and re-splits it with the existing verified `splitMintTx`. Only the small identity (txid/vout/sats/
  script/holderPkh/shares/side) is persisted — the previously-unused `tokens` table, now written on buy and
  burned on redeem (migration `009_token_script` adds `script`/`holder_pkh`/`sats`; `owner_key_id` is a key-ref,
  not a PKH). `TxEffects.token` carries it, mirroring how `pool` works (service fills the txid post-broadcast);
  `buildRedeem` gained an optional persisted-token argument. `LocalProvider` remembers what it "broadcast" so the
  offline path can exercise recovery without a chain.
- Consequences: a restarted daemon resumes any market. Verified by `tests/restart.test.ts`, which drives a
  **genuinely new `ScryptEngine`** (empty maps) through resolve + settle from the persisted plan alone, asserts
  q/e carry across the restart untouched, and checks the token effect is persistable — **24 sCrypt + 88 workspace
  green**, typecheck clean.
- Honest scope: token recovery after a *cold* restart genuinely depends on the provider (`getTransaction`) —
  offline it works only via the `LocalProvider` cache. One minted token per market (the spike's shape).

## ADR-027 · Trader-authenticated orders + the real multi-wallet market (LIVE-001) · Accepted · 2026-08-06
- Context: every mechanism was proven on mainnet but always **in pieces, and three with synthetic inputs** (a
  fabricated 5-fill batch, a hand-built mint tx, a self-dealt slash). Nothing had run as one system with real,
  distinct users — the gap between "the mechanism works" and "you can build a UX on this".
- **Security gap found while scoping it:** `ExecutionEngine.submit()` took `trader` as a plain pubkey string and
  **verified nothing**, so the operator (or anyone with API access) could fabricate fills in any user's name.
  That makes "real wallets as clients" meaningless, so it had to be fixed first.
- Decision: **orders are authenticated by the trader.** The trader signs
  `marketId|trader|side|action|units|nonce` with their own key (`packages/execution/src/order.ts`, mirroring
  `receipt.ts`); the engine verifies **before filling**, so a fill can only exist if the user authorized it.
  Migration `010_order_auth` persists the signature + nonce with `UNIQUE(market_id, trader_pubkey, nonce)`, so a
  replay fails at the DB even if verification were bypassed. The trader's key never reaches the daemon, and
  **traders need no BSV** — they only sign; the operator pays every on-chain fee (a real onboarding property).
- **Measured cost of the fix:** throughput fell **1,240 → 404 fills/sec** (2.47 ms/fill) because each fill now
  does an ECDSA *verify* (order) on top of the *sign* (receipt). Still far beyond product need; native
  secp256k1 bindings are the lever. Recorded rather than hidden — security was worth the 3×.
- **Proven live on BSV mainnet (2026-08-06), the first genuinely end-to-end run** — driven over HTTP against the
  real daemon, 4 distinct trader wallets, no synthetic inputs:
  | step | tx | detail |
  |---|---|---|
  | deploy | [`b8473fd2…290dbb`](https://whatsonchain.com/tx/b8473fd2503d661f52d75884cd8ca4a904d698b4e10cf310314380616b290dbb) | 30,483 B — **block 961087** |
  | **settle** | [`0c90cc39…845773`](https://whatsonchain.com/tx/0c90cc39cc8a8d8c4c9713179281a3d4493bcee4e2b82b6e72802f373b845773) | **26 real signed fills → ONE tx**; 2-in/3-out (pool + commitment + change), 61,107 B — **block 961087** |
  | resolve | [`8782ed70…e9602b`](https://whatsonchain.com/tx/8782ed7037122419a8c0a5ac8a5df5c98a20e1b4805f1c09346f31ec7fe9602b) | Rabin oracle YES, 61,445 B — **block 961088** |
  Verified after the fact: **audit ok, 26 receipts, 0 violations, Rabin-attested**; all 26 receipts verify;
  4 distinct trader wallets; **26/26 orders carry a trader signature + nonce**. Batch: net YES 15, NO 7,
  11,021 sat net collateral. ~77k sats total.
- **Honest gap this surfaced:** settled **off-chain** positions have **no on-chain payout path**. Traders hold
  audited signed receipts, not per-participant tokens, and `redeem` requires a token minted by an *on-chain*
  buy — so it does not apply to this flow. Receipt → on-chain payout (per-participant minting, or validity-proof
  settlement) is the remaining piece of the user journey. The runner states this explicitly rather than failing
  quietly; the redeem *mechanism* itself is separately proven on mainnet (`c6d8900f…`).

## ADR-028 · The receipt → on-chain payout bridge (PAYOUT-001) · Accepted · 2026-08-06
- Context: LIVE-001 proved real users can trade and that the settlement provably matches what they signed, but
  exposed the last hole in the user journey — **a winner could not get paid**. Settled positions are audited
  signed receipts, not per-participant tokens, and `redeem` requires a token minted by an *on-chain* buy, so it
  does not apply to off-chain fills. Traders could prove they won and still had no way to claim satoshis.
- Decision: a new `payout` contract method pays **every winner in ONE tx**.
  `payout(winners: FixedArray<PubKeyHash,8>, amounts: FixedArray<bigint,8>, count, payoutDigest)` — bounded loop
  (`MAX_PAYOUTS = 8`, the `settle` early-skip pattern) builds one P2PKH output per winner, sums the total, and
  asserts **resolved**, **`collateral >= total`**, and decrements collateral by exactly what leaves. Outputs are
  `state + OP_RETURN(payoutDigest) + N winner outputs + change`. Off-chain, `winningPayouts` folds the fill
  ledger into each trader's NET position on the winning side (losers and flat traders get nothing) and
  `computePayoutDigest` commits to the ordered list, pinned on-chain and auditable.
- **Nice property:** traders are identified by their public key, so the payout address is `hash160(pubkey)` —
  *the key you trade with is the key you get paid to*. No registration, no address collection step.
- Trust boundary (unchanged from `settle`): the contract enforces **resolution, solvency and the collateral
  decrement** — the operator cannot invent funds or over-pay the pool. It does NOT verify each recipient's
  receipts on-chain; that correctness is committed, auditable and bond-backed. Per-winner on-chain verification
  is the validity-proof endgame.
- Cost: script 29,801 → **36,762 B** (+6,961 for 8 winner slots, ~870 B each) — still below the original
  45,675 B baseline, but note the tax applies to *every* spend, which is a further argument for slimming.
- Verified: 4 contract tests vs real node Script (pays each winner exactly; **rejects** over-collateral,
  unresolved market, and bad counts) + 4 off-chain tests (losers get nothing, sells net off, digest tamper-
  sensitive). Local end-to-end: 26 real signed fills → settle → audit ok → resolve → **4 winners paid 15,000
  sat in one tx**. 98 workspace + 28 sCrypt green. Migration 011 adds the `payout` broadcast kind + a `payouts`
  audit table; daemon exposes `POST /markets/:id/payout` and `GET /markets/:id/payout-preview`.

## ADR-029 · A face on the system: trader app + operator console, and the daemon gets auth (UI-001) · Accepted · 2026-08-06
- Context: after PAYOUT-001 the whole journey worked on mainnet — real wallets trade, batches settle in one tx,
  settlements are auditable, winners get paid — but it had only ever been driven by a CLI runner. Nothing a
  stakeholder could look at, and nothing a team could build on. `CLAUDE.md` listed "Web UI" as **out of scope**
  for the spike; this is a deliberate step past spike into platform work, recorded here rather than left as a
  silent contradiction. `CLAUDE.md` is updated to match.
- Decision: **`apps/web`** — Vite + React + TypeScript, talking only to the daemon's existing HTTP API.
  - **Trader**: market list with live prices → market detail with an order ticket (side / buy-sell / size, live
    quote) → sign → submit; own position, own receipts, own payout.
  - **Operator**: the **sign-off queue** as the centrepiece (every state change parks there with a
    human-readable summary and a sat cost until a human authorizes it), plus deploy / settle / resolve / pay
    winners, the audit report, the payout preview, and wallet balance.
  - Polling (2–5 s), no websockets. The daemon is local; a socket layer would be complexity without a need.
- **Signing stays with the user.** A `Signer` seam (`src/signer/`) has two implementations:
  - `WalletSigner` — a **real BRC-100 wallet** via `@bsv/sdk` `WalletClient.createSignature`
    (`protocolID [0,'pm order']`, `keyID = nonce`, `counterparty 'anyone'`); the private key never leaves the
    wallet. The daemon verifies with `new ProtoWallet('anyone').verifySignature({..., counterparty: trader})` —
    **no wallet needed server-side**, which is what makes browser signing viable at all.
  - `LocalSigner` — a dev key in the browser, used only when no wallet is reachable, and the UI says so in a
    warning banner. Stated plainly rather than implied to be wallet-custody.
  Both schemes coexist: migration `012_sig_scheme` records `ecdsa` (the mainnet-proven path, unchanged) or
  `brc100` per order, and `verifyOrder` dispatches. Payload is identical, so nothing about settlement changes.
- **Security change forced by the UI — the daemon had no auth at all.** Any caller reaching 127.0.0.1:8787 could
  `POST /broadcasts/:id/authorize` and spend the funding wallet; acceptable when the only client was a local
  CLI, not once a browser page can call it. Money-spending routes (deploy/buy/sell/resolve/redeem/settle/payout/
  authorize/reject) now require `x-pm-operator-token` = `PM_OPERATOR_TOKEN`; trader routes stay open because an
  order already carries the trader's own signature. CORS is restricted to localhost origins, never a wildcard.
  **Honest limit:** a shared secret over plain HTTP on loopback. Adequate for local operation; *not* a reason to
  expose the daemon to a network — it still binds 127.0.0.1 only.
- Verified: 11 BRC-100/ECDSA order tests (genuine accepted; tampered payload, impersonation and cross-scheme
  confusion all rejected), 11 operator-gating tests (each money route 401s unauthenticated, nothing is queued by
  a refused call, reads/trader routes stay open, unset token keeps the dev default), **114 workspace tests
  green**, typecheck clean including `apps/web`, production build clean.
- **Acceptance: the whole journey driven through the UI** (`apps/web/test/ui-journey.test.tsx`, `PM_UI_E2E=1`
  against a live daemon on `PM_NETWORK=local`): create → deploy → **sign an order in the browser layer** →
  settle → audit ok → resolve YES → pay winners; all 4 broadcasts authorized through the queue and broadcast,
  audit `ok: true` / 1 receipt / 0 violations / Rabin-attested, 1 winner paid 5,000 sat.
- **Honest gap:** the components are driven in **jsdom**, not a real browser — the harness available here blocks
  a headless browser's subresource requests, so there is no layout/paint coverage. And **no BRC-100 wallet was
  installed**, so `WalletSigner` is covered by unit tests and the verification contract, *not* by a live wallet
  round-trip. Claiming otherwise would be exactly the kind of "tests pass but it breaks when I try it" this
  project has been guarding against. A wallet round-trip is the first thing to do when one is available.
- No mainnet spend for this ticket — the local network exercises the identical code path.

## ADR-030 · Four defects the first real user hit in ten minutes (UI-002) · Accepted · 2026-08-06
- Context: the first session driven by a human rather than by the acceptance test failed at step 2 and again at
  step 4, on a DB that already held markets from earlier runs. The acceptance test never caught any of it
  because it always ran against an **empty** database — a shape real usage never has. Recorded because the
  pattern ("tests pass, the human hits it immediately") is the exact failure mode this project keeps guarding
  against, and three of the four were UI defects introduced in UI-001.
- **D1 — the console silently acted on the wrong market.** It defaulted to `markets[0]`, the *oldest*, and
  "new market" did not select what it had just created. Against a populated DB every operator action pointed at
  a months-old market: "deploy pool" appeared broken (that market already had a pool), and settle/resolve
  targeted stale state. Fix: default to the **newest** market and select the one just created. Pinned by a
  regression check in the journey test that creates a *second* market and asserts the selection moves.
- **D2 — nothing on screen said which network the daemon was on.** `pnpm daemon` reads `PM_NETWORK` from `.env`,
  which is **mainnet** by default, so a user following the README was one *authorize* click from an irreversible
  real spend with no indication. Fix: `/health` now reports `network`/`engine`/`operator_auth`; the header shows
  a **MAINNET · real money** badge, a standing banner explains how to switch to `local`, and on mainnet
  *authorize* requires a second **confirm — spend N sat** click. The queue also labels each row as real money or
  local. Worth noting this was the most dangerous of the four and the least visible.
- **D3 — markets were indistinguishable, so the wrong one got traded.** Cards showed only a question and prices.
  The user opened a market from an earlier run and was quoted **52,497 sat for one share** (that market pays
  100,000 sat/share, `b=10`) with nothing to signal it. Fix: id, `sat/share` and `b` on every card, in the
  detail header, and in the operator's market selector; the list is newest-first.
- **D4 — a pool from an older contract build fails with an unreadable error, after approval.** A pool's locking
  script *is* the compiled contract, so an earlier build's pool can never be spent by a later one — and the
  contract's size has changed six times here (45,675 → … → 36,762 B) while the DB outlives every build. sCrypt
  reports this as `the raw script cannot match the ASM template of contract LMSRMarket`, which says nothing, and
  it surfaced only at authorize time — i.e. **after a human had approved a spend**. Fix, in two parts:
  (a) `ScryptEngine.livePool` catches it and explains — *"this pool was deployed by a DIFFERENT build … (3,458 B
  on chain vs 36,818 B compiled now) … deploy a fresh market"*; (b) a new optional `ChainEngine.poolSpendable()`
  (cached, pure CPU, no network) surfaces `pool.spendable` on the market JSON so the UI **flags the market and
  disables the doomed actions instead of letting them be queued**. Trading on such a market is blocked too — an
  off-chain fill there could never be settled.
- Verified against the **user's actual database** (restored via `sqlite3 .backup`, their file untouched): the
  Rúnar-era market #1 now reports `spendable=false` and its settle returns the readable message; markets #2–#6
  — five markets created by the D1 bug — correctly show no pool. Full journey re-run through the UI, green.
  **115 workspace tests**, typecheck + build clean.
- **Operational gotcha found while fixing D4:** `packages/contracts-scrypt` is npm-isolated and the daemon
  imports its **compiled `dist/`**, so engine edits do nothing until `npm --prefix packages/contracts-scrypt run
  build`. This cost a debugging cycle here; now written down.
- **Bonus, and the good news:** the user's run also closed UI-001's honest gap — their order was signed by a
  **real BRC-100 wallet** (the UI showed "Signed with your wallet") and the daemon verified it and filled.
  `WalletSigner` is now proven against a live wallet, not just unit tests.

## ADR-031 · Mainnet pre-flight: measure the cost before spending it (MAINNET-002) · Accepted · 2026-08-06
- Context: asked to run the full journey on mainnet "to demonstrate production". Every prior mainnet run was
  scripted; this one is to be **clicked through a UI**, which makes wall-clock and per-click cost user-visible
  facts rather than script details. Two things had to be known before spending: what it costs, and whether it
  can be done in one sitting. Neither was measurable — so the first work was making them measurable.
- **`BroadcastResult` now carries `sizeBytes`/`feeSats`,** surfaced through `authorize` and shown in the
  operator console (`… broadcast abc123… · 73.3 KB, fee 37,514 sat`). The covenant re-publishes the whole
  compiled contract on every spend, so **size, not economic value, is the cost** — that number belongs in front
  of the person authorizing it.
- **New `pnpm --filter @pm/spike measure:journey`** — drives create → deploy → 3 signed fills → settle → resolve
  → payout against a `PM_NETWORK=local` daemon (free; tx construction is byte-identical to mainnet) and reports
  per-stage size, the mainnet fee at 500 sat/KB, and where the ~101 KB unconfirmed-ancestor budget forces a wait.
  **Measured (current build, 36,762 B contract):**
  | stage | size | mainnet fee |
  |---|---|---|
  | deploy | 37,444 B | ~18,722 sat |
  | settle (3 fills → 1 tx) | 75,028 B | ~37,514 sat |
  | resolve | 75,365 B | ~37,683 sat |
  | payout | 75,301 B | ~37,651 sat |
  | **total** | **257 KB** | **~131,570 sat** |
- **Finding — the journey no longer fits in one block window.** `live-market.ts` was written when deploy (~31 KB)
  + settle (~60 KB) = 91 KB fit inside ~101 KB. Adding `payout` grew the contract to 36,762 B, so deploy+settle
  is now **109.9 KB** and every stage needs its own window: **3 confirmation waits**, 10–60 min each. A "quick
  live demo" is really a 30-minute-to-3-hour exercise. Stated up front rather than discovered mid-demo.
- **Bug found in pre-flight — `/wallet/balance` reported 0 on a funded mainnet wallet.** `ScryptEngine.getUtxos`
  returned a hardcoded `[]` ("sCrypt auto-funds internally"), which is harmless for funding and actively
  dangerous for the **one number an operator checks before authorizing a spend**. Now queries the provider on
  mainnet; verified against WhatsOnChain: `1GfBrmSWX9jrMPJ2jUjkyhVs1gMj8E8PBD` → **515,369 sat / 4 UTXOs**,
  matching exactly. (4 separate UTXOs is also useful: sequential stages can each take a different confirmed
  input, which is what BUG-003 was about.)
- Funding check: ~131,570 sat of fees + 5,000 sat of payouts + dust ≈ **~137k sat** against **515,369 sat**
  available — comfortable, ~27% of the wallet.
- Not yet spent. This ADR covers the pre-flight only; the run itself is gated on explicit user go-ahead.

## ADR-032 · The operator token had no way to be checked (UI-003) · Accepted · 2026-08-06
- Context: on the first token-protected mainnet daemon, clicking *deploy* returned `operator token required for
  this action` — a bare 401 at the moment of a real spend. The token gate (ADR-029) was working exactly as
  designed; the failure was that **nothing told the operator a token was needed, and nothing could tell them
  whether the one they had was right.** Note `PM_OPERATOR_TOKEN` is read from `process.env` only, never from
  `.env` — so it must be on the daemon's command line, and the browser needs the same value entered separately.
- Decision: make the token's status **observable before it costs anything**.
  - New side-effect-free `GET /operator/check` → 200 `{ok, required}` with a valid token, 401 without. Verified
    it queues nothing.
  - The console polls it and shows **accepted / rejected / required** next to the field, distinguishing "no
    token set" from "token is wrong" — indistinguishable from a 401 alone.
  - While not accepted, **every button that queues or authorizes is disabled**, with an explanation naming the
    daemon's command line as the source of the value. A spend can no longer be attempted into a 401.
  - 401s from any route now render as a human sentence rather than the raw server message.
  - Pasted tokens are **trimmed** — a trailing newline is the classic silent mismatch.
- Verified live against a token-protected daemon: `/health` reports `operator_auth: true`; `/operator/check`
  returns 401 for a missing token, 401 for a wrong one, 200 for the right one; and the **full UI journey passes
  with auth enabled** (create → deploy → signed order → settle → audit → resolve → pay winners). 116 tests green.
- Pattern worth noting, third time now: the acceptance test kept passing because it configures itself correctly
  (it writes the token straight to localStorage). Every defect in this UI so far has been in the gap between
  "correctly configured" and "what a person actually walks into".

## ADR-033 · A polled balance view silently emptied the funding wallet (MAINNET-003) · Accepted · 2026-08-06
- Context: the first real mainnet attempt failed at authorize with `no sufficient utxos to pay the fee of 18740`,
  on a wallet holding **515,369 sat**. Nothing was broadcast; no money was spent.
- **Root cause — a regression introduced by ADR-031's own bug fix.** That fix made `/wallet/balance` real by
  calling `this.signer().listUnspent(address)`. But `TestWallet.listUnspent()` is **not a query**: with
  `splitFeeTx` on (the scrypt-ts default) it delegates to `CacheableUtxoManager.fetchUtxos(0)`, whose first line
  is `return this.availableUtxos.splice(0)` — it **drains** the wallet's funding cache and hands the entries to
  the caller. The operator console polls the balance every 10 s, so the first poll emptied the wallet and every
  subsequent spend found nothing to fund with. (The second poll also blocks ~30 s in a "waiting for available
  utxos" retry loop before returning 0 — the endpoint got both slower and wrong.)
- Fix: **the provider and the signer are now separate.** `provider()` holds the read-only chain provider and all
  reads go through it; only spends touch the signer. Verified on mainnet: six consecutive `/wallet/balance`
  polls all return `515,369 sat / 4 utxos`, stable. `execRedeem` still reads through the signer — that path
  *claims* a utxo to spend explicitly, so draining is intended there; it is now commented as a trap not to copy.
- **Second fix, from the same investigation: a failed broadcast used to poison the process.** sCrypt removes the
  utxos it claims when funding and restores them only on success, so after any failure the wallet is missing
  them and every later spend reports "no sufficient utxos" — indistinguishable from being broke. Now
  `authorizeAndBroadcast` catches, drops the signer/provider and clears the warm contract instances, so the next
  attempt re-reads the chain. Rebuilding those instances is free and network-less — precisely what CONC-005 was
  built for. This matters because the mainnet run needs **3 confirmation waits**, and a retry after a genuine
  failure has to work.
- Verified: 116 tests green, typecheck + build clean, and the **full UI journey passes** after the refactor.
- **Lesson worth keeping:** the failure was loud and cost nothing because the fee check runs before signing.
  A read-shaped API (`listUnspent`) with write semantics is a genuine trap in scrypt-ts — the name gives no
  hint, and the damage only shows up on the *next* operation, far from the call that caused it.

## ADR-034 · MAINNET-001 — the full journey, live; and winners got paid twice · Accepted · 2026-08-06
- **The run.** Create → deploy → three wallet-signed orders → settle → audit → resolve YES → pay winners, driven
  entirely **through the web UI** against mainnet, each step authorized by a human in the sign-off queue.
  | stage | txid | size | fee | block |
  |---|---|---|---|---|
  | deploy | [`f7b4e8cd…7b42db`](https://whatsonchain.com/tx/f7b4e8cd110727c9c9e9406a3655a0d60c1982337d60a798b438034bec7b42db) | 36.6 KB | 18,738 sat | **961149** |
  | settle (3 signed fills → 1 tx) | [`484b5167…ee4ce7`](https://whatsonchain.com/tx/484b5167bab5c3216422d5e313ae729ed4ab553a7f90160c9f52acc485ee4ce7) | 73.3 KB | 37,531 sat | **961149** |
  | resolve (Rabin oracle, YES) | [`4c5bcd43…4bc570`](https://whatsonchain.com/tx/4c5bcd43e7f33883b2548550b580eeeddce0d5b21545a81ebbb1a0ba4a4bc570) | 73.6 KB | 37,699 sat | **961149** |
  | payout | [`6dd31acc…0c4229`](https://whatsonchain.com/tx/6dd31acc365fd66b3ef57b50b8511453a11d2d3c3287b27670263f78240c4229) | 73.5 KB | 37,649 sat | mempool |
  Payout outputs verified on chain: pool continuation (1 sat) + `OP_RETURN` payout digest + **3,000 sat P2PKH to
  `1B2a3Pv75wx1nxYKe9X8j2KopmN1Fn1wXv`** + change. Audit reported ok — 3 receipts, 0 violations, Rabin-attested.
- **ADR-031's ancestor-budget prediction was WRONG, and worth correcting.** It predicted deploy+settle at 109.9 KB
  would exceed a ~101 KB unconfirmed-ancestor limit and force 3 confirmation waits of 10–60 min. In reality
  **deploy, settle and resolve all confirmed in the same block (961149)** as a 3-deep chain totalling 183.5 KB.
  The limit did not bind. Predicted cost was accurate (~131,570 sat predicted vs 131,617 actual, 0.04% out);
  predicted *pacing* was not. Measure, don't infer from a stale comment.
- **DEFECT FOUND — winners were paid TWICE (real money).** A second `payout` produced
  [`9a1879b2…62d0f8`](https://whatsonchain.com/tx/9a1879b292652a8ff2588910bc9671ebe2bd7b547637662aed1575457762d0f8),
  which spends `6dd31acc:0` — the pool output the *first* payout created. Not a conflicting double-spend: they
  **chain**, so both confirm and the winner receives **6,000 sat for 3 winning shares**, plus ~37,650 sat of
  wasted fee. Verified: the winner's address holds 6,000 unconfirmed.
  - Cause: `winningPayouts` derives from the receipt ledger, and paying does not change that ledger, so a second
    call recomputes the identical winner set. The `payouts` table (migration 011) already recorded the first
    payment — **nothing consulted it**. `payoutPreview` likewise kept reporting the debt as outstanding, so the
    UI's *pay winners* button stayed enabled and inviting.
  - Fix (service layer, where the authority is): `enqueuePayout` refuses when `payouts` has rows for the market,
    naming the tx that already paid; `payoutPreview` moves paid winners into a separate `paid` list so nothing
    reads as owed; the console shows "already paid … — paying again would send REAL money twice". Four
    regression tests pin it, including "queues no second broadcast when refused".
  - **Remaining ON-CHAIN gap, stated plainly:** the contract still permits the replay. `payout` asserts
    `resolved` and `collateral >= total` and decrements collateral, but `collateral` is spike state seeded at
    1e9, so it never binds — the same winners can be paid until it runs out. The proper fix is a `paid` flag in
    contract state (the `resolved` pattern; `MAX_PAYOUTS = 8` already caps a market at one payout tx, so a flag
    costs no generality). Not done here because it changes the compiled contract, which **strands the live pool**
    and needs a fresh deploy + re-measure — the user's call, not a silent change.
- Honest read: the mechanism worked end to end with real wallets and real money, and the one thing that went
  wrong was an *operator-facing safety* gap, not a protocol failure. The trust boundary of ADR-028 already said
  the contract does not verify recipients; this shows that boundary has a sharper edge than it sounded.

## ADR-035 · `payout` is idempotent on-chain: the `paid` flag (MAINNET-005) · Accepted · 2026-08-06
- Context: ADR-034 stopped the double-payment at the daemon, and left the on-chain gap open and named. Closing it
  was chosen deliberately over leaving "the daemon prevents it" as the answer — an operator double-click draining
  the pool is the first thing a reviewer asks about, and consensus is a better guarantee than a service check.
- Decision: a new stateful prop `paid: bigint` on `LMSRMarket`, following the `resolved` pattern. `payout`
  asserts `this.paid == 0n` and sets `this.paid = 1n`. Initialized to `0n` in the constructor body rather than
  as a constructor parameter, so **no call site changed** — the compiler bakes the initial value into the
  deployed script. `MAX_PAYOUTS = 8` already caps a market at a single payout transaction, so one flag costs no
  generality. The off-chain tx builders (engine + tests) mirror `next.paid = 1n`; without that mirror the
  contract's `hashOutputs` check fails, which is exactly the coupling that makes the state real.
- Why solvency was never enough: `payout` already asserted `collateral >= total`, but `collateral` is spike state
  seeded at 1e9 — far above any real liability — so a replay simply decremented it again. The guard has to be a
  flag, not a balance.
- Cost: script **36,762 → 40,073 B** (+3,311 B, +9%), and a full journey **131,570 → 142,969 sat** (+8.7%).
  Per-stage: deploy 39.7 KB / 20,350 sat · settle 79.6 KB / 40,772 · resolve 80.0 KB / 40,939 ·
  payout 79.9 KB / 40,907. Paid knowingly: 11.4k sat to make a double-payment impossible rather than merely
  discouraged.
- Verified: **29 sCrypt tests** green including a new `REJECTS a SECOND payout` case that replays against the
  pool output the first payout produced — the exact shape of the mainnet incident — and is refused by the real
  Script interpreter. 120 workspace tests green, typecheck + build clean. End-to-end on `local`: the journey
  completes, the payout preview then reports **0 winners owed**, and a second `POST /payout` returns
  `409 winners of market 1 were already paid 5000 sat in tx 00f10c4b…`.
- **Correction shipped with it:** `measure:journey` no longer warns about a ~101 KB unconfirmed-ancestor limit
  forcing confirmation waits. ADR-034 measured a 3-deep 183.5 KB chain confirming in one block; the figure is
  miner policy, not consensus. The tool now reports chain depth and cumulative size as information, and states
  what was actually observed.
- **This strands every pool deployed by an earlier build**, including the live mainnet one — by design: the
  locking script *is* the contract. `poolSpendable` (ADR-030) already flags those markets in the UI, so the old
  pool shows as unspendable rather than failing at authorize time. A fresh deploy is required to demonstrate the
  new build on mainnet.

## ADR-036 · MAINNET-005 proven live: the whole journey clicked, and the replay refused by consensus · Accepted · 2026-08-07
- The second mainnet run, on the `paid`-flag build (ADR-035), driven **entirely by a human through the web UI** —
  market created, pool deployed, orders signed in a **real BRC-100 wallet**, settled, audited, resolved, paid,
  every step authorized in the sign-off queue.
  | stage | tx | size | fee |
  |---|---|---|---|
  | deploy | `e7f46a7b…eaee6c` | 39.7 KB | 20,367 sat |
  | settle (2 signed fills → 1 tx) | `35da80d1…d1bd9b` | 79.6 KB | 40,788 sat |
  | resolve | `9a9e4130…10aa6f` | 80.0 KB | 40,956 sat |
  | payout | `b3fc3b49…0b700a` | 79.9 KB | 40,906 sat |
  Audit ok — 2 receipts, 0 violations, Rabin-attested. Payout outputs verified: pool continuation + OP_RETURN
  digest + **3,000 sat to `1B2a3Pv75wx1nxYKe9X8j2KopmN1Fn1wXv`** (the winner's own signing key) + change.
- **Cost prediction held: 143,017 sat actual vs 142,968 predicted — 0.03% out.** `measure:journey` is trustworthy
  for budgeting a mainnet run before spending anything.
- **The on-chain guard verified against live state, not a fixture.** Rehydrating the real mainnet pool UTXO
  (`b3fc3b49…:0`) from its locking script reads back `resolved=1, winner=1, paid=1` — the flag is genuinely on
  chain. Replaying the payout against that real UTXO is **rejected by the Script interpreter: `already paid`**.
  That is the exact transaction shape that SUCCEEDED on 2026-08-06 (`9a1879b2…`, block 961150). The fix is
  consensus-enforced, not a daemon policy, and it is now demonstrable from the chain by anyone.
- Wallet: 298,319 → ~155k sat. Both mainnet runs together cost ~275k sat in fees, all of it contract size.
- What this establishes, plainly: a person with a browser wallet can trade a native on-chain LMSR market on BSV,
  have their fills settle in one transaction, see the settlement audited against what they signed, and be paid
  to the key they traded with — with an operator who cannot pay them twice even by mistake.

## ADR-037 · A transaction log you can actually verify with (MAINNET-006) · Accepted · 2026-08-07
- Context: after the first live run the operator console reported `broadcast b3fc3b49dc369fbfe67b…` — truncated,
  unselectable, unlinked. The very first thing anyone does after spending real money is look the transaction up,
  and that string cannot be pasted into a block explorer. Reconstructing the run's txids afterwards meant
  querying the funding address's history. The evidence existed; it just was not reachable.
- Decision: make every broadcast independently verifiable from the UI and the terminal.
  - **`TxLog`** — a panel listing every broadcast transaction with the **full txid**, a one-click **copy**, a
    direct **WhatsOnChain link**, plus size, fee, summary and time, and a running total of bytes and fees. On a
    `local` run it says the transactions were built and Script-verified but never broadcast, and offers no link,
    rather than pointing at a 404 and implying they went to chain.
  - **Daemon console** prints the full txid and explorer URL on every successful broadcast, so a terminal-only
    operator has the same reach.
  - **Migration 013** persists `size_bytes`/`fee_sats` on `broadcasts`. They were previously only in the
    authorize *response*, so a page reload lost them and a completed run could not be costed after the fact.
- Note the honest asymmetry kept in the UI: on `local` the recorded fee is the local provider's rate (~1 sat/KB),
  not mainnet's 500 sat/KB. The log records what the transaction actually paid; `measure:journey` is the tool
  that projects mainnet cost.
- Verified: migration applies (13 at startup), a full local journey records size/fee for all four stages and
  returns them from `GET /broadcasts`, and the console prints full txids. 120 tests green, typecheck + build clean.
- Existing rows from the 2026-08-07 mainnet run predate the migration, so they show `—` for size/fee; their
  txids and explorer links work.

## ADR-038 · We were paying 5× the miner minimum (MAINNET-007) · Accepted · 2026-08-07
- Context: the engine's fee rate was hardcoded at **500 sat/KB**. The user flagged it should be 100. They were
  right, and it is the largest single cost error in the project.
- **Evidence.** Both TAAL and GorillaPool publish the same policy at ARC `/v1/policy` (verified 2026-08-07):
  `miningFee: { bytes: 1000, satoshis: 100 }` — **100 sat/KB**. Nothing required 500.
- **How the mistake happened, because the shape is worth remembering.** The original symptom was real: sCrypt
  takes its fee from `provider.getFeePerKb()`, and WhatsOnChain's default (~50 sat/KB) sits *below* the miner
  minimum, so those transactions were deprioritised and sat unconfirmed 40+ minutes. The diagnosis was right and
  the remedy overshot — the fix for "below policy" is "at policy", not "5× policy". No measurement was taken
  against what miners actually publish; a round number was picked that made the symptom go away. It then went
  unquestioned through two mainnet runs.
- Decision: default **100 sat/KB**, overridable with `PM_FEE_PER_KB` (validated: positive finite number, or the
  daemon refuses to start). It is miner policy, not consensus, so it belongs in configuration — if miners raise
  their minimum or a transaction sits, raise the number instead of editing code. The daemon prints the active
  rate at startup and `measure:journey` reads the same variable, so the projection cannot drift from the engine.
- **Measured effect — same bytes, same journey:**
  | stage | size | at 500 sat/KB | at 100 sat/KB |
  |---|---|---|---|
  | deploy | 39.7 KB | 20,350 sat | **4,071 sat** |
  | settle | 79.6 KB | 40,772 sat | **8,155 sat** |
  | resolve | 80.0 KB | 40,940 sat | **8,188 sat** |
  | payout | 79.9 KB | 40,908 sat | **8,182 sat** |
  | **total** | 279.2 KB | 142,969 sat | **28,596 sat** |
  **An 80% reduction — 114,373 sat saved per market lifecycle.** The two mainnet runs (ADR-034/036) were billed
  at the old rate; their transaction *sizes* remain the durable measurement, their fees were 5× necessary.
- Related correction in the same pass: `VERDICT.md`'s "ancestor budget" bullet claimed a 4-tx lifecycle must be
  split across confirmations. ADR-036 measured a 3-deep 183.5 KB chain confirming in one block. Both the fee
  figure and the ancestor claim were assumptions that survived because nobody measured them against the network.
- Verified: 120 tests green, typecheck + build clean; a full local journey at the new default reports
  **28,596 sat**; the daemon banner shows `fee 100 sat/KB`.

## ADR-039 · Node 22 is now a hard floor (FUND-001 prerequisite) · Accepted · 2026-08-07
- Context: FUND-001 (the trader funding leg) adopts `@bsv/wallet-toolbox` server-side for BRC-29 payment
  handling and `internalizeAction`. The toolbox declares `engines: { node: ">=22" }`; this repo declared `>=20`
  and was running v20.19.5.
- **The engine field is not advisory here — measured before deciding.** Installing the toolbox on Node 20 and
  loading its storage driver **segfaults the process: exit code 139**. `better-sqlite3@13` ships a native binary
  built for the Node 22 ABI, and the failure is a hard crash, not a catchable error. There is no working around
  it on Node 20 short of abandoning SQLite storage.
- Decision: **Node ≥22** (`.nvmrc` pins 22.23.0, root `engines.node` = `>=22`, `CLAUDE.md` §Stack records why).
  Taken as its own change, before any funding code, so that a toolchain bump and a feature change never land
  entangled.
- **Verified green on 22.23.0 across the whole toolchain**, not just the tests: 120 workspace tests, typecheck
  (8 projects incl. `apps/web`), **42 sCrypt contract tests against the real Script interpreter**, `scrypt-cli
  compile`, and the production web build. Then the toolbox itself: `better-sqlite3` loads and runs,
  `Setup.createWalletSQLite`, `Wallet.internalizeAction`, `Wallet.createAction`, `Monitor` and `Services` all
  resolve.
- **Operational trap, recorded because it cost a full red test run:** native modules are compiled per ABI, so
  switching Node silently leaves stale binaries — the suite failed **45 tests** until `pnpm rebuild -r`. That
  command is now part of the documented Node-switch procedure.
- Also established while de-risking, and worth keeping: **BRC-29 derivation needs none of this.** A full
  round-trip (payer derives the recipient's one-time public key with `protocolID [2,'3241645161d8']`,
  `keyID = "<prefix> <suffix>"`, counterparty = recipient identity key; recipient derives the matching private
  key) verified on Node **20** using only the repo's pinned `@bsv/sdk@2.1.9`. The toolbox is being adopted for
  UTXO/change management, the action lifecycle state machine and `Monitor` — not because the cryptography
  requires it. If the Node floor ever becomes a problem, that is the escape route.
