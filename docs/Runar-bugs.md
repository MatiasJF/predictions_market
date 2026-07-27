# Rúnar / runar-sdk bugs & workarounds

Issues found in the Rúnar toolchain (v0.4.6) while building this spike. Log each with: symptom, root
cause (if known), workaround, and status. Report upstream (repo `icellan/runar`) where useful.

---

## BUG-001 · runar-sdk `LocalSigner` produces an invalid BSV signature (mainnet rejects the spend)
- **Package:** `runar-sdk@0.4.6` — `signers/local.ts` `LocalSigner.sign()`.
- **Symptom:** broadcasting a `RunarContract.deploy()` / `.call()` tx to mainnet fails at script verification:
  `mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)`
  (BIP146 NULLFAIL). The pubkey-hash matches (EQUALVERIFY passes) but CHECKSIG returns false → the P2PKH
  funding input's signature is wrong.
- **Root cause (likely):** `LocalSigner.sign` hand-rolls the BIP-143 sighash with
  `TransactionSignature.format(...)` then `privKey.sign(sha256(preimage))` + raw `signature.toDER('hex')`.
  `@bsv/sdk`'s own P2PKH template instead uses its internal `formatPreimage(...)` +
  `new TransactionSignature(r,s,scope).toChecksigFormat()`. The two disagree — either the preimage format
  differs or the DER encoding isn't low-S normalized — yielding a signature BSV nodes reject.
- **Workaround (used here):** don't use `LocalSigner`. Sign with `@bsv/sdk`'s P2PKH template directly.
  For the deploy we build the funding tx entirely with `@bsv/sdk` (`apps/spike/src/mainnet.ts`). For method
  calls we pass `RunarContract` a custom `Signer` (`apps/spike/src/bsv-signer.ts`) that delegates P2PKH
  signing to `new P2PKH().unlock(priv, 'all', false, satoshis, subscript)` and returns the sig chunk.
- **Status:** worked around. Confirmed: `@bsv/sdk`-signed deploy accepted on mainnet
  (txid `ddbb0b368ac54716001ae9cc32fdabfb23548fed31ccb0b3d1232754c16dca88`).

---

## BUG-002 · OP_PUSH_TX spend of a multi-method stateful contract rejected on mainnet
- **Package:** `runar-sdk@0.4.6` — `oppushtx.ts` `computeOpPushTx()` / `contract.ts`
  `computeOpPushTxWithCodeSep()` + `buildStatefulUnlock`.
- **Symptom:** with BUG-001 worked around (funding input signed by `@bsv/sdk`), broadcasting a `.call('buyYes', …)`
  spend of the live pool UTXO still fails with the same `mandatory-script-verify-flag-failed (Signature must
  be zero for failed CHECK(MULTI)SIG)`. The deploy (funding-only, no contract input) succeeds; the buy adds a
  contract input spent via OP_PUSH_TX — so the failing input is the **contract input's OP_PUSH_TX signature**.
- **Diagnosis:** `computeOpPushTx` DOES enforce low-S and hashes like the working `@bsv/sdk` P2PKH path, so
  the bug is upstream of the signature: the BIP-143 **preimage/scriptCode** it signs doesn't match the sighash
  the node computes. Two suspects: (a) `TransactionSignature.format(...)` (public API) diverges from
  `@bsv/sdk`'s internal `formatPreimage(...)` used by the working template; (b) the wrong `codeSeparatorIndex`
  is selected for the buyYes dispatch branch (the LMSRMarket script has 5 methods, each with its own
  OP_CODESEPARATOR), giving a wrong `scriptCode`. The contract's buy logic itself is proven correct in the
  `runar-testing` interpreter (15 tests) — this is purely a mainnet tx-construction bug.
- **Workaround:** NOT YET done. Needs hand-building the OP_PUSH_TX unlocking script (correct BIP-143 preimage
  with the post-OP_CODESEPARATOR scriptCode for the chosen method, sig with privkey=1, low-S) via `@bsv/sdk`,
  replacing `computeOpPushTx`. Scoped for a follow-up.
- **Status:** OPEN. Deploy works on mainnet; the first SPEND (buy) is blocked pending this workaround or an
  upstream fix. Feasibility impact: the on-chain LMSR is deployable and its logic verified; live multi-trade
  throughput (#2) can't be measured on mainnet until the spend path works.
