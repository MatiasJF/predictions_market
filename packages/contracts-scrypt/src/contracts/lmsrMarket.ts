import {
    assert,
    ByteString,
    method,
    prop,
    SmartContract,
    hash256,
    int2ByteString,
} from 'scrypt-ts'
import { RabinPubKey, RabinSig, RabinVerifier } from 'scrypt-ts-lib'

/**
 * LMSRMarket (sCrypt port — Phase 2). Native on-chain LMSR pool, mirroring the Rúnar contract
 * (packages/contracts/src/LMSRMarket.runar.ts) and the @pm/lmsr integer reference. Same on-chain-only ops
 * (bigint mul/div — no exp/ln): multiplicative state (ADR-007) + post-trade-price MM-safe charge (ADR-011).
 *
 * State (mutable): eYes, eNo, qYes, qNo, collateral, resolved (0/1), winner (0=NO,1=YES).
 * Constants: mult = exp(unit/b)·scale, invMult = exp(−unit/b)·scale, payoutUnit, scale (WAD), unit, oracle
 * Rabin modulus, marketTag (binds the oracle sig to this market).
 *
 * This core file has buy/sell/resolve (state-only continuation). Token mint (multi-output) + redeem
 * (multi-input) — the runar-sdk BUG-005 unblock — build on sCrypt's native multi-output support next.
 */
export class LMSRMarket extends SmartContract {
    @prop(true)
    eYes: bigint
    @prop(true)
    eNo: bigint
    @prop(true)
    qYes: bigint
    @prop(true)
    qNo: bigint
    @prop(true)
    collateral: bigint
    @prop(true)
    resolved: bigint
    @prop(true)
    winner: bigint

    @prop()
    readonly mult: bigint
    @prop()
    readonly invMult: bigint
    @prop()
    readonly payoutUnit: bigint
    @prop()
    readonly scale: bigint
    @prop()
    readonly unit: bigint
    @prop()
    readonly oracleN: RabinPubKey
    @prop()
    readonly marketTag: ByteString

    constructor(
        eYes: bigint,
        eNo: bigint,
        qYes: bigint,
        qNo: bigint,
        collateral: bigint,
        resolved: bigint,
        winner: bigint,
        mult: bigint,
        invMult: bigint,
        payoutUnit: bigint,
        scale: bigint,
        unit: bigint,
        oracleN: RabinPubKey,
        marketTag: ByteString
    ) {
        super(...arguments)
        this.eYes = eYes
        this.eNo = eNo
        this.qYes = qYes
        this.qNo = qNo
        this.collateral = collateral
        this.resolved = resolved
        this.winner = winner
        this.mult = mult
        this.invMult = invMult
        this.payoutUnit = payoutUnit
        this.scale = scale
        this.unit = unit
        this.oracleN = oracleN
        this.marketTag = marketTag
    }

    @method()
    public buyYes(paymentSats: bigint) {
        assert(this.resolved == 0n, 'resolved')
        this.eYes = (this.eYes * this.mult) / this.scale
        const sum = this.eYes + this.eNo
        // MM-safe post-trade price, rounded UP: ceil(newEYes·payoutUnit / sum)
        const charge = (this.eYes * this.payoutUnit + sum - 1n) / sum
        assert(paymentSats >= charge, 'underpaid')
        this.qYes += this.unit
        this.collateral += paymentSats
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    @method()
    public buyNo(paymentSats: bigint) {
        assert(this.resolved == 0n, 'resolved')
        this.eNo = (this.eNo * this.mult) / this.scale
        const sum = this.eYes + this.eNo
        const charge = (this.eNo * this.payoutUnit + sum - 1n) / sum
        assert(paymentSats >= charge, 'underpaid')
        this.qNo += this.unit
        this.collateral += paymentSats
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    @method()
    public sellYes() {
        assert(this.resolved == 0n, 'resolved')
        assert(this.qYes >= this.unit, 'no YES outstanding')
        this.eYes = (this.eYes * this.invMult) / this.scale
        const sum = this.eYes + this.eNo
        // MM-safe post-trade price, rounded DOWN: floor(newEYes·payoutUnit / sum)
        const proceeds = (this.eYes * this.payoutUnit) / sum
        assert(this.collateral >= proceeds, 'insolvent')
        this.qYes -= this.unit
        this.collateral -= proceeds
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    @method()
    public sellNo() {
        assert(this.resolved == 0n, 'resolved')
        assert(this.qNo >= this.unit, 'no NO outstanding')
        this.eNo = (this.eNo * this.invMult) / this.scale
        const sum = this.eYes + this.eNo
        const proceeds = (this.eNo * this.payoutUnit) / sum
        assert(this.collateral >= proceeds, 'insolvent')
        this.qNo -= this.unit
        this.collateral -= proceeds
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    /** Resolve on an oracle Rabin signature over `marketTag ‖ num2bin(outcome,1)` (outcome 1=YES, 0=NO). */
    @method()
    public resolve(sig: RabinSig, outcome: bigint) {
        assert(this.resolved == 0n, 'resolved')
        assert(outcome == 0n || outcome == 1n, 'bad outcome')
        const msg: ByteString = this.marketTag + int2ByteString(outcome, 1n)
        assert(RabinVerifier.verifySig(msg, sig, this.oracleN), 'bad oracle sig')
        this.resolved = 1n
        this.winner = outcome
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }
}
