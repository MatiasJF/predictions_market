import {
    assert,
    method,
    prop,
    PubKey,
    Sig,
    SmartContract,
    hash256,
    ByteString,
} from 'scrypt-ts'

/**
 * ShareToken (sCrypt port). A YES/NO claim ticket for a market: mutable supply + holder, with the market id
 * and side baked in as compile-time constants (so the code prefix — the "token code" — is fixed per
 * (marketId, side) and the pool can recognise/mint it). Mirrors packages/contracts/src/ShareToken.runar.ts.
 *
 * `transfer` reassigns the holder (holder-authorised); `burn` consumes the token (holder-authorised) — used
 * when a winner redeems, co-spent with the pool's redeem in one tx (multi-input). Splitting into denominations
 * is a later refinement.
 */
export class ShareToken extends SmartContract {
    @prop(true)
    supply: bigint
    @prop(true)
    holder: PubKey

    @prop()
    readonly marketId: bigint
    @prop()
    readonly side: bigint

    constructor(supply: bigint, holder: PubKey, marketId: bigint, side: bigint) {
        super(...arguments)
        this.supply = supply
        this.holder = holder
        this.marketId = marketId
        this.side = side
    }

    /** Reassign ownership to `newHolder` (current holder authorises). Supply unchanged. */
    @method()
    public transfer(sig: Sig, newHolder: PubKey) {
        assert(this.checkSig(sig, this.holder), 'not holder')
        this.holder = newHolder
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    /**
     * Burn the token (holder authorises). No continuation output — the token UTXO is consumed. In a redeem it
     * is input #1 alongside the pool (input #0), whose `redeem` method enforces the winner payout. Ends with
     * the holder authorisation assert, as sCrypt requires.
     */
    @method()
    public burn(sig: Sig) {
        assert(this.checkSig(sig, this.holder), 'not holder')
    }
}
