import {
    SmartContract, assert, method, prop, ByteString, slice, byteString2Int, int2ByteString, len, hash256,
} from 'scrypt-ts'

/**
 * THROWAWAY SPIKE (PAYOUT-002 de-risk) — can sCrypt mark "winner i has been paid" at a RUNTIME index?
 *
 * The Distributor's anti-replay needs exactly this: flag `index` must be unset, then becomes set. Every `slice`
 * in `lmsrMarket.ts` uses CONSTANT offsets, so this repo has no precedent for a dynamic one. If it does not
 * verify against the real Script interpreter, the design needs a cursor or a split-range instead.
 *
 * WHY ONE BYTE PER WINNER, NOT A PACKED BITMAP. The first cut of this spike packed 8 flags per byte and failed
 * on the real interpreter: `int2ByteString(128n, 1n)` throws "128 cannot fit in 1 byte[s]", because Script
 * integers are SIGN-MAGNITUDE — one byte holds −127..127, not 0..255. A packed bitmap is therefore silently
 * broken at bits 7, 15, 23, … exactly the kind of defect that survives casual testing and strands real money.
 * One byte per winner keeps every value in {0,1}, well clear of the sign bit, and deletes the mask/shift
 * arithmetic entirely.
 *
 * It also removes the compile-time capacity cap: `claimed`'s LENGTH is data, not code, so it is sized per
 * market from the actual winner count — no `CAPACITY` constant, no sharding story, and a 20-winner market pays
 * for 20 bytes instead of a fixed 128. `%` is avoided throughout (ADR-025).
 *
 * Delete once the Distributor exists — this file answers one question.
 */
export class BitmapSpike extends SmartContract {
    /** One byte per winner: 0x00 = unclaimed, 0x01 = claimed. Length = number of winners. */
    @prop(true)
    claimed: ByteString

    constructor(claimed: ByteString) {
        super(...arguments)
        this.claimed = claimed
    }

    /** Assert flag `index` is unset, set it, and continue the contract — exactly what a claim must do. */
    @method()
    public setFlag(index: bigint) {
        assert(index >= 0n && index < len(this.claimed), 'index out of range')

        // Dynamic slice at a runtime offset — THE thing being de-risked.
        const before: ByteString = slice(this.claimed, 0n, index)
        const target: ByteString = slice(this.claimed, index, index + 1n)
        const after: ByteString = slice(this.claimed, index + 1n)

        assert(byteString2Int(target) == 0n, 'already claimed')
        this.claimed = before + int2ByteString(1n, 1n) + after

        const outputs: ByteString = this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }
}
