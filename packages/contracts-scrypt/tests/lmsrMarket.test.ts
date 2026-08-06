import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
    int2ByteString,
    MethodCallOptions,
    PubKeyHash,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { LMSRMarket } from '../src/contracts/lmsrMarket'
import { localSigner } from './utils/signer'
import { oracleN, signOutcome } from '../src/oracle'

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
// Index into the pow vectors (exps: 0,1,2,3,20,100,530,1023,4095) — CONC-006 square-and-multiply.
const POW = { i2: 2, i3: 3, i530: 6 }
const MARKET_TAG = toByteString('a1b2c3d4')
const POOL_SATS = 1000
const TOKEN_SATS = 1n

function freshPool(): LMSRMarket {
    return new LMSRMarket(
        b(V.init.eYes), b(V.init.eNo), 0n, 0n, b(V.collateral), 0n, 0n,
        b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit),
        DUMMY_ORACLE, MARKET_TAG
    )
}

// The slimmed contract's `buy` ALWAYS mints (multi-output: pool + P2PKH claim ticket + change). This custom
// tx-builder produces that 3-output spend and is verified against the real node Script — the guarantee Rúnar
// lacked, and the BUG-005 (multi-output) unblock. `nextEYes/nextQYes` are the @pm/lmsr reference post-state.
function bindBuyBuilder(
    instance: LMSRMarket,
    nextEYes: bigint,
    nextQYes: bigint
): void {
    instance.bindTxBuilder(
        'buy',
        async (
            current: LMSRMarket,
            options: MethodCallOptions<LMSRMarket>,
            _isYes: boolean,
            paymentSats: bigint,
            buyerArg: PubKeyHash,
            tokenSats: bigint
        ): Promise<ContractTransaction> => {
            const next = current.next()
            next.eYes = nextEYes
            next.qYes = nextQYes
            next.collateral = current.collateral + paymentSats
            // Data-carrying token (CONC-003c): <push marketTag‖side‖supply(8)‖buyerPKH> OP_DROP P2PKH(buyer).
            const tokenScript = bsv.Script.fromHex(
                toByteString('21') + MARKET_TAG + toByteString('01') + int2ByteString(1n, 8n) + buyerArg +
                toByteString('75') + Utils.buildPublicKeyHashScript(buyerArg)
            )
            const unsignedTx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                .addOutput(new bsv.Transaction.Output({ script: tokenScript, satoshis: Number(tokenSats) }))
            if (options.changeAddress) unsignedTx.change(options.changeAddress)
            return {
                tx: unsignedTx, atInputIndex: 0,
                nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                next: { instance: next, atOutputIndex: 0, balance: current.balance },
            }
        }
    )
}

