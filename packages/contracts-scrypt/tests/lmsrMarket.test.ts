import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MethodCallOptions, toByteString } from 'scrypt-ts'
import { LMSRMarket } from '../src/contracts/lmsrMarket'
import { localSigner } from './utils/signer'

/** Assert an async call rejects (no chai-as-promised dependency). */
async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    let threw = false
    try {
        await fn()
    } catch {
        threw = true
    }
    expect(threw, 'expected the call to be rejected').to.equal(true)
}

// Ground-truth vectors from @pm/lmsr (see fixtures/gen-vectors.ts). The sCrypt contract must reproduce them,
// so the two toolchains are provably matched to the same integer reference.
const V = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8')
)
const b = (s: string): bigint => BigInt(s)
const DUMMY_ORACLE = 0xdeadbeefn // RabinPubKey placeholder (unused by buy/sell)
const MARKET_TAG = toByteString('a1b2c3d4')
const POOL_SATS = 1000

function freshPool(): LMSRMarket {
    return new LMSRMarket(
        b(V.init.eYes), b(V.init.eNo), 0n, 0n, b(V.collateral), 0n, 0n,
        b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit),
        DUMMY_ORACLE, MARKET_TAG
    )
}

describe('LMSRMarket (sCrypt) — local verify matches @pm/lmsr', () => {
    before(async () => {
        await LMSRMarket.loadArtifact()
    })

    it('compiles + loads with the LMSR state props', () => {
        const inst = freshPool()
        expect(inst.eYes).to.equal(b(V.init.eYes))
        expect(inst.collateral).to.equal(b(V.collateral))
    })

    it('buyYes verifies locally and produces the reference post-trade state', async () => {
        const instance = freshPool()
        await instance.connect(localSigner())
        await instance.deploy(POOL_SATS)

        const charge = b(V.buyYes.charge)
        const next = instance.next()
        next.eYes = b(V.buyYes.eYes)
        next.qYes = b(V.buyYes.qYes)
        next.collateral = b(V.collateral) + charge

        // Not rejected == verifies locally (executes the real node Script — the guarantee Rúnar lacked).
        await instance.methods.buyYes(charge, {
            next: { instance: next, balance: POOL_SATS },
        } as MethodCallOptions<LMSRMarket>)
    })

    it('buyYes rejects underpayment (charge − 1)', async () => {
        const instance = freshPool()
        await instance.connect(localSigner())
        await instance.deploy(POOL_SATS)

        const charge = b(V.buyYes.charge)
        const next = instance.next()
        next.eYes = b(V.buyYes.eYes)
        next.qYes = b(V.buyYes.qYes)
        next.collateral = b(V.collateral) + (charge - 1n)

        await expectReject(() =>
            instance.methods.buyYes(charge - 1n, {
                next: { instance: next, balance: POOL_SATS },
            } as MethodCallOptions<LMSRMarket>)
        )
    })

    it('sellYes verifies locally against the reference (stocked → sell one)', async () => {
        // Start from a pool that already holds 2 YES (the "stocked" vector).
        const instance = new LMSRMarket(
            b(V.stocked.eYes), b(V.init.eNo), b(V.stocked.qYes), 0n, b(V.collateral), 0n, 0n,
            b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit),
            DUMMY_ORACLE, MARKET_TAG
        )
        await instance.connect(localSigner())
        await instance.deploy(POOL_SATS)

        const proceeds = b(V.afterSellYes.proceeds)
        const next = instance.next()
        next.eYes = b(V.afterSellYes.eYes)
        next.qYes = b(V.afterSellYes.qYes)
        next.collateral = b(V.collateral) - proceeds

        await instance.methods.sellYes({
            next: { instance: next, balance: POOL_SATS },
        } as MethodCallOptions<LMSRMarket>)
    })
})
