import { SmartContract, assert, method, prop, ByteString, Utils, PubKeyHash, hash256, toByteString } from 'scrypt-ts'

/**
 * THROWAWAY SPIKE #2 (PAYOUT-002) — can ONE method emit TWO continuations of itself with DIFFERENT state?
 *
 * This is the load-bearing question for the "split-range" Distributor. A claim for index `i` against a UTXO
 * covering `[lo,hi)` should produce `[lo,i)` and `[i+1,hi)`, so the range forks into a tree and winners can
 * claim IN PARALLEL. The alternative (one UTXO carrying a claimed-flag per winner — spike #1, proven working)
 * is correct but strictly SERIAL: every claim spends the same UTXO, so N winners form an N-deep unconfirmed
 * chain and whoever sequences it is a de-facto operator. Parallelism is the whole point of self-service claims.
 *
 * The doubt: `buildStateOutput()` is a compiler builtin that serialises the CURRENT prop values, and sCrypt's
 * `next()` bookkeeping assumes a single continuation. Mutating props between two calls may or may not survive.
 * If it does not, the Distributor falls back to spike #1's flag array and we accept serial claims.
 *
 * Delete once the answer is recorded.
 */
export class SplitSpike extends SmartContract {
    @prop(true)
    lo: bigint
    @prop(true)
    hi: bigint

    constructor(lo: bigint, hi: bigint) {
        super(...arguments)
        this.lo = lo
        this.hi = hi
    }

    /**
     * Claim `index`, forking the range. Conditional continuations: a claim at either END emits only one, and
     * the last claim in a range emits none — so the common operator-sweep path costs no more than the serial
     * design, and only genuine out-of-order claims pay for the extra output.
     */
    @method()
    public claim(index: bigint, pkh: PubKeyHash, amount: bigint) {
        assert(index >= this.lo && index < this.hi, 'index not in this range')
        assert(amount > 0n, 'amount must be positive')

        const lo0: bigint = this.lo
        const hi0: bigint = this.hi

        let outs: ByteString = toByteString('')

        // Left continuation [lo, index) — only if non-empty.
        this.lo = lo0
        this.hi = index
        if (index > lo0) {
            outs += this.buildStateOutput(1n)
        }

        outs += Utils.buildPublicKeyHashOutput(pkh, amount)

        // Right continuation [index+1, hi) — only if non-empty.
        this.lo = index + 1n
        this.hi = hi0
        if (index + 1n < hi0) {
            outs += this.buildStateOutput(1n)
        }

        outs += this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outs), 'bad outputs')
    }
}
