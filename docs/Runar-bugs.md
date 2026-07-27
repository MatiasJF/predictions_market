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
