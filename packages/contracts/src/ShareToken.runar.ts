import { StatefulSmartContract, assert, checkSig } from 'runar-lang';
import type { PubKey, Sig } from 'runar-lang';

/**
 * ShareToken (TOKEN-001a) — a YES or NO position in one LMSR market, as a fungible token UTXO.
 *
 * NB: the compiler only recognises DIRECT `SmartContract`/`StatefulSmartContract` subclasses, so we cannot
 * extend Rúnar's provided `FungibleToken` base (see docs/Runar-bugs.md BUG-004). We implement the fungible
 * token directly, following Rúnar's own multi-output token pattern.
 *
 * State (mutable): `supply` (shares in this UTXO), `holder` (owner pubkey) — both change under transfer/split.
 * Readonly: `marketId` (which market these shares belong to), `side` (1 = YES, 0 = NO). These bind the token
 * so the pool can recognise a winning token at settlement (TOKEN-001c).
 */
export class ShareToken extends StatefulSmartContract {
  supply: bigint;
  holder: PubKey;
  readonly marketId: bigint;
  readonly side: bigint;

  constructor(supply: bigint, holder: PubKey, marketId: bigint, side: bigint) {
    super(supply, holder, marketId, side);
    this.supply = supply;
    this.holder = holder;
    this.marketId = marketId;
    this.side = side;
  }

  /** Transfer the whole balance to a new holder. */
  public transfer(sig: Sig, newHolder: PubKey, outputSatoshis: bigint) {
    assert(checkSig(sig, this.holder));
    this.addOutput(outputSatoshis, this.supply, newHolder);
  }

  /** Split: `amount` shares go to `newHolder`, the remainder stays with the current holder. */
  public split(sig: Sig, amount: bigint, newHolder: PubKey, outputSatoshis: bigint) {
    assert(checkSig(sig, this.holder));
    assert(amount > 0n);
    assert(amount < this.supply);
    this.addOutput(outputSatoshis, amount, newHolder);
    this.addOutput(outputSatoshis, this.supply - amount, this.holder);
  }

  /** Burn: the holder consumes the token (no successor output). Used when redeeming a winning share. */
  public burn(sig: Sig) {
    assert(checkSig(sig, this.holder));
  }
}
