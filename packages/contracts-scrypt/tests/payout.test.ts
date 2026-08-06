import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
    fill,
    FixedArray,
    MethodCallOptions,
    PubKeyHash,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { LMSRMarket } from '../src/contracts/lmsrMarket'
import { localSigner } from './utils/signer'

// PAYOUT-001 — the receipt → on-chain payout bridge. Off-chain settled positions are audited signed receipts,
// not tokens, so `redeem` cannot pay them. `payout` pays every winner in ONE tx while the CONTRACT enforces the
// money: resolved market, total ≤ collateral, and collateral decremented by exactly what leaves.
async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    let threw = false
    try { await fn() } catch { threw = true }
    expect(threw, 'expected the call to be rejected').to.equal(true)
}

const V = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8'))
const b = (s: string): bigint => BigInt(s)
const DUMMY_ORACLE = 0xdeadbeefn
const MARKET_TAG = toByteString('a1b2c3d4')
const POOL_SATS = 1000
const COLLATERAL = 10_000n
const DIGEST = toByteString('ab'.repeat(32))

/** Three winners with distinct addresses + amounts — the realistic shape. */
const WINNERS = ['11', '22', '33'].map((h) => PubKeyHash(toByteString(h.repeat(20))))
const AMOUNTS = [1500n, 2500n, 1000n] // total 5000 ≤ COLLATERAL

function resolvedPool(collateral = COLLATERAL): LMSRMarket {
    return new LMSRMarket(
        b(V.init.eYes), b(V.init.eNo), 3n * b(V.unit), 0n, collateral, 1n, 1n, // resolved, YES won
        b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit), DUMMY_ORACLE, MARKET_TAG
    )
}
function unresolvedPool(): LMSRMarket {
    return new LMSRMarket(
        b(V.init.eYes), b(V.init.eNo), 3n * b(V.unit), 0n, COLLATERAL, 0n, 0n,
        b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit), DUMMY_ORACLE, MARKET_TAG
    )
}

const padded = (): { winners: FixedArray<PubKeyHash, 8>; amounts: FixedArray<bigint, 8> } => {
    const winners = fill(PubKeyHash(toByteString('00'.repeat(20))), 8)
    const amounts = fill(0n, 8)
    WINNERS.forEach((w, i) => { winners[i] = w })
    AMOUNTS.forEach((a, i) => { amounts[i] = a })
    return { winners, amounts }
}

/** Build the payout tx: pool continuation + OP_RETURN(digest) + one output per winner + change. */
function bindPayoutBuilder(pool: LMSRMarket, amounts: bigint[], winners: PubKeyHash[], total: bigint): void {
    pool.bindTxBuilder('payout', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
        const next = cur.next()
        next.collateral = cur.collateral - total
        const tx: any = new bsv.Transaction()
            .addInput(cur.buildContractInput())
            .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
            .addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(Utils.buildOpreturnScript(DIGEST)), satoshis: 0 }))
        winners.forEach((w, i) => {
            tx.addOutput(new bsv.Transaction.Output({
                script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(w)),
                satoshis: Number(amounts[i]!),
            }))
        })
        if (options.changeAddress) tx.change(options.changeAddress)
        return {
            tx, atInputIndex: 0,
            nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }],
            next: { instance: next, atOutputIndex: 0, balance: cur.balance },
        }
    })
}

describe('LMSRMarket.payout — receipt → on-chain payout (PAYOUT-001)', () => {
    before(async () => { await LMSRMarket.loadArtifact() })

    it('pays every winner in ONE tx, each exactly their amount, and decrements collateral', async () => {
        const pool = resolvedPool()
        const signer = localSigner()
        await pool.connect(signer)
        await pool.deploy(POOL_SATS)

        const { winners, amounts } = padded()
        const total = AMOUNTS.reduce((a, x) => a + x, 0n)
        bindPayoutBuilder(pool, AMOUNTS, WINNERS, total)

        const { tx } = await pool.methods.payout(winners, amounts, 3n, DIGEST, {
            changeAddress: await signer.getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)

        // pool + OP_RETURN + 3 winners + change
        expect(tx.outputs.length).to.be.greaterThanOrEqual(6)
        for (const amt of AMOUNTS) {
            expect(tx.outputs.some((o) => o.satoshis === Number(amt)), `winner paid ${amt}`).to.equal(true)
        }
    })

    it('REJECTS a payout larger than the pool collateral (cannot drain the pool)', async () => {
        const pool = resolvedPool(4000n) // total 5000 > 4000 collateral
        const signer = localSigner()
        await pool.connect(signer)
        await pool.deploy(POOL_SATS)

        const { winners, amounts } = padded()
        bindPayoutBuilder(pool, AMOUNTS, WINNERS, AMOUNTS.reduce((a, x) => a + x, 0n))
        await expectReject(() =>
            pool.methods.payout(winners, amounts, 3n, DIGEST, {
                changeAddress: signer.getDefaultAddress(),
            } as unknown as MethodCallOptions<LMSRMarket>)
        )
    })

    it('REJECTS a payout on an UNRESOLVED market', async () => {
        const pool = unresolvedPool()
        const signer = localSigner()
        await pool.connect(signer)
        await pool.deploy(POOL_SATS)

        const { winners, amounts } = padded()
        bindPayoutBuilder(pool, AMOUNTS, WINNERS, AMOUNTS.reduce((a, x) => a + x, 0n))
        await expectReject(() =>
            pool.methods.payout(winners, amounts, 3n, DIGEST, {
                changeAddress: signer.getDefaultAddress(),
            } as unknown as MethodCallOptions<LMSRMarket>)
        )
    })

    it('REJECTS a count above MAX_PAYOUTS and a zero count', async () => {
        const pool = resolvedPool()
        const signer = localSigner()
        await pool.connect(signer)
        await pool.deploy(POOL_SATS)
        const { winners, amounts } = padded()
        bindPayoutBuilder(pool, AMOUNTS, WINNERS, AMOUNTS.reduce((a, x) => a + x, 0n))
        for (const bad of [9n, 0n]) {
            await expectReject(() =>
                pool.methods.payout(winners, amounts, bad, DIGEST, {
                    changeAddress: signer.getDefaultAddress(),
                } as unknown as MethodCallOptions<LMSRMarket>)
            )
        }
    })
})
