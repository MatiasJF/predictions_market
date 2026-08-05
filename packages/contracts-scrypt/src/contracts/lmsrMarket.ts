import {
    assert,
    ByteString,
    method,
    prop,
    SmartContract,
    hash256,
    int2ByteString,
    Utils,
    PubKeyHash,
} from 'scrypt-ts'
import { RabinPubKey, RabinSig, RabinVerifier } from 'scrypt-ts-lib'

/**
 * LMSRMarket (sCrypt port — Phase 2, SLIMMED per CONC-004). Native on-chain LMSR pool, mirroring the @pm/lmsr
 * integer reference. On-chain-only ops (bigint mul/div — no exp/ln): multiplicative state (ADR-007) +
 * post-trade-price MM-safe charge (ADR-011).
 *
 * SLIMMING (CONC-004, ADR-020): the whole compiled script is re-carried by OP_PUSH_TX on every spend, so its
 * size sets the per-spend footprint (~93 KB before). The nine YES/NO twin methods
 * (buyYes/buyNo/sellYes/sellNo/buyYesWithToken/buyNoWithToken/redeemYes/redeemNo + resolve) are collapsed to
 * FOUR side-parameterized methods — buy/sell/resolve/redeem — with a `isYes` flag. Measured: locking script
 * 45.7 KB → 21.5 KB (−53%), per-spend ~93 KB → ~44 KB. Pricing is unchanged (verified by the @pm/lmsr
 * equivalence vectors). Every buy now mints its position token (the state-only buy path was a spike artifact).
 *
 * State (mutable): eYes, eNo, qYes, qNo, collateral, resolved (0/1), winner (0=NO,1=YES).
 * Constants: mult = exp(unit/b)·scale, invMult = exp(−unit/b)·scale, payoutUnit, scale (WAD), unit, oracle
 * Rabin modulus, marketTag (binds the oracle sig to this market).
 */
export class LMSRMarket extends SmartContract {
    // CONC-002: max unit moves per side a single batch settlement may apply (bounds the settle() loops).
    static readonly MAX_BATCH = 20n

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

    /**
     * BUY one unit of `isYes ? YES : NO` and mint a claim ticket to the buyer in the SAME tx (multi-output).
     * Emits: pool continuation + a P2PKH "token" UTXO to the buyer (`tokenSats`, a dust claim ticket) + change.
     * The multiplicative update (ADR-007) advances the bought side's stored exponential; the MM-safe charge
     * (ADR-011) is the post-trade price rounded UP: ceil(newE·payoutUnit / (eYes+eNo)).
     */
    @method()
    public buy(isYes: boolean, paymentSats: bigint, buyer: PubKeyHash, tokenSats: bigint) {
        assert(this.resolved == 0n, 'resolved')
        let e = isYes ? this.eYes : this.eNo
        e = (e * this.mult) / this.scale
        if (isYes) {
            this.eYes = e
            this.qYes += this.unit
        } else {
            this.eNo = e
            this.qNo += this.unit
        }
        const sum = this.eYes + this.eNo
        const charge = (e * this.payoutUnit + sum - 1n) / sum
        assert(paymentSats >= charge, 'underpaid')
        this.collateral += paymentSats
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) +
            Utils.buildPublicKeyHashOutput(buyer, tokenSats) +
            this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    /**
     * SELL one unit of `isYes ? YES : NO` back to the pool (state-only continuation). Inverse multiplicative
     * update; the proceeds are the post-trade price rounded DOWN: floor(newE·payoutUnit / (eYes+eNo)).
     */
    @method()
    public sell(isYes: boolean) {
        assert(this.resolved == 0n, 'resolved')
        let e = 0n
        if (isYes) {
            assert(this.qYes >= this.unit, 'no YES outstanding')
            e = (this.eYes * this.invMult) / this.scale
            this.eYes = e
            this.qYes -= this.unit
        } else {
            assert(this.qNo >= this.unit, 'no NO outstanding')
            e = (this.eNo * this.invMult) / this.scale
            this.eNo = e
            this.qNo -= this.unit
        }
        const sum = this.eYes + this.eNo
        const proceeds = (e * this.payoutUnit) / sum
        assert(this.collateral >= proceeds, 'insolvent')
        this.collateral -= proceeds
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    /**
     * BATCH SETTLEMENT (CONC-002, net-state MVP). Advances the pool by a whole batch of off-chain fills in ONE
     * pool-version tx. Because `eYes = exp(qYes/b)` depends only on NET `qYes`, the batch's effect is
     * `eYes *= mult^(net YES unit delta)` (or `invMult^…` if net-negative) — computed as |net| repeated
     * multiplicative moves (bounded by MAX_BATCH). The off-chain sequencer computes the identical net move, so
     * the settled state matches by construction. `collateralDelta` is the batch's net cash; the MVP verifies the
     * state transition + solvency, not the exact per-fill cash (that is the CONC-003 fraud/validity layer).
     * Position tokens stay as the signed off-chain receipts in this MVP (no per-participant mint here).
     */
    @method()
    public settle(
        netYesUnits: bigint,
        netYesIsBuy: boolean,
        netNoUnits: bigint,
        netNoIsBuy: boolean,
        collateralDelta: bigint,
        collateralIsUp: boolean
    ) {
        assert(this.resolved == 0n, 'resolved')
        assert(netYesUnits >= 0n && netYesUnits <= LMSRMarket.MAX_BATCH, 'yes batch out of range')
        assert(netNoUnits >= 0n && netNoUnits <= LMSRMarket.MAX_BATCH, 'no batch out of range')

        // Net YES move: multiply eYes by mult (net buys) or invMult (net sells), |net| times. Bounded loop with
        // early exit — path-independent end state, identical to the sequencer's net computation.
        for (let i = 0n; i < LMSRMarket.MAX_BATCH; i++) {
            if (i < netYesUnits) {
                this.eYes = (this.eYes * (netYesIsBuy ? this.mult : this.invMult)) / this.scale
            }
        }
        this.qYes = netYesIsBuy
            ? this.qYes + netYesUnits * this.unit
            : this.qYes - netYesUnits * this.unit

        for (let i = 0n; i < LMSRMarket.MAX_BATCH; i++) {
            if (i < netNoUnits) {
                this.eNo = (this.eNo * (netNoIsBuy ? this.mult : this.invMult)) / this.scale
            }
        }
        this.qNo = netNoIsBuy
            ? this.qNo + netNoUnits * this.unit
            : this.qNo - netNoUnits * this.unit

        this.collateral = collateralIsUp
            ? this.collateral + collateralDelta
            : this.collateral - collateralDelta
        assert(this.collateral >= 0n, 'insolvent')

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

    /**
     * REDEEM a winning `isYes ? YES : NO` position (multi-output). Requires the market resolved with the winning
     * side matching `isYes`. Pays the winner `supply × payoutUnit` sats via a P2PKH payout output, reduces the
     * pool collateral, and continues the pool. Documented-trust (spike): the pool trusts the supplied
     * supply/side; production needs SPV/pushdata verification of a co-spent token (see VERDICT).
     */
    @method()
    public redeem(isYes: boolean, supply: bigint, winner: PubKeyHash) {
        assert(this.resolved == 1n, 'not resolved')
        assert(this.winner == (isYes ? 1n : 0n), 'wrong side')
        assert(supply > 0n, 'no shares')
        const payout = supply * this.payoutUnit
        assert(this.collateral >= payout, 'insolvent')
        this.collateral -= payout
        const outputs: ByteString =
            this.buildStateOutput(this.ctx.utxo.value) +
            Utils.buildPublicKeyHashOutput(winner, payout) +
            this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }
}
