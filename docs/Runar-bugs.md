# Rúnar / runar-sdk bugs & workarounds

Issues found in the Rúnar toolchain (v0.4.6) while building this spike. Each: symptom, root cause,
workaround, status. Report upstream (repo `icellan/runar`) where useful.

---

## BUG-001 · `WhatsOnChainProvider.getUtxos()` returns UTXOs with an empty `.script` → invalid signatures
- **Package:** `runar-sdk@0.4.6` — `providers/woc.ts` `getUtxos()` (WhatsOnChain's `/unspent` endpoint doesn't
  include the locking script, and the provider doesn't backfill it).
- **Symptom:** broadcasting any `RunarContract.deploy()` / `.call()` tx to mainnet fails at script
  verification: `mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG)`
  (BIP146 NULLFAIL).
- **Root cause (CONFIRMED):** signing uses `utxo.script` as the BIP-143 **subscript/scriptCode**
  (`contract.ts` deploy line ~146 `signer.sign(hex, i, utxo.script, utxo.satoshis)`; same for funding inputs
  in `.call()`). Because `getUtxos()` returns `script: ''`, the sighash is computed over an **empty
  scriptCode** → the signature is valid for the wrong message → the node's CHECKSIG returns false → NULLFAIL.
  Proven with `@bsv/sdk`'s local `Spend` interpreter (`apps/spike/src/diag-oppushtx.ts`): with the empty
  script the funding input fails the clean-stack rule; supplying the correct P2PKH locking script → VALID.
- **Workaround (used here):** reconstruct the funding UTXO's locking script from the address —
  `new P2PKH().lock(priv.toAddress())` — and sign the funding input(s) with `@bsv/sdk`'s P2PKH template over
  the final tx (`apps/spike/src/mainnet.ts` `buy()`, `bsv-signer.ts`). For the deploy we build the whole tx
  with `@bsv/sdk` using the full source transaction, which sidesteps `getUtxos` entirely.
- **Status:** worked around. **Deploy + buy both live on mainnet**
  (deploy `ddbb0b36…c16dca88`, buy `7106f762…39ac2ed6`).

## BUG-002 (RETRACTED) · "OP_PUSH_TX spend rejected" — MISDIAGNOSIS
- Initially suspected the multi-method OP_PUSH_TX contract input. **Disproven:** the diagnostic shows the
  contract input's BIP-143 preimage is **byte-identical** to a spec-correct hand-built preimage (1700 B), the
  OP_PUSH_TX signature matches a fresh recomputation, and `@bsv/sdk` `Spend` validates the contract input as
  **VALID**. The spend failure was entirely BUG-001 (empty funding-input scriptCode). runar-sdk's OP_PUSH_TX
  path (`computeOpPushTx`, code-separator handling) is correct for this 5-method stateful contract.
- **Status:** not a bug. Kept for the record.

## BUG-003 (finding, not a toolchain bug) · sequential 0-conf trades need explicit UTXO chaining
- **Symptom:** a second buy immediately after the first fails with `258: txn-mempool-conflict`.
- **Cause:** rapid trades against the single hot pool UTXO must chain BOTH the pool UTXO (we track this in
  `data/pool.json`) AND the funding UTXO (use the previous trade's change output). `getUtxos()` lags the
  mempool and returned the already-spent change, so the new tx double-spent it.
- **Implication (feasibility unknown #2):** single-hot-UTXO serialization works, but a real client must chain
  funding outputs locally (or use a dedicated fee UTXO pool) rather than polling `getUtxos()` between trades.
- **Status:** expected 0-conf behaviour; documented as a design note, not fixed in the spike.

## BUG-004 · compiler only detects DIRECT `SmartContract`/`StatefulSmartContract` subclasses
- **Package:** `runar-compiler@0.4.6` — contract detection (Pass 1/2).
- **Symptom:** compiling a class that extends the provided `FungibleToken` base (`runar-lang/tokens`) fails
  with `No class extending SmartContract or StatefulSmartContract found`. `FungibleToken` itself extends
  `SmartContract`, so the subclass is two levels deep — the compiler apparently matches only the direct
  superclass name.
- **Impact:** the shipped `FungibleToken` / `NonFungibleToken` base contracts in `runar-lang/tokens` cannot
  be subclassed and compiled. They are usable as type/reference only.
- **Workaround (used here):** implement the token directly as a `StatefulSmartContract` (mutable `supply` +
  `holder`, readonly `marketId`/`side`; `transfer`/`split` via `addOutput`), following Rúnar's own
  multi-output token test pattern. See `packages/contracts/src/ShareToken.runar.ts`.
- **Status:** worked around. Recommend upstream: resolve the inheritance chain, or ship compilable token
  templates.

## BUG-005 · `prepareCall`/`call` don't build `addRawOutput` outputs (no multi-output / foreign-contract mint)
- **Package:** `runar-sdk@0.4.6` — `contract.ts` `prepareCall`/`call` + `anf-interpreter` output derivation.
- **Symptom:** a method that emits a second output via `addRawOutput` (e.g. `LMSRMarket.buyYes` minting a
  `ShareToken` to the buyer) is built by `prepareCall` with only `[pool continuation, change]` — the token
  output is **missing**. Verified offline (`apps/spike/src/diag-mint.ts`): `prepared.tx.outputs` = 2 (pool +
  change), no token. The contract's on-chain output-hash check enforces the token output, so such a tx would
  be rejected by the node.
- **Root cause:** the SDK only derives the single `addOutput` continuation (+ change) from a method; it does
  not simulate `addRawOutput` to include the constructed foreign output in the transaction.
- **Impact:** the token-minting buy (TOKEN-001b) and the multi-input redeem (TOKEN-001c) can't be built with
  the SDK. Demonstrating them on mainnet requires **hand-building the transactions** — constructing the exact
  output set (pool continuation + token) and the OP_PUSH_TX pool-input unlocking script manually, plus the
  multi-input redeem. That is a substantial standalone tx-engineering effort (the SDK's OP_PUSH_TX unlocking
  assembly would have to be replicated), not attempted in this spike.
- **Status:** OPEN — blocks the on-mainnet TOKEN-001d demo via the SDK. The full lifecycle is proven in the
  runar-testing VM (11 token tests). Recommend upstream: have `prepareCall`/`call` simulate `addRawOutput`
  and expose a way to supply extra outputs / multi-input contract spends.

## BUG-006 · Daemon buy path fails NULLFAIL on mainnet despite passing the VM (VM ≠ mainnet)
- **Package:** `runar-sdk@0.4.6` `prepareCall` (OP_PUSH_TX assembly) + our `@pm/engine` daemon path.
- **Context:** live run via `@pm/daemon` on mainnet (2026-08-04). The **deploy confirmed** on-chain
  (`9d7c370f6a891f63da7e7d2797fa4ad85bde72e8fe6d2a4f15e9d3b4a28b0a3c`, block 960831) — so the daemon's
  authorize→sign→broadcast→lineage path works. The **buy** (`buyYesPlain` via `prepareCall` + funding re-sign
  through the `ChainingProvider` overlay) was rejected by the node with:
  `mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)` (BIP146
  NULLFAIL) — a CHECKSIG returned false with a non-empty signature, i.e. a signature over the wrong sighash.
- **Reproduced with CONFIRMED funding** (not a 0-conf artefact): after the deploy confirmed and only the single
  change UTXO remained, the buy still NULLFAILed. Yet all 72 VM tests pass, and the analogous **old** buy
  (`buyYes`, 2-arg, direct `mainnet.ts` path) succeeded live earlier (`7106f762…`).
- **Root cause: NOT isolated.** WhatsOnChain aggressively **429-rate-limited** repeated broadcasts, which
  blocked interactive diagnosis. Candidates: (a) `buyYesPlain`'s OP_PUSH_TX continuation-script/hashOutputs
  differing from what the node computes; (b) the funding re-sign amount/subscript under the overlay; (c) the
  `ChainingProvider` overlay perturbing `prepareCall`'s tx assembly. The key point stands regardless: **VM
  acceptance does not guarantee mainnet OP_PUSH_TX validity** for a new/edited Rúnar method.
- **Also observed live:** BUG-003 reproduced end-to-end — WhatsOnChain reports the just-spent confirmed funding
  UTXO as still-unspent, so a fresh trade's funding selection double-spends it (`txn-mempool-conflict`). Our
  `ChainingProvider` overlay (a client-side workaround: hides spent inputs, exposes 0-conf change, seeds from
  the pool's parent tx) got past this; and WhatsOnChain as the sole broadcast path is fragile under load (429s).
- **Status:** OPEN. The daemon deploy path is mainnet-proven; the daemon buy/sell/resolve paths are **not yet
  mainnet-verified**. This fragility (VM≠mainnet + toolchain/broadcast friction) is the core motivation for the
  Rúnar→sCrypt migration (Phase 2): sCrypt provides battle-tested OP_PUSH_TX/tx assembly and a robust provider
  stack, which should make these paths verifiable on-chain.
