# Rúnar — Bug Report (v0.4.6)

**To:** the Rúnar maintainers (`icellan/runar`)
**Context:** found while building and deploying a non-trivial stateful financial contract (a stateful UTXO
market maker with multiple spending paths and a fungible token) to **BSV mainnet**. Overall Rúnar performed
well — it compiled the contract to valid, miner-accepted Bitcoin Script, and the `runar-testing` VM correctly
validated all contract logic. The three issues below are in the **SDK transaction-building** and **compiler
contract-detection**, not in the language/VM semantics. Two of them (BUG-1, BUG-2) currently block on-chain
use of the SDK for anything beyond the simplest case.

Each bug is self-contained and can be filed as a separate issue. All reproduction code uses only the public
package APIs and throwaway example contracts.

### Environment
| | |
|---|---|
| `runar-lang` / `runar-compiler` / `runar-sdk` / `runar-testing` | **0.4.6** |
| `@bsv/sdk` (SDK's signing dependency) | 2.1.9 |
| Node.js | v20.19.5 |
| OS | macOS (darwin 24.6) |
| Network | BSV **mainnet** (via `WhatsOnChainProvider`) |

### Summary
| # | Severity | Component | One-line |
|---|---|---|---|
| BUG-1 | **High** | `runar-sdk` provider/signer | `WhatsOnChainProvider.getUtxos()` returns an empty locking script, so every SDK-signed input gets the wrong BIP-143 sighash and the node rejects the tx. |
| BUG-2 | **High** | `runar-sdk` `prepareCall`/`call` | Transactions built by the SDK omit any `addRawOutput` output, so multi-output / token-minting / multi-input contracts can't be transacted. |
| BUG-3 | Medium | `runar-compiler` detection | A subclass of the shipped `FungibleToken`/`NonFungibleToken` base contracts fails to compile ("No class extending SmartContract…"). |

---

## BUG-1 — `WhatsOnChainProvider.getUtxos()` returns an empty `.script` ⇒ invalid signatures on mainnet

**Severity:** High — blocks *every* `RunarContract.deploy()` / `.call()` that funds a transaction, on mainnet.

### Symptom
Broadcasting any deploy/call to mainnet fails at script verification:

```
mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)
```

(BIP146 NULLFAIL — a CHECKSIG returned `false` with a non-empty signature.) The public-key hash in the
unlocking script is correct (the input's `OP_EQUALVERIFY` passes), but the **signature is over the wrong
sighash**, so `OP_CHECKSIG` fails.

### Root cause
`WhatsOnChainProvider.getUtxos()` returns UTXOs whose `script` field is an **empty string** — WhatsOnChain's
unspent-outputs endpoint does not include the locking script, and the provider does not backfill it. The
signing path then uses that empty string as the BIP-143 **scriptCode/subscript**:

- in `runar-sdk` `contract.ts`, both `deploy()` and the funding-input path of `.call()` sign with
  `signer.sign(unsignedHex, i, utxo.script, utxo.satoshis)` — i.e. `utxo.script` **is** the subscript;
- `LocalSigner.sign()` (`signers/local.ts`) computes the BIP-143 preimage with that (empty) subscript.

An empty scriptCode produces a different sighash than the node computes (which uses the real P2PKH script),
so the signature is invalid.

### Minimal reproduction (read-only — no funds needed)
```ts
import { WhatsOnChainProvider } from 'runar-sdk';

const provider = new WhatsOnChainProvider('mainnet');
const utxos = await provider.getUtxos('1DpDhuNAP3Cdga1GWM37WugVZ3h1edGQ72'); // any funded address
console.log(utxos.length, JSON.stringify(utxos[0].script));
// → 1 ""     ← the locking script is empty
```

Full end-to-end (needs a funded mainnet address) — any contract triggers it:
```ts
import { compile } from 'runar-compiler';
import { RunarContract, WhatsOnChainProvider, LocalSigner } from 'runar-sdk';

const src = `
import { StatefulSmartContract } from 'runar-lang';
class Counter extends StatefulSmartContract {
  count: bigint;
  constructor(count: bigint) { super(count); this.count = count; }
  public increment() { this.count++; }
}`;
const artifact = compile(src, { fileName: 'Counter.runar.ts' }).artifact!;

const contract = new RunarContract(artifact, [0n]);
await contract.deploy(new WhatsOnChainProvider('mainnet'), new LocalSigner('<funded WIF>'), { satoshis: 1000 });
// → WoC broadcast rejected: mandatory-script-verify-flag-failed (NULLFAIL)
```

### Expected vs actual
- **Expected:** `getUtxos()` returns each UTXO's real locking script, and the signed tx is accepted.
- **Actual:** `script` is `""`, the sighash subscript is empty, the signature is invalid, the node rejects it.

### Suggested fix
In `WhatsOnChainProvider.getUtxos()`, populate each UTXO's `script`. For a queried address the locking script
is a standard P2PKH and can be reconstructed directly from the address (no extra network call), e.g. build
`OP_DUP OP_HASH160 <hash160(address)> OP_EQUALVERIFY OP_CHECKSIG`. (More generally, backfill from the source
output.) Once `utxo.script` is correct, `LocalSigner`'s sighash is correct.

### Client-side workaround (what we used)
Reconstruct the P2PKH locking script from the address and sign the funding input with `@bsv/sdk`'s P2PKH
template over the final transaction:
```ts
import { P2PKH, Script, Transaction } from '@bsv/sdk';
const lock = new P2PKH().lock(privKey.toAddress());            // the real subscript
const unlock = await new P2PKH().unlock(privKey, 'all', false, utxo.satoshis, lock).sign(tx, inputIndex);
tx.inputs[inputIndex].unlockingScript = unlock;
```
(For a pure funding transaction we build the whole tx with `@bsv/sdk` using the full source transaction, which
sidesteps `getUtxos` entirely.)

---

## BUG-2 — `prepareCall` / `call` don't build `addRawOutput` outputs (no multi-output / multi-input tx)

**Severity:** High — blocks any contract whose spending path emits more than one output via `addRawOutput`
(token minting, escrow payouts, atomic swaps, fan-out), and any multi-input contract spend.

### Symptom
A public method that calls `this.addRawOutput(...)` (in addition to the state continuation) compiles fine and
executes correctly in the `runar-testing` VM, but when the transaction is built with the SDK, **the
`addRawOutput` output is missing** from `prepared.tx.outputs`. Since the compiled contract enforces its full
output set via `hashOutputs`/`OP_PUSH_TX`, such a transaction is rejected by the node.

### Root cause
`prepareCall()`/`call()` (`runar-sdk` `contract.ts`) derive only the **single `addOutput` continuation** (plus
a change output). They do not simulate `addRawOutput` (nor multiple `addOutput` calls beyond the primary
continuation), so the extra output the contract constructs on-chain is never placed in the transaction.

### Minimal reproduction (offline, MockProvider — no funds needed)
```ts
import { compile } from 'runar-compiler';
import { RunarContract, MockProvider, LocalSigner, buildP2PKHScript } from 'runar-sdk';

const src = `
import { StatefulSmartContract } from 'runar-lang';
import type { ByteString } from 'runar-lang';
class Emitter extends StatefulSmartContract {
  count: bigint;
  readonly extra: ByteString;
  constructor(count: bigint, extra: ByteString) { super(count, extra); this.count = count; this.extra = extra; }
  public tick(contSats: bigint, extraSats: bigint) {
    this.addOutput(contSats, this.count + 1n);   // state continuation
    this.addRawOutput(extraSats, this.extra);    // a second, arbitrary output
  }
}`;
const art = compile(src, { fileName: 'Emitter.runar.ts' }).artifact!;   // compiles fine
const extra = '76a914' + 'ab'.repeat(20) + '88ac';
const lockingScript = new RunarContract(art, [0n, extra]).getLockingScript();

const provider = new MockProvider('mainnet');
const signer = new LocalSigner('01'.repeat(32)); // any 64-hex-char private key
const addr = await signer.getAddress();
provider.addUtxo(addr, { txid: 'ff'.repeat(32), outputIndex: 0, satoshis: 100_000_000, script: buildP2PKHScript(addr) });

const c = RunarContract.fromUtxo(art, { txid: 'aa'.repeat(32), outputIndex: 0, satoshis: 5000, script: lockingScript });
c.connect(provider, signer);
const prepared = await c.prepareCall('tick', [2000n, 1000n], { newState: { count: 1n, extra }, satoshis: 2000 });

console.log('outputs:', prepared.tx.outputs.length);   // → 2  (continuation + change)
// EXPECTED: 3 — continuation + the addRawOutput output + change. The addRawOutput output is missing.
```

### Expected vs actual
- **Expected:** the built transaction contains the `addRawOutput` output (and supports multiple `addOutput`
  outputs and multi-input contract spends), matching what the contract enforces on-chain.
- **Actual:** only the single continuation + change are built; the `addRawOutput` output is dropped.

### Suggested fix
Simulate the method's full output list when building the transaction. The `anf-interpreter` already computes
the new state; extending it to collect **all** `addOutput`/`addRawOutput` outputs (in order) and placing them
in the tx before computing the `OP_PUSH_TX` signature would cover this. Additionally, exposing an API to
supply extra raw outputs and to build **multi-input** contract spends (e.g. burning one contract's UTXO while
spending another's) would make token/settlement patterns feasible.

### Client-side workaround
Hand-build the transaction: construct the exact output set yourself, compute the `OP_PUSH_TX` preimage +
signature (`computeOpPushTx` is exported and correct), and assemble the unlocking script. This is substantial
and re-implements a chunk of the SDK, so an upstream fix is strongly preferable.

---

## BUG-3 — subclasses of the shipped `FungibleToken` / `NonFungibleToken` bases don't compile

**Severity:** Medium — the provided token base contracts in `runar-lang/tokens` can't be extended, so they're
usable as reference/types only.

### Symptom
A class that extends `FungibleToken` (or `NonFungibleToken`) fails to compile:
```
error: No class extending SmartContract or StatefulSmartContract found
```

### Root cause
The compiler's contract-detection pass appears to match only classes whose **direct** superclass is
`SmartContract` or `StatefulSmartContract`. `FungibleToken` extends `SmartContract`, so a subclass of
`FungibleToken` is two levels down the chain and isn't recognised as a contract.

### Minimal reproduction
```ts
import { compile } from 'runar-compiler';

const src = `
import { FungibleToken } from 'runar-lang/tokens';
import type { PubKey } from 'runar-lang';
class MyToken extends FungibleToken {
  constructor(supply: bigint, holder: PubKey) { super(supply, holder); }
}`;
const r = compile(src, { fileName: 'MyToken.runar.ts' });
console.log(r.success, r.diagnostics.map(d => d.message));
// → false  [ 'No class extending SmartContract or StatefulSmartContract found' ]
```

### Expected vs actual
- **Expected:** a subclass of `FungibleToken`/`NonFungibleToken` is recognised and compiles (that's the point
  of shipping them as base contracts).
- **Actual:** not detected; compilation fails.

### Suggested fix
Resolve the `extends` chain when detecting contract classes (walk up to `SmartContract`/`StatefulSmartContract`
transitively), **or** — if base contracts are intentionally not subclassable — document that token contracts
must be written as direct `StatefulSmartContract` subclasses and ship a compilable token template.

### Client-side workaround
Write the token as a direct `StatefulSmartContract` (mutable `supply`/`holder`, `transfer`/`split`/`burn` via
`addOutput`), following the pattern in the SDK's own multi-output token test.

---

## Closing note

None of these are language/VM defects — the contract compiled to correct Script and behaved correctly under
`runar-testing`. They're gaps in the off-chain tooling (provider script backfill, SDK output simulation,
compiler subclass detection). Fixing BUG-1 and BUG-2 would unblock real on-chain use of the SDK for
non-trivial stateful contracts (which is exactly what we were able to prove works at the Script level). Happy
to provide any further detail or test against a fix.
