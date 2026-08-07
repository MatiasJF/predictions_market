import { expect } from 'chai'
import { MethodCallOptions, bsv, toByteString, ContractTransaction, PubKeyHash, Utils } from 'scrypt-ts'
import { SplitSpike } from '../src/contracts/splitSpike'
import { localSigner } from './utils/signer'

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn()
    } catch {
        return
    }
    throw new Error('expected rejection, but the call succeeded')
}

const WINNER = PubKeyHash(toByteString('11'.repeat(20)))
const AMOUNT = 3000n
const SATS = 1

/**
 * Claim `index` from a range, returning the continuation instances the tx produced (0, 1 or 2 of them).
 * The builder must mirror the contract's own state mutations exactly, or `hashOutputs` will not match.
 */
async function claim(inst: SplitSpike, index: bigint): Promise<SplitSpike[]> {
    const lo0 = inst.lo
    const hi0 = inst.hi
    const produced: SplitSpike[] = []

    inst.bindTxBuilder('claim', async (cur: SplitSpike, options: MethodCallOptions<SplitSpike>): Promise<ContractTransaction> => {
        const tx = new bsv.Transaction().addInput(cur.buildContractInput())
        const nexts: { instance: SplitSpike; atOutputIndex: number; balance: number }[] = []

        if (index > lo0) {
            const left = cur.next()
            left.lo = lo0
            left.hi = index
            tx.addOutput(new bsv.Transaction.Output({ script: left.lockingScript, satoshis: SATS }))
            nexts.push({ instance: left, atOutputIndex: tx.outputs.length - 1, balance: SATS })
            produced.push(left)
        }

        tx.addOutput(new bsv.Transaction.Output({
            script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(WINNER)),
            satoshis: Number(AMOUNT),
        }))

        if (index + 1n < hi0) {
            const right = cur.next()
            right.lo = index + 1n
            right.hi = hi0
            tx.addOutput(new bsv.Transaction.Output({ script: right.lockingScript, satoshis: SATS }))
            nexts.push({ instance: right, atOutputIndex: tx.outputs.length - 1, balance: SATS })
            produced.push(right)
        }

        if (options.changeAddress) tx.change(options.changeAddress)
        return { tx, atInputIndex: 0, nexts, next: nexts[0] }
    })

    const signer = localSigner()
    await inst.methods.claim(index, WINNER, AMOUNT, {
        changeAddress: await signer.getDefaultAddress(),
    } as MethodCallOptions<SplitSpike>)
    return produced
}

async function fresh(lo: bigint, hi: bigint): Promise<SplitSpike> {
    const inst = new SplitSpike(lo, hi)
    await inst.connect(localSigner())
    await inst.deploy(SATS)
    return inst
}

describe('SplitSpike — can ONE method emit TWO continuations with different state? (PAYOUT-002)', () => {
    before(async () => { await SplitSpike.loadArtifact() })

    it('claim in the MIDDLE forks the range into two live UTXOs — the parallelism property', async () => {
        const inst = await fresh(0n, 20n)
        const outs = await claim(inst, 7n)
        expect(outs.length, 'two continuations').to.equal(2)
        expect([outs[0]!.lo, outs[0]!.hi], 'left range').to.deep.equal([0n, 7n])
        expect([outs[1]!.lo, outs[1]!.hi], 'right range').to.deep.equal([8n, 20n])
    })

    it('claim at the START emits ONE continuation (the cheap operator-sweep path)', async () => {
        const inst = await fresh(0n, 20n)
        const outs = await claim(inst, 0n)
        expect(outs.length).to.equal(1)
        expect([outs[0]!.lo, outs[0]!.hi]).to.deep.equal([1n, 20n])
    })

    it('claim at the END emits ONE continuation', async () => {
        const inst = await fresh(0n, 20n)
        const outs = await claim(inst, 19n)
        expect(outs.length).to.equal(1)
        expect([outs[0]!.lo, outs[0]!.hi]).to.deep.equal([0n, 19n])
    })

    it('claim of a SINGLETON range closes the UTXO with no continuation and no dust', async () => {
        const inst = await fresh(5n, 6n)
        const outs = await claim(inst, 5n)
        expect(outs.length).to.equal(0)
    })

    it('REJECTS an index outside the range — the anti-replay', async () => {
        const inst = await fresh(0n, 20n)
        await expectReject(() => claim(inst, 20n))
    })

    it('REJECTS re-claiming an index that the split removed from both sides', async () => {
        const inst = await fresh(0n, 20n)
        const [left, right] = await claim(inst, 7n)
        await left!.connect(localSigner())
        await right!.connect(localSigner())
        await expectReject(() => claim(left!, 7n))  // 7 is no longer in [0,7)
        await expectReject(() => claim(right!, 7n)) // nor in [8,20)
    })

    it('lets two forked branches be claimed INDEPENDENTLY (what a serial design cannot do)', async () => {
        const inst = await fresh(0n, 20n)
        const [left, right] = await claim(inst, 10n)
        await left!.connect(localSigner())
        await right!.connect(localSigner())
        const l = await claim(left!, 3n)   // progresses on its own
        const r = await claim(right!, 15n) // and so does this, with no dependency between them
        expect(l.length).to.equal(2)
        expect(r.length).to.equal(2)
    })
})
