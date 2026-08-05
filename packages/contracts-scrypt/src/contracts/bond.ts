import {
    assert,
    ByteString,
    hash160,
    hash256,
    method,
    prop,
    PubKey,
    PubKeyHash,
    Sig,
    SmartContract,
    Utils,
} from 'scrypt-ts'
import { RabinPubKey, RabinSig, RabinVerifier } from 'scrypt-ts-lib'

/**
 * Bond (CONC-003b) — the operator's fraud-proof stake for the off-chain-execution / batched-settlement rollup
 * (ADR-019/022). The operator locks sats here; the bond is SLASHABLE by anyone who presents a compact
 * equivocation proof, and RECLAIMABLE by the operator only after a challenge window.
 *
 * `slash` proves EQUIVOCATION: two sequencer Rabin attestations for the SAME settlement `key`
 * (marketId ‖ toVersion) committing to DIFFERENT batch digests. The sequencer signs `key ‖ digest` per
 * settlement; two conflicting signatures over the same key mean it double-committed — a provable lie about which
 * settlement happened. The whole bond is paid to the challenger, making equivocation unprofitable. (This does
 * NOT by itself prove a single settlement's net equals its receipts arithmetically — that is the validity-proof
 * endgame; see ADR-023.)
 */
export class Bond extends SmartContract {
    @prop()
    readonly seqRabin: RabinPubKey
    @prop()
    readonly operator: PubKeyHash
    @prop()
    readonly matureAt: bigint

    constructor(seqRabin: RabinPubKey, operator: PubKeyHash, matureAt: bigint) {
        super(...arguments)
        this.seqRabin = seqRabin
        this.operator = operator
        this.matureAt = matureAt
    }

    /** Slash on equivocation: same settlement `key`, two valid sequencer signatures over DIFFERENT digests. */
    @method()
    public slash(
        key: ByteString,
        digestA: ByteString,
        sigA: RabinSig,
        digestB: ByteString,
        sigB: RabinSig,
        challenger: PubKeyHash
    ) {
        // Both messages are reconstructed as `key ‖ digest`, so they necessarily concern the SAME settlement.
        assert(RabinVerifier.verifySig(key + digestA, sigA, this.seqRabin), 'bad sig A')
        assert(RabinVerifier.verifySig(key + digestB, sigB, this.seqRabin), 'bad sig B')
        assert(digestA != digestB, 'not equivocation: identical digests')
        // The entire bond goes to the challenger (fee funded by the challenger's own input → change).
        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(challenger, this.ctx.utxo.value) + this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'bad outputs')
    }

    /** Operator reclaims the bond, but only after the challenge window (CLTV). Before then, anyone may slash. */
    @method()
    public withdraw(sig: Sig, pubkey: PubKey) {
        assert(this.timeLock(this.matureAt), 'bond not matured — challenge window still open')
        assert(hash160(pubkey) == this.operator, 'not the operator key')
        assert(this.checkSig(sig, pubkey), 'bad operator signature')
    }
}
