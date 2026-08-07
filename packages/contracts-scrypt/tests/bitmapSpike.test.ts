import { expect } from 'chai'
import { MethodCallOptions, bsv, toByteString, ContractTransaction } from 'scrypt-ts'
import { BitmapSpike } from '../src/contracts/bitmapSpike'
import { localSigner } from './utils/signer'

/** Same helper the other contract tests use: a rejection is a PASS. */
async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn()
    } catch {
        return
    }
    throw new Error('expected rejection, but the call succeeded')
}

const WINNERS = 24 // one byte per winner; length is DATA, so capacity is per-market, not compile-time
const EMPTY = toByteString('00'.repeat(WINNERS))
const POOL_SATS = 1000

/** Set bit `index`, returning the continued instance so the next call can chain off it. */
async function setFlag(inst: BitmapSpike, index: bigint): Promise<BitmapSpike> {
    let captured!: BitmapSpike
    inst.bindTxBuilder('setFlag', async (cur: BitmapSpike, options: MethodCallOptions<BitmapSpike>): Promise<ContractTransaction> => {
        const next = cur.next()
        // Mirror the contract's own mutation, or hashOutputs will not match.
        const bytes = Buffer.from(cur.claimed, 'hex')
        bytes[Number(index)] = 1
        next.claimed = toByteString(bytes.toString('hex'))

        const tx = new bsv.Transaction()
            .addInput(cur.buildContractInput())
            .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
        if (options.changeAddress) tx.change(options.changeAddress)
        captured = next
        return {
            tx, atInputIndex: 0,
            nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }],
            next: { instance: next, atOutputIndex: 0, balance: cur.balance },
        }
    })
    const signer = localSigner()
    await inst.methods.setFlag(index, { changeAddress: await signer.getDefaultAddress() } as MethodCallOptions<BitmapSpike>)
    return captured
}

async function fresh(): Promise<BitmapSpike> {
    const inst = new BitmapSpike(EMPTY)
    const signer = localSigner()
    await inst.connect(signer)
    await inst.deploy(POOL_SATS)
    return inst
}

describe('BitmapSpike — can sCrypt set one bit at a RUNTIME index? (PAYOUT-002 de-risk)', () => {
    before(async () => { await BitmapSpike.loadArtifact() })

    it('marks a winner and verifies against the real Script interpreter', async () => {
        const inst = await fresh()
        const next = await setFlag(inst, 3n)
        expect(Buffer.from(next.claimed, 'hex')[3]).to.equal(1)
    })

    // The packed-bitmap version of this spike FAILED here: int2ByteString(128n, 1n) throws, because Script
    // integers are sign-magnitude. One byte per winner keeps every value in {0,1} and sidesteps it entirely.
    it('marks index 7 — the case that broke the packed-bitmap design', async () => {
        const inst = await fresh()
        const next = await setFlag(inst, 7n)
        expect(Buffer.from(next.claimed, 'hex')[7]).to.equal(1)
    })

    it('marks the LAST winner (dynamic slice far from offset 0)', async () => {
        const inst = await fresh()
        const next = await setFlag(inst, BigInt(WINNERS - 1))
        expect(Buffer.from(next.claimed, 'hex')[WINNERS - 1]).to.equal(1)
    })

    it('REJECTS an index past the end — capacity is the winner count, enforced on-chain', async () => {
        const inst = await fresh()
        await expectReject(() => setFlag(inst, BigInt(WINNERS)))
    })

    it('REJECTS a SECOND claim by the same winner — the anti-replay the Distributor needs', async () => {
        const inst = await fresh()
        const next = await setFlag(inst, 9n)
        await next.connect(localSigner())
        await expectReject(() => setFlag(next, 9n))
    })

    it('allows independent winners to claim in ARBITRARY order (what a cursor could not do)', async () => {
        let inst = await fresh()
        for (const i of [20n, 5n, 0n, 7n]) {
            inst = await setFlag(inst, i)
            await inst.connect(localSigner())
        }
        const b = Buffer.from(inst.claimed, 'hex')
        for (const i of [20, 5, 0, 7]) expect(b[i], `winner ${i} claimed`).to.equal(1)
        expect(b[1], 'winner 1 untouched').to.equal(0)
    })
})
