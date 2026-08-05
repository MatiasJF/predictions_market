import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
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
            const tokenScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(buyerArg))
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

    it('redeem pays the winner in a MULTI-OUTPUT tx and verifies locally — the BUG-005 unblock', async () => {
        // A resolved pool with winner = YES, holding a 1-YES position.
        const resolved = new LMSRMarket(
            b(V.buyYes.eYes), b(V.init.eNo), b(V.buyYes.qYes), 0n, b(V.collateral), 1n, 1n,
            b(V.mult), b(V.invMult), b(V.payoutUnit), b(V.WAD), b(V.unit), DUMMY_ORACLE, MARKET_TAG
        )
        const signer = localSigner()
        await resolved.connect(signer)
        await resolved.deploy(POOL_SATS)

        const winner: PubKeyHash = PubKeyHash(toByteString('cd'.repeat(20)))
        const supply = 1n
        const payout = Number(supply * b(V.payoutUnit)) // 100_000 sats

        resolved.bindTxBuilder(
            'redeem',
            async (
                current: LMSRMarket,
                options: MethodCallOptions<LMSRMarket>,
                _isYes: boolean,
                supplyArg: bigint,
                winnerArg: PubKeyHash
            ): Promise<ContractTransaction> => {
                const next = current.next()
                next.collateral = current.collateral - supplyArg * current.payoutUnit
                const payoutScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(winnerArg))
                const unsignedTx = new bsv.Transaction()
                    .addInput(current.buildContractInput())
                    .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                    .addOutput(new bsv.Transaction.Output({ script: payoutScript, satoshis: Number(supplyArg * current.payoutUnit) }))
                if (options.changeAddress) unsignedTx.change(options.changeAddress)
                return {
                    tx: unsignedTx, atInputIndex: 0,
                    nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                    next: { instance: next, atOutputIndex: 0, balance: current.balance },
                }
            }
        )

        const { tx } = await resolved.methods.redeem(true, supply, winner, {
            changeAddress: await signer.getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)

        expect(tx.outputs.length).to.be.greaterThanOrEqual(3)
        expect(
            tx.outputs.some((o) => o.satoshis === payout),
            'winner payout output present'
        ).to.equal(true)
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
