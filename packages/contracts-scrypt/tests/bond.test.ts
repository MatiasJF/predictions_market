import { expect } from 'chai'
import {
    bsv,
    ContractTransaction,
    findSig,
    MethodCallOptions,
    PubKey,
    PubKeyHash,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { Bond } from '../src/contracts/bond'
import { attest, isEquivocation, seqRabinPubKey } from '../src/attestation'
import { localSigner } from './utils/signer'

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    let threw = false
    try {
        await fn()
    } catch {
        threw = true
    }
    expect(threw, 'expected the call to be rejected').to.equal(true)
}

const MARKET = 991
const VERSION = 1
const OPERATOR = PubKeyHash(toByteString('11'.repeat(20)))
const CHALLENGER = PubKeyHash(toByteString('22'.repeat(20)))
const MATURE_AT = 800_000_000n // CLTV as a unix timestamp
const BOND_SATS = 2000

/** Terminal slash builder: spend the bond → pay the whole bond value to the challenger (+ change for the fee). */
function bindSlashBuilder(bond: Bond, challenger: PubKeyHash): void {
    bond.bindTxBuilder(
        'slash',
        async (current: Bond, options: MethodCallOptions<Bond>): Promise<ContractTransaction> => {
            const challengerScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(challenger))
            const unsignedTx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: challengerScript, satoshis: current.balance }))
            if (options.changeAddress) unsignedTx.change(options.changeAddress)
            return { tx: unsignedTx, atInputIndex: 0, nexts: [] }
        }
    )
}

describe('Bond (CONC-003b) — on-chain equivocation slash', () => {
    before(async () => {
        await Bond.loadArtifact()
    })

    it('slashes on a REAL equivocation proof (2 conflicting Rabin attestations) and pays the challenger', async () => {
        const bond = new Bond(seqRabinPubKey, OPERATOR, MATURE_AT)
        const signer = localSigner()
        await bond.connect(signer)
        await bond.deploy(BOND_SATS)

        // Same settlement key (market 991, version 1), two DIFFERENT committed digests ⇒ the sequencer equivocated.
        const attA = attest(MARKET, VERSION, 'ab'.repeat(32))
        const attB = attest(MARKET, VERSION, 'cd'.repeat(32))
        expect(attA.key).to.equal(attB.key)
        expect(isEquivocation(attA, attB)).to.equal(true)

        bindSlashBuilder(bond, CHALLENGER)
        const { tx } = await bond.methods.slash(
            attA.key,
            toByteString(attA.digest), attA.sig,
            toByteString(attB.digest), attB.sig,
            CHALLENGER,
            { changeAddress: await signer.getDefaultAddress() } as MethodCallOptions<Bond>
        )
        // Not rejected ⇒ both Rabin sigs verified on-chain + equivocation proven; challenger receives the bond.
        expect(tx.outputs.some((o) => o.satoshis === BOND_SATS), 'challenger paid the full bond').to.equal(true)
    })

    it('rejects a non-equivocation (two signatures over the SAME digest)', async () => {
        const bond = new Bond(seqRabinPubKey, OPERATOR, MATURE_AT)
        const signer = localSigner()
        await bond.connect(signer)
        await bond.deploy(BOND_SATS)

        const att = attest(MARKET, VERSION, 'ab'.repeat(32))
        bindSlashBuilder(bond, CHALLENGER)
        await expectReject(() =>
            bond.methods.slash(
                att.key,
                toByteString(att.digest), att.sig,
                toByteString(att.digest), att.sig, // identical digest ⇒ not equivocation
                CHALLENGER,
                { changeAddress: signer.getDefaultAddress() } as unknown as MethodCallOptions<Bond>
            )
        )
    })

    it('rejects a forged/mismatched Rabin signature', async () => {
        const bond = new Bond(seqRabinPubKey, OPERATOR, MATURE_AT)
        const signer = localSigner()
        await bond.connect(signer)
        await bond.deploy(BOND_SATS)

        const attA = attest(MARKET, VERSION, 'ab'.repeat(32))
        const attB = attest(MARKET, VERSION, 'cd'.repeat(32))
        bindSlashBuilder(bond, CHALLENGER)
        // sigB is attA's signature (valid over digestA, NOT over digestB) → verifySig(key‖digestB, attA.sig) fails.
        await expectReject(() =>
            bond.methods.slash(
                attA.key,
                toByteString(attA.digest), attA.sig,
                toByteString(attB.digest), attA.sig,
                CHALLENGER,
                { changeAddress: signer.getDefaultAddress() } as unknown as MethodCallOptions<Bond>
            )
        )
    })

    it('operator withdraw is CLTV-gated: rejected before maturity, allowed after', async () => {
        const signer = localSigner()
        const operatorPub = await signer.getDefaultPubKey()
        const operatorPKH = PubKeyHash(bsv.crypto.Hash.sha256ripemd160(operatorPub.toBuffer()).toString('hex'))

        // Rejected before the challenge window closes (tx locktime < matureAt ⇒ timeLock fails).
        const early = new Bond(seqRabinPubKey, operatorPKH, MATURE_AT)
        await early.connect(signer)
        await early.deploy(BOND_SATS)
        await expectReject(() =>
            early.methods.withdraw(
                (sigResps) => findSig(sigResps, operatorPub),
                PubKey(operatorPub.toHex()),
                { pubKeyOrAddrToSign: operatorPub, lockTime: 100, changeAddress: signer.getDefaultAddress() } as unknown as MethodCallOptions<Bond>
            )
        )

        // Allowed once matured (tx locktime ≥ matureAt) with the operator's signature.
        const matured = new Bond(seqRabinPubKey, operatorPKH, MATURE_AT)
        await matured.connect(signer)
        await matured.deploy(BOND_SATS)
        const { tx } = await matured.methods.withdraw(
            (sigResps) => findSig(sigResps, operatorPub),
            PubKey(operatorPub.toHex()),
            { pubKeyOrAddrToSign: operatorPub, lockTime: Number(MATURE_AT) + 1, changeAddress: await signer.getDefaultAddress() } as MethodCallOptions<Bond>
        )
        expect(tx.nLockTime).to.be.greaterThanOrEqual(Number(MATURE_AT))
    })
})
