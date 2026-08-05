// The full sCrypt market lifecycle in one process: deploy → buy(+mint) → resolve(oracle) → redeem(payout).
// sCrypt chains the stateful pool instance in-memory (each call's `next` becomes the next call's input) and
// auto-funds from the connected signer, so the same code runs OFFLINE (DummyProvider) and on MAINNET
// (DefaultProvider) — the only difference is the signer. This is the ScryptEngine's tx-building core.
//
// The multiplicative state (ADR-007) + post-trade-price MM-safe charge (ADR-011) are computed here from the
// precomputed `mult` constant (pure bigint mul/div — no exp), matching the on-chain contract and @pm/lmsr.
import {
    bsv,
    ByteString,
    ContractTransaction,
    MethodCallOptions,
    PubKeyHash,
    Signer,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { RabinPubKey, RabinSig } from 'scrypt-ts-lib'
import { LMSRMarket } from './contracts/lmsrMarket'

export interface LifecycleParams {
    eYes: bigint
    eNo: bigint
    mult: bigint
    invMult: bigint
    wad: bigint
    payoutUnit: bigint
    collateral: bigint
    oracleN: RabinPubKey
    marketTag: string // hex
    poolSats: number // sats locked in the pool UTXO (dust — collateral is state)
    tokenSats: number // dust for the claim ticket
    winnerPkh: string // hash160 hex of the buyer/winner (payout target)
    signOutcome: (marketTagHex: string, outcome: bigint) => RabinSig
}

export interface LifecycleResult {
    deployTxid: string
    buyTxid: string
    resolveTxid: string
    redeemTxid: string
    charge: string
    payout: string
}

const ceilDiv = (a: bigint, d: bigint): bigint => (a + d - 1n) / d

export async function runLifecycle(
    signer: Signer,
    p: LifecycleParams,
    log: (msg: string) => void = () => {}
): Promise<LifecycleResult> {
    await LMSRMarket.loadArtifact()
    const marketTag: ByteString = toByteString(p.marketTag)
    const winner: PubKeyHash = PubKeyHash(toByteString(p.winnerPkh))
    const changeAddress = await signer.getDefaultAddress()

    // ── DEPLOY ────────────────────────────────────────────────────────────────────────────────────────
    const pool = new LMSRMarket(
        p.eYes, p.eNo, 0n, 0n, p.collateral, 0n, 0n,
        p.mult, p.invMult, p.payoutUnit, p.wad, p.wad, p.oracleN, marketTag
    )
    await pool.connect(signer)
    const deployTx = await pool.deploy(p.poolSats)
    log(`deploy:   ${deployTx.id}`)

    // ── BUY YES + MINT (multi-output) ───────────────────────────────────────────────────────────────────
    const newEYes = (pool.eYes * p.mult) / p.wad
    const sumB = newEYes + pool.eNo
    const charge = ceilDiv(newEYes * p.payoutUnit, sumB) // MM-safe, rounded up

    let afterBuy!: LMSRMarket
    pool.bindTxBuilder(
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
            next.eYes = (current.eYes * p.mult) / p.wad
            next.qYes = current.qYes + current.unit
            next.collateral = current.collateral + paymentSats
            const tokenScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(buyerArg))
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                .addOutput(new bsv.Transaction.Output({ script: tokenScript, satoshis: Number(tokenSats) }))
            if (options.changeAddress) tx.change(options.changeAddress)
            afterBuy = next
            return {
                tx, atInputIndex: 0,
                nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                next: { instance: next, atOutputIndex: 0, balance: current.balance },
            }
        }
    )
    const buyRes = await pool.methods.buy(true, charge, winner, BigInt(p.tokenSats), {
        changeAddress,
    } as MethodCallOptions<LMSRMarket>)
    log(`buy+mint: ${buyRes.tx.id}  (charge ${charge} sat, token ${p.tokenSats} sat)`)

    // ── RESOLVE YES (oracle Rabin sig; single continuation → default builder) ────────────────────────────
    const resolveNext = afterBuy.next()
    resolveNext.resolved = 1n
    resolveNext.winner = 1n
    const sig = p.signOutcome(p.marketTag, 1n)
    const resolveRes = await afterBuy.methods.resolve(sig, 1n, {
        next: { instance: resolveNext, balance: afterBuy.balance },
    } as MethodCallOptions<LMSRMarket>)
    log(`resolve:  ${resolveRes.tx.id}  (YES, oracle-signed)`)

    // ── REDEEM YES (winner payout, multi-output) ────────────────────────────────────────────────────────
    const supply = 1n
    const payout = supply * p.payoutUnit
    let afterRedeem!: LMSRMarket
    resolveNext.bindTxBuilder(
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
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                .addOutput(new bsv.Transaction.Output({ script: payoutScript, satoshis: Number(supplyArg * current.payoutUnit) }))
            if (options.changeAddress) tx.change(options.changeAddress)
            afterRedeem = next
            return {
                tx, atInputIndex: 0,
                nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                next: { instance: next, atOutputIndex: 0, balance: current.balance },
            }
        }
    )
    const redeemRes = await resolveNext.methods.redeem(true, supply, winner, {
        changeAddress,
    } as MethodCallOptions<LMSRMarket>)
    log(`redeem:   ${redeemRes.tx.id}  (winner paid ${payout} sat)`)
    void afterRedeem

    return {
        deployTxid: deployTx.id,
        buyTxid: buyRes.tx.id,
        resolveTxid: resolveRes.tx.id,
        redeemTxid: redeemRes.tx.id,
        charge: charge.toString(),
        payout: payout.toString(),
    }
}
