import { StatefulSmartContract } from 'runar-lang';

/**
 * Minimal stateful contract — the CONTRACT-001 toolchain gate.
 *
 * Proves end-to-end, offline, that Rúnar can:
 *   1. compile a `StatefulSmartContract` to Bitcoin Script, and
 *   2. execute a state transition (count 0 → 1 → 2) via OP_PUSH_TX continuation.
 *
 * The compiler auto-injects the preimage check + state-continuation assert for the
 * mutable `count` property, so `increment()` needs no explicit output wiring.
 * If this gate cannot be made to pass, the ADR-002 fallback (scrypt-ts) is invoked.
 */
export class Counter extends StatefulSmartContract {
  count: bigint; // mutable → carried across transactions via OP_PUSH_TX

  constructor(count: bigint) {
    super(count);
    this.count = count;
  }

  public increment() {
    this.count++;
  }
}