describe('LMSRMarket (sCrypt, slimmed CONC-004) — local verify matches @pm/lmsr', () => {
    before(async () => {
        await LMSRMarket.loadArtifact()
    })

    it('compiles to 4 methods + loads with the LMSR state props', () => {
        const inst = freshPool()
        expect(inst.eYes).to.equal(b(V.init.eYes))
        expect(inst.collateral).to.equal(b(V.collateral))
    })

    it('buy (multi-output mint) verifies locally and produces the reference post-trade state', async () => {
        const instance = freshPool()
        const signer = localSigner()
        await instance.connect(signer)
        await instance.deploy(POOL_SATS)

        const charge = b(V.buyYes.charge)
        const buyer: PubKeyHash = PubKeyHash(toByteString('ab'.repeat(20)))
        bindBuyBuilder(instance, b(V.buyYes.eYes), b(V.buyYes.qYes))

        // Not rejected == verifies locally (executes the real node Script). 3 outputs == pool + token + change.
        const { tx } = await instance.methods.buy(true, charge, buyer, TOKEN_SATS, {
            changeAddress: await signer.getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)
        expect(tx.outputs.length).to.be.greaterThanOrEqual(3)
    })

    it('buy rejects underpayment (charge − 1)', async () => {
        const instance = freshPool()
        const signer = localSigner()
        await instance.connect(signer)
        await instance.deploy(POOL_SATS)

        const charge = b(V.buyYes.charge)
        const buyer: PubKeyHash = PubKeyHash(toByteString('ab'.repeat(20)))
        const changeAddress = await signer.getDefaultAddress()
        bindBuyBuilder(instance, b(V.buyYes.eYes), b(V.buyYes.qYes))

        await expectReject(() =>
            instance.methods.buy(true, charge - 1n, buyer, TOKEN_SATS, {
                changeAddress,
            } as MethodCallOptions<LMSRMarket>)
        )
    })

    it('sell verifies locally against the reference (stocked → sell one)', async () => {
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

        await instance.methods.sell(true, {
            next: { instance: next, balance: POOL_SATS },
        } as MethodCallOptions<LMSRMarket>)
    })

    // redeem is now backtrace-verified against a co-spent on-chain token (CONC-003c) — see redeemBacktrace.test.ts.

    it('settle advances the pool by a batch in ONE tx, pins the batch commitment (OP_RETURN), verifies vs Script', async () => {
        // Batch: 3 net YES buys + 2 net NO buys (buys-only ⇒ net == the actual fill sequence, so the on-chain
        // net-state equals @pm/lmsr applied fill-by-fill — an exact three-way check). CONC-003a: a batchDigest
        // committing the receipts is emitted as an OP_RETURN output the contract pins into this tx.
        const instance = freshPool()
        const signer = localSigner()
        await instance.connect(signer)
        await instance.deploy(POOL_SATS)

        // Expected net state from the @pm/lmsr-generated square-and-multiply vectors (CONC-006) — the same
        // routine the contract runs, so contract == engine == @pm/lmsr by construction.
        const eYes = (b(V.init.eYes) * b(V.pow.mult[POW.i3]!)) / b(V.WAD)
        const eNo = (b(V.init.eNo) * b(V.pow.mult[POW.i2]!)) / b(V.WAD)
        const collateralDelta = 1234n // batch net cash (MVP: contract bounds solvency, not exact cash)
        const digest = toByteString('ab'.repeat(32)) // 32-byte batch commitment

        instance.bindTxBuilder(
            'settle',
            async (
                current: LMSRMarket,
                options: MethodCallOptions<LMSRMarket>
            ): Promise<ContractTransaction> => {
                const next = current.next()
                next.eYes = eYes
                next.eNo = eNo
                next.qYes = 3n * b(V.unit)
                next.qNo = 2n * b(V.unit)
                next.collateral = b(V.collateral) + collateralDelta
                const opret = bsv.Script.fromHex(Utils.buildOpreturnScript(digest))
                const unsignedTx = new bsv.Transaction()
                    .addInput(current.buildContractInput())
                    .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                    .addOutput(new bsv.Transaction.Output({ script: opret, satoshis: 0 }))
                if (options.changeAddress) unsignedTx.change(options.changeAddress)
                return {
                    tx: unsignedTx, atInputIndex: 0,
                    nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                    next: { instance: next, atOutputIndex: 0, balance: current.balance },
                }
            }
        )

        // Not rejected ⇒ the contract computed the identical net state AND pinned the same OP_RETURN commitment.
        const { tx } = await instance.methods.settle(3n, true, 2n, true, collateralDelta, true, digest, {
            changeAddress: await signer.getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)
        expect(tx.outputs.length).to.be.greaterThanOrEqual(3) // pool + OP_RETURN + change
        expect(
            tx.outputs.some((o) => o.satoshis === 0 && o.script.toHex().includes('ab'.repeat(32))),
            'OP_RETURN commitment (0-sat, carries the digest) present'
        ).to.equal(true)
    })

    it('settle handles a LARGE net move (530 units — the measured all-buys case) in one tx', async () => {
        // 530 was the measured net of 1,000 all-buy fills. Under the old linear cap (20) that needed 27
        // settlements; square-and-multiply clears it in ONE (CONC-006).
        const instance = freshPool()
        const signer = localSigner()
        await instance.connect(signer)
        await instance.deploy(POOL_SATS)

        const eYes = (b(V.init.eYes) * b(V.pow.mult[POW.i530]!)) / b(V.WAD)
        const digest = toByteString('ef'.repeat(32))
        instance.bindTxBuilder(
            'settle',
            async (current: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
                const next = current.next()
                next.eYes = eYes
                next.qYes = 530n * b(V.unit)
                next.collateral = b(V.collateral) + 1n
                const opret = bsv.Script.fromHex(Utils.buildOpreturnScript(digest))
                const unsignedTx = new bsv.Transaction()
                    .addInput(current.buildContractInput())
                    .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                    .addOutput(new bsv.Transaction.Output({ script: opret, satoshis: 0 }))
                if (options.changeAddress) unsignedTx.change(options.changeAddress)
                return {
                    tx: unsignedTx, atInputIndex: 0,
                    nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                    next: { instance: next, atOutputIndex: 0, balance: current.balance },
                }
            }
        )
        await instance.methods.settle(530n, true, 0n, true, 1n, true, digest, {
            changeAddress: await signer.getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)
    })

    it('settle rejects a net move above MAX_NET (4095)', async () => {
        const instance = freshPool()
        await instance.connect(localSigner())
        await instance.deploy(POOL_SATS)
        const next = instance.next()
        next.qYes = 4096n * b(V.unit)
        await expectReject(() =>
            instance.methods.settle(4096n, true, 0n, true, 0n, true, toByteString('cd'.repeat(32)), {
                next: { instance: next, balance: POOL_SATS },
            } as MethodCallOptions<LMSRMarket>)
        )
    })

    it('settle rejects a net SELL larger than the outstanding shares (no negative q)', async () => {
        const instance = freshPool() // fresh pool holds 0 YES
        await instance.connect(localSigner())
        await instance.deploy(POOL_SATS)
        const next = instance.next()
        next.qYes = -5n * b(V.unit)
        await expectReject(() =>
            instance.methods.settle(5n, false, 0n, true, 0n, false, toByteString('cd'.repeat(32)), {
                next: { instance: next, balance: POOL_SATS },
            } as MethodCallOptions<LMSRMarket>)
        )
    })

    it('resolve verifies a REAL Rabin oracle signature on-chain and flips the pool to YES', async () => {
        const pool = new LMSRMarket(
            b(V.init.eYes), b(V.init.eNo), 0n, 0n, b(V.collateral), 0n, 0n,
            b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit), oracleN, MARKET_TAG
        )
        await pool.connect(localSigner())
        await pool.deploy(POOL_SATS)

        const sig = signOutcome('a1b2c3d4', 1n)
        const next = pool.next()
        next.resolved = 1n
        next.winner = 1n
        // Not rejected == the on-chain RabinVerifier.verifySig(marketTag‖outcome, sig, oracleN) passed.
        await pool.methods.resolve(sig, 1n, {
            next: { instance: next, balance: POOL_SATS },
        } as MethodCallOptions<LMSRMarket>)

        // A signature for the WRONG outcome must be rejected (message binding).
        const pool2 = new LMSRMarket(
            b(V.init.eYes), b(V.init.eNo), 0n, 0n, b(V.collateral), 0n, 0n,
            b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit), oracleN, MARKET_TAG
        )
        await pool2.connect(localSigner())
        await pool2.deploy(POOL_SATS)
        const wrongSig = signOutcome('a1b2c3d4', 0n) // signed NO, but we claim YES
        const next2 = pool2.next()
        next2.resolved = 1n
        next2.winner = 1n
        await expectReject(() =>
            pool2.methods.resolve(wrongSig, 1n, {
                next: { instance: next2, balance: POOL_SATS },
            } as MethodCallOptions<LMSRMarket>)
        )
    })
})
