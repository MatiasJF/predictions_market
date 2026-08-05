// ScryptEngine — the sCrypt implementation of @pm/engine's ChainEngine (structurally typed; the daemon casts
// it). Wraps the proven sCrypt tx-building so the daemon can drive an sCrypt market through the SAME HTTP API +
// sign-off queue as the Rúnar engine (PM_ENGINE=scrypt). build* is keyless (computes the LMSR update + plan);
// authorizeAndBroadcast is the only place the key/broadcast happens.
//
// State model (spike): the live pool sCrypt instance is kept IN-PROCESS per market (deploy creates it; each
// authorize advances it) — sCrypt chains stateful instances + auto-funds from the signer. The DB records the
// lineage in parallel. Works within one daemon run (no restart mid-lifecycle). Network 'local' uses a
// DummyProvider (offline, real Script) — the mainnet path is proven separately (SCRYPT-004).
import {
    bsv,
    ContractTransaction,
    DefaultProvider,
    DummyProvider,
    int2ByteString,
    MethodCallOptions,
    PubKeyHash,
    Signer,
    TestWallet,
    Utils,
    toByteString,
} from 'scrypt-ts'
import { LMSRMarket } from './contracts/lmsrMarket'
import { oracleN, signOutcome } from './oracle'
import { attest, seqRabinPubKey } from './attestation'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import lmsrArtifact = require('../artifacts/lmsrMarket.json')

const WAD = 10n ** 18n
const COLLATERAL = 1_000_000_000n // pool collateral is STATE (spike); large enough to cover any redeem
const POOL_SATS = 1 // dust — collateral is state, not locked sats
const TOKEN_SATS = 1
const FEE_PER_KB = 500 // 0.5 sat/byte — the rate sCrypt's builders actually use (via provider.getFeePerKb)

/**
 * Forces an explicit fee rate. sCrypt derives tx fees from the provider's getFeePerKb(); WhatsOnChain returns
 * ~50 sat/KB (0.05 sat/byte), which is too low for the pool txs (~44 KB/spend after CONC-004 slimming) to confirm
 * promptly (they sat unconfirmed for 40+ min). Overriding it to 500 sat/KB is the real fee-control fix.
 */
class FeeProvider extends DefaultProvider {
    override async getFeePerKb(): Promise<number> {
        return FEE_PER_KB
    }
}

/**
 * Offline (network='local') provider. DummyProvider re-simulates a fee check in sendTransaction which conflicts
 * with bsv's own fee guard for the large multi-input covenant txs (redeem co-spend). That simulation runs AFTER
 * the real node Script interpreter has already verified every input — the meaningful guarantee — and there is no
 * chain to broadcast to offline, so the "broadcast" is stubbed. The mainnet path uses FeeProvider + a real send.
 */
class LocalProvider extends DummyProvider {
    override async sendTransaction(tx: bsv.Transaction): Promise<string> {
        return tx.id
    }
}

// ── structural mirrors of @pm/engine types (kept in sync; the daemon casts ScryptEngine → ChainEngine) ─────
type Side = 'yes' | 'no'
interface MarketConfig { marketId: number; bUnits: bigint; payoutUnit: bigint; mult: bigint; invMult: bigint }
interface PoolState { eYes: bigint; eNo: bigint; qYes: bigint; qNo: bigint; collateral: bigint; resolved: bigint; winner: bigint }
interface PoolRef { txid: string; vout: number; satoshis: number; lockingScript: string; state: PoolState }
interface TxEffects {
    pool: { vout: number; satoshis: number; eYes: string; eNo: string; qYes: string; qNo: string; collateral: string; resolved: 0 | 1; winner: 0 | 1; lockingScript: string }
    spendsPrevPool: boolean
    trade?: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }
    settle?: { orderIds: number[]; netYesUnits: string; netNoUnits: string; netCollateralSats: number; trades: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }[]; batchDigest?: string; attestationSig?: string; attestationPubkey?: string }
    marketState?: 'deployed' | 'trading' | 'resolved'
    resolution?: Side
}
interface SettleBatch {
    netYesUnits: bigint; netNoUnits: bigint; netCollateralSats: number
    orderIds: number[]
    fills: { trader: string; side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }[]
    batchDigest: string
}
interface TxPlan { kind: string; summary: string; spendSats: number; build: unknown; effects: TxEffects }
interface BroadcastResult { txid: string; poolLockingScript: string }

export class EngineLimitation extends Error {
    constructor(public readonly kind: string, public readonly pointer: string) {
        super(`engine '${kind}' unsupported: ${pointer}`)
        this.name = 'EngineLimitation'
    }
}

const ceilDiv = (a: bigint, d: bigint): bigint => (a + d - 1n) / d
const marketTagHex = (marketId: number): string => marketId.toString(16).padStart(8, '0') // 4-byte tag
const poolEffect = (s: PoolState): TxEffects['pool'] => ({
    vout: 0, satoshis: POOL_SATS,
    eYes: s.eYes.toString(), eNo: s.eNo.toString(), qYes: s.qYes.toString(), qNo: s.qNo.toString(),
    collateral: s.collateral.toString(), resolved: s.resolved === 1n ? 1 : 0, winner: s.winner === 1n ? 1 : 0,
    lockingScript: '',
})

interface DeployBuild { kind: 'deploy'; marketId: number; cfg: { mult: string; invMult: string; payoutUnit: string } }
interface BuyBuild { kind: 'buy'; marketId: number; side: Side; charge: string }
interface SellBuild { kind: 'sell'; marketId: number; side: Side }
interface ResolveBuild { kind: 'resolve'; marketId: number; outcome: Side }
interface RedeemBuild { kind: 'redeem'; marketId: number; side: Side; supply: string }
interface SettleBuild { kind: 'settle'; marketId: number; netYesUnits: string; netNoUnits: string; netCollateralSats: number; batchDigest: string }

/** A minted position token (CONC-003c) + the pieces redeem's on-chain backtrace needs to prove it. */
interface TokenRef {
    txid: string        // mint txid, display order
    vout: number        // always 1 (buy emits pool, token, change)
    satoshis: number
    script: string      // the data+P2PKH token locking script (hex)
    holderPkh: string
    supply: bigint
    isYes: boolean
    prevHeader: string  // version ‖ varint(nIn) ‖ inputs ‖ varint(nOut)
    poolOut: string     // serialized output 0 (exactly ONE output ⇒ the token is output index 1)
    prevTail: string    // serialized outputs 2.. ‖ nLockTime
}

/**
 * Split a mint tx into the three backtrace pieces so that
 * `hash256(prevHeader ‖ poolOut ‖ tokenOutput ‖ prevTail)` reproduces its txid — exactly what the pool's
 * `redeem` recomputes on-chain. Throws if the reconstruction doesn't match (defensive: never hand the contract
 * pieces that cannot verify).
 */
function splitMintTx(tx: bsv.Transaction, tokenVout: number): { prevHeader: string; poolOut: string; prevTail: string } {
    const t = tx as unknown as { version: number; inputs: { toBufferWriter: (w: unknown) => void }[]; outputs: { toBufferWriter: (w: unknown) => void }[]; nLockTime: number; toBuffer: () => Buffer }
    const ser = (o: { toBufferWriter: (w: unknown) => void }): string => {
        const w = new bsv.encoding.BufferWriter()
        o.toBufferWriter(w)
        return w.toBuffer().toString('hex')
    }
    const hw = new bsv.encoding.BufferWriter() as unknown as { writeUInt32LE: (n: number) => void; writeVarintNum: (n: number) => void; toBuffer: () => Buffer }
    hw.writeUInt32LE(t.version)
    hw.writeVarintNum(t.inputs.length)
    for (const i of t.inputs) i.toBufferWriter(hw)
    hw.writeVarintNum(t.outputs.length)
    const prevHeader = hw.toBuffer().toString('hex')

    const tw = new bsv.encoding.BufferWriter() as unknown as { writeUInt32LE: (n: number) => void; toBuffer: () => Buffer }
    for (let i = tokenVout + 1; i < t.outputs.length; i++) t.outputs[i]!.toBufferWriter(tw)
    tw.writeUInt32LE(t.nLockTime)
    const prevTail = tw.toBuffer().toString('hex')

    const poolOut = ser(t.outputs[0]!)
    const tokenOutput = ser(t.outputs[tokenVout]!)
    const rebuilt = Buffer.from(prevHeader + poolOut + tokenOutput + prevTail, 'hex')
    if (!rebuilt.equals(t.toBuffer())) {
        throw new Error('sCrypt engine: mint-tx reconstruction mismatch (token must be output index 1)')
    }
    return { prevHeader, poolOut, prevTail }
}

export class ScryptEngine {
    readonly name: string = 'scrypt'
    private readonly network: 'local' | 'mainnet'
    private readonly getWif: () => string
    private readonly instances = new Map<number, LMSRMarket>()
    private _signer?: Signer
    private _priv?: bsv.PrivateKey
    /** CONC-003c: the position token minted by the latest buy per market — co-spent + backtraced by redeem. */
    private readonly tokens = new Map<number, TokenRef>()
    private loaded = false

    constructor(network: 'local' | 'mainnet' = 'local', getWif: () => string = () => '') {
        this.network = network
        this.getWif = getWif
    }

    private async ready(): Promise<void> {
        if (!this.loaded) { LMSRMarket.loadArtifact(lmsrArtifact as never); this.loaded = true }
    }
    /** The funding key, in memory only (Golden Rule 6). Also signs the co-spent token/funding inputs (CONC-003c). */
    private priv(): bsv.PrivateKey {
        if (!this._priv) {
            this._priv = this.network === 'mainnet'
                ? bsv.PrivateKey.fromWIF(this.getWif())
                : bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
        }
        return this._priv
    }
    private signer(): Signer {
        if (!this._signer) {
            // FeeProvider forces an adequate fee rate (the WoC default is too low for large pool txs to confirm).
            this._signer = this.network === 'mainnet'
                ? new TestWallet(this.priv(), new FeeProvider({ network: bsv.Networks.mainnet }))
                : new TestWallet(this.priv(), new LocalProvider())
        }
        return this._signer
    }
    private async selfPkh(): Promise<PubKeyHash> {
        const addr = await this.signer().getDefaultAddress()
        return PubKeyHash(toByteString(addr.hashBuffer.toString('hex')))
    }
    private freshPool(cfg: MarketConfig): LMSRMarket {
        return new LMSRMarket(
            WAD, WAD, 0n, 0n, COLLATERAL, 0n, 0n,
            cfg.mult, cfg.invMult, cfg.payoutUnit, WAD, WAD, oracleN, toByteString(marketTagHex(cfg.marketId))
        )
    }

    async fundingAddress(): Promise<string> {
        return (await this.signer().getDefaultAddress()).toString()
    }
    async fundingPublicKey(): Promise<string> {
        if (this.network !== 'mainnet') return '02' + 'ab'.repeat(32)
        return bsv.PrivateKey.fromWIF(this.getWif()).publicKey.toString()
    }
    oracleId(): string {
        return oracleN.toString(16)
    }
    /** CONC-003b: Rabin-sign the settlement attestation (verifiable on-chain by a Bond's slash). */
    rabinAttest(marketId: number, toVersion: number, digest: string): { key: string; sig: string; pubkey: string } {
        const a = attest(marketId, toVersion, digest)
        return { key: a.key, sig: JSON.stringify({ s: a.sig.s.toString(), padding: a.sig.padding }), pubkey: seqRabinPubKey.toString() }
    }
    async getUtxos(_address: string): Promise<{ txid: string; outputIndex: number; satoshis: number; script: string }[]> {
        return [] // wallet-balance view; sCrypt auto-funds internally. (local has no real UTXOs.)
    }

    // ── build* (keyless) ────────────────────────────────────────────────────────────────────────────────
    async buildDeploy(cfg: MarketConfig, _deploySats: number): Promise<TxPlan> {
        const state0: PoolState = { eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n }
        const build: DeployBuild = { kind: 'deploy', marketId: cfg.marketId, cfg: { mult: cfg.mult.toString(), invMult: cfg.invMult.toString(), payoutUnit: cfg.payoutUnit.toString() } }
        return { kind: 'deploy', summary: `deploy sCrypt LMSR pool (b=${cfg.bUnits})`, spendSats: POOL_SATS + 50, build, effects: { pool: poolEffect(state0), spendsPrevPool: false, marketState: 'deployed' } }
    }

    async buildBuy(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
        if (shares !== 1n) throw new EngineLimitation('buy', 'the sCrypt daemon path buys 1 share/call (multi-share is a bounded-loop port).')
        let s: PoolState
        let charge: bigint
        if (side === 'yes') {
            const newEYes = (pool.state.eYes * cfg.mult) / WAD
            charge = ceilDiv(newEYes * cfg.payoutUnit, newEYes + pool.state.eNo)
            s = { eYes: newEYes, eNo: pool.state.eNo, qYes: pool.state.qYes + WAD, qNo: pool.state.qNo, collateral: pool.state.collateral + charge, resolved: 0n, winner: 0n }
        } else {
            const newENo = (pool.state.eNo * cfg.mult) / WAD
            charge = ceilDiv(newENo * cfg.payoutUnit, pool.state.eYes + newENo)
            s = { eYes: pool.state.eYes, eNo: newENo, qYes: pool.state.qYes, qNo: pool.state.qNo + WAD, collateral: pool.state.collateral + charge, resolved: 0n, winner: 0n }
        }
        const build: BuyBuild = { kind: 'buy', marketId: cfg.marketId, side, charge: charge.toString() }
        return { kind: 'buy', summary: `buy 1 ${side.toUpperCase()} + mint token → charge ${charge} sat`, spendSats: 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true, trade: { side, action: 'buy', shares: WAD.toString(), costSats: Number(charge) }, marketState: 'trading' } }
    }

    async buildSell(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
        if (shares !== 1n) throw new EngineLimitation('sell', 'the sCrypt daemon path sells 1 share/call.')
        const held = side === 'yes' ? pool.state.qYes : pool.state.qNo
        if (held < WAD) throw new Error(`pool has no outstanding ${side.toUpperCase()} to sell`)
        let s: PoolState
        let proceeds: bigint
        if (side === 'yes') {
            const newEYes = (pool.state.eYes * cfg.invMult) / WAD
            proceeds = (newEYes * cfg.payoutUnit) / (newEYes + pool.state.eNo) // floor
            s = { eYes: newEYes, eNo: pool.state.eNo, qYes: pool.state.qYes - WAD, qNo: pool.state.qNo, collateral: pool.state.collateral - proceeds, resolved: 0n, winner: 0n }
        } else {
            const newENo = (pool.state.eNo * cfg.invMult) / WAD
            proceeds = (newENo * cfg.payoutUnit) / (pool.state.eYes + newENo)
            s = { eYes: pool.state.eYes, eNo: newENo, qYes: pool.state.qYes, qNo: pool.state.qNo - WAD, collateral: pool.state.collateral - proceeds, resolved: 0n, winner: 0n }
        }
        const build: SellBuild = { kind: 'sell', marketId: cfg.marketId, side }
        return { kind: 'sell', summary: `sell 1 ${side.toUpperCase()} → proceeds ${proceeds} sat`, spendSats: 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true, trade: { side, action: 'sell', shares: WAD.toString(), costSats: Number(proceeds) }, marketState: 'trading' } }
    }

    async buildResolve(cfg: MarketConfig, pool: PoolRef, outcome: Side): Promise<TxPlan> {
        const s: PoolState = { ...pool.state, resolved: 1n, winner: outcome === 'yes' ? 1n : 0n }
        const build: ResolveBuild = { kind: 'resolve', marketId: cfg.marketId, outcome }
        return { kind: 'resolve', summary: `resolve ${outcome.toUpperCase()} (Rabin oracle)`, spendSats: 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true, marketState: 'resolved', resolution: outcome } }
    }

    async buildRedeem(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
        if (pool.state.resolved !== 1n) throw new Error('market not resolved')
        const payout = shares * cfg.payoutUnit
        const s: PoolState = { ...pool.state, collateral: pool.state.collateral - payout }
        const build: RedeemBuild = { kind: 'redeem', marketId: cfg.marketId, side, supply: shares.toString() }
        return { kind: 'redeem', summary: `redeem ${shares} ${side.toUpperCase()} → pay winner ${payout} sat`, spendSats: Number(payout) + 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true } }
    }

    async buildSettleBatch(cfg: MarketConfig, pool: PoolRef, batch: SettleBatch): Promise<TxPlan> {
        // Net-state advance (CONC-002): the settled state = pool advanced by the batch's NET units, computed the
        // SAME way the contract does (repeated mult/invMult), so it matches by construction.
        const WADc = WAD
        const stepE = (e0: bigint, net: bigint, isBuy: boolean): bigint => {
            const n = net < 0n ? -net : net
            const m = isBuy ? cfg.mult : cfg.invMult
            let e = e0
            for (let i = 0n; i < n; i++) e = (e * m) / WADc
            return e
        }
        const eYes = stepE(pool.state.eYes, batch.netYesUnits, batch.netYesUnits >= 0n)
        const eNo = stepE(pool.state.eNo, batch.netNoUnits, batch.netNoUnits >= 0n)
        const s: PoolState = {
            eYes, eNo,
            qYes: pool.state.qYes + batch.netYesUnits * WADc,
            qNo: pool.state.qNo + batch.netNoUnits * WADc,
            collateral: pool.state.collateral + BigInt(batch.netCollateralSats),
            resolved: 0n, winner: 0n,
        }
        const build: SettleBuild = {
            kind: 'settle', marketId: cfg.marketId,
            netYesUnits: batch.netYesUnits.toString(), netNoUnits: batch.netNoUnits.toString(),
            netCollateralSats: batch.netCollateralSats, batchDigest: batch.batchDigest,
        }
        return {
            kind: 'settle',
            summary: `settle ${batch.orderIds.length} off-chain fills → net YES ${batch.netYesUnits}, NO ${batch.netNoUnits}`,
            spendSats: 200, build,
            effects: {
                pool: poolEffect(s), spendsPrevPool: true,
                settle: {
                    orderIds: batch.orderIds,
                    netYesUnits: batch.netYesUnits.toString(), netNoUnits: batch.netNoUnits.toString(),
                    netCollateralSats: batch.netCollateralSats,
                    trades: batch.fills.map((f) => ({ side: f.side, action: f.action, shares: f.shares, costSats: f.costSats })),
                    batchDigest: batch.batchDigest,
                },
                marketState: 'trading',
            },
        }
    }

    // ── authorizeAndBroadcast (the only key use / broadcast) ──────────────────────────────────────────────
    async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
        await this.ready()
        const kind = (plan.build as { kind: string }).kind
        if (kind === 'deploy') return this.execDeploy(plan.build as DeployBuild)
        if (kind === 'buy') return this.execBuy(plan.build as BuyBuild)
        if (kind === 'sell') return this.execSell(plan.build as SellBuild)
        if (kind === 'resolve') return this.execResolve(plan.build as ResolveBuild)
        if (kind === 'redeem') return this.execRedeem(plan.build as RedeemBuild)
        if (kind === 'settle') return this.execSettle(plan.build as SettleBuild)
        throw new Error(`sCrypt engine: unknown plan kind '${kind}'`)
    }

    private async execSettle(b: SettleBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId}`)
        const netYes = BigInt(b.netYesUnits)
        const netNo = BigInt(b.netNoUnits)
        const yBuy = netYes >= 0n
        const nBuy = netNo >= 0n
        const yAbs = yBuy ? netYes : -netYes
        const nAbs = nBuy ? netNo : -netNo
        const colUp = b.netCollateralSats >= 0
        const colAbs = BigInt(Math.abs(b.netCollateralSats))
        const digest = toByteString(b.batchDigest)
        let captured!: LMSRMarket
        // Custom builder: pool continuation + OP_RETURN(batchDigest) + change (the CONC-003a commitment output).
        current.bindTxBuilder('settle', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
            const next = cur.next()
            let eYes = cur.eYes
            for (let i = 0n; i < yAbs; i++) eYes = (eYes * (yBuy ? cur.mult : cur.invMult)) / cur.scale
            next.eYes = eYes
            let eNo = cur.eNo
            for (let i = 0n; i < nAbs; i++) eNo = (eNo * (nBuy ? cur.mult : cur.invMult)) / cur.scale
            next.eNo = eNo
            next.qYes = cur.qYes + netYes * cur.unit
            next.qNo = cur.qNo + netNo * cur.unit
            next.collateral = colUp ? cur.collateral + colAbs : cur.collateral - colAbs
            const opret = bsv.Script.fromHex(Utils.buildOpreturnScript(digest))
            const tx = new bsv.Transaction().addInput(cur.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: opret, satoshis: 0 }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(500)
            if (options.changeAddress) tx.change(options.changeAddress)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })
        const res = await current.methods.settle(yAbs, yBuy, nAbs, nBuy, colAbs, colUp, digest, {
            changeAddress: await this.signer().getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, captured)
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex() }
    }

    private async execDeploy(b: DeployBuild): Promise<BroadcastResult> {
        const pool = this.freshPool({ marketId: b.marketId, bUnits: 0n, payoutUnit: BigInt(b.cfg.payoutUnit), mult: BigInt(b.cfg.mult), invMult: BigInt(b.cfg.invMult) })
        await pool.connect(this.signer())
        const tx = await pool.deploy(POOL_SATS)
        this.instances.set(b.marketId, pool)
        return { txid: tx.id, poolLockingScript: pool.lockingScript.toHex() }
    }

    private async execBuy(b: BuyBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId} (deploy first)`)
        const charge = BigInt(b.charge)
        const buyer = await this.selfPkh()
        const isYes = b.side === 'yes'
        let captured!: LMSRMarket
        // Slimmed contract (CONC-004): single side-parameterized `buy(isYes, paymentSats, buyer, tokenSats)`.
        current.bindTxBuilder('buy', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>, isYesArg: boolean, paymentSats: bigint, buyerArg: PubKeyHash, tokenSats: bigint): Promise<ContractTransaction> => {
            const next = cur.next()
            if (isYesArg) { next.eYes = (cur.eYes * cur.mult) / cur.scale; next.qYes = cur.qYes + cur.unit }
            else { next.eNo = (cur.eNo * cur.mult) / cur.scale; next.qNo = cur.qNo + cur.unit }
            next.collateral = cur.collateral + paymentSats
            // Data-carrying position token (CONC-003c): <push marketTag‖side‖supply(8)‖buyerPKH> OP_DROP P2PKH(buyer).
            const tokenScript = bsv.Script.fromHex(
                '21' + marketTagHex(b.marketId) + (isYesArg ? '01' : '00') + int2ByteString(1n, 8n) + buyerArg +
                '75' + Utils.buildPublicKeyHashScript(buyerArg)
            )
            const tx = new bsv.Transaction().addInput(cur.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: tokenScript, satoshis: Number(tokenSats) }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(500) // 0.5 sat/B — confirm-worthy
            if (options.changeAddress) tx.change(options.changeAddress)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })
        const res = await current.methods.buy(isYes, charge, buyer, BigInt(TOKEN_SATS), { changeAddress: await this.signer().getDefaultAddress() } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, captured)

        // CONC-003c: remember the minted token + the backtrace pieces so redeem can co-spend and PROVE it.
        const tokenScript = '21' + marketTagHex(b.marketId) + (isYes ? '01' : '00') + int2ByteString(1n, 8n) + buyer +
            '75' + Utils.buildPublicKeyHashScript(buyer)
        const { prevHeader, poolOut, prevTail } = splitMintTx(res.tx as unknown as bsv.Transaction, 1)
        this.tokens.set(b.marketId, {
            txid: res.tx.id, vout: 1, satoshis: TOKEN_SATS, script: tokenScript,
            holderPkh: buyer, supply: 1n, isYes, prevHeader, poolOut, prevTail,
        })
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex() }
    }

    private async execSell(b: SellBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId}`)
        const next = current.next()
        if (b.side === 'yes') { next.eYes = (current.eYes * current.invMult) / current.scale; next.qYes = current.qYes - current.unit }
        else { next.eNo = (current.eNo * current.invMult) / current.scale; next.qNo = current.qNo - current.unit }
        const newE = b.side === 'yes' ? next.eYes : next.eNo
        next.collateral = current.collateral - (newE * current.payoutUnit) / (next.eYes + next.eNo)
        // Slimmed contract (CONC-004): single side-parameterized `sell(isYes)` (state-only continuation).
        const res = await current.methods.sell(b.side === 'yes', { next: { instance: next, balance: current.balance } } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, next)
        return { txid: res.tx.id, poolLockingScript: next.lockingScript.toHex() }
    }

    private async execResolve(b: ResolveBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId}`)
        const outcomeN = b.outcome === 'yes' ? 1n : 0n
        const next = current.next()
        next.resolved = 1n
        next.winner = outcomeN
        const sig = signOutcome(marketTagHex(b.marketId), outcomeN)
        const res = await current.methods.resolve(sig, outcomeN, { next: { instance: next, balance: current.balance } } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, next)
        return { txid: res.tx.id, poolLockingScript: next.lockingScript.toHex() }
    }

    /**
     * REDEEM (CONC-003c) — co-spends the market's minted position token as input #1 and lets the pool BACKTRACE
     * it on-chain. Inputs are added explicitly (pool, token, funding) so `allOutpoints` is deterministic and
     * matches `hashPrevouts`; the token + funding P2PKH inputs are signed here with the funding key (the token
     * holder is this engine's own address). `autoPayFee: false` keeps the framework from appending inputs after
     * the covenant has committed to the outpoint set.
     */
    private async execRedeem(b: RedeemBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId}`)
        const token = this.tokens.get(b.marketId)
        if (!token) {
            throw new EngineLimitation('redeem', 'no minted position token tracked for this market in this run — buy first (CONC-003c requires co-spending the real token)')
        }
        const isYes = b.side === 'yes'
        if (token.isYes !== isYes) throw new Error(`sCrypt engine: tracked token is ${token.isYes ? 'YES' : 'NO'}, not ${b.side.toUpperCase()}`)

        const priv = this.priv()
        const address = await this.signer().getDefaultAddress()
        const payout = token.supply * current.payoutUnit

        // Explicit funding input (the payout is real sats; the pool UTXO is dust).
        const utxos = await this.signer().listUnspent(address)
        const funding = utxos.find((u) => u.satoshis >= Number(payout) + 50_000) ?? utxos[0]
        if (!funding) throw new Error('sCrypt engine: no funding UTXO available for redeem')

        const poolInput = current.buildContractInput()
        const tokenInput = new bsv.Transaction.Input({
            prevTxId: Buffer.from(token.txid, 'hex'),
            outputIndex: token.vout,
            script: bsv.Script.fromHex(''),
            sequenceNumber: 0xffffffff,
        })
        const fundingInput = new bsv.Transaction.Input({
            prevTxId: Buffer.from(funding.txId, 'hex'),
            outputIndex: funding.outputIndex,
            script: bsv.Script.fromHex(''),
            sequenceNumber: 0xffffffff,
        })
        const opHex = (i: bsv.Transaction.Input): string => {
            const w = new bsv.encoding.BufferWriter() as unknown as { write: (b: Buffer) => void; writeUInt32LE: (n: number) => void; toBuffer: () => Buffer }
            w.write(Buffer.from((i as unknown as { prevTxId: Buffer }).prevTxId).reverse()) // bsv holds prevTxId display-order; outpoints serialize internal
            w.writeUInt32LE((i as unknown as { outputIndex: number }).outputIndex)
            return w.toBuffer().toString('hex')
        }
        const allOutpoints = opHex(poolInput) + opHex(tokenInput) + opHex(fundingInput)

        let captured!: LMSRMarket
        current.bindTxBuilder('redeem', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
            const next = cur.next()
            next.collateral = cur.collateral - payout
            const payoutScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(PubKeyHash(toByteString(token.holderPkh))))
            const tx = new bsv.Transaction().addInput(poolInput)
                .addInput(tokenInput, bsv.Script.fromHex(token.script), token.satoshis)
                .addInput(fundingInput, bsv.Script.fromHex(funding.script), funding.satoshis)
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: payoutScript, satoshis: Number(payout) }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(FEE_PER_KB)
            if (options.changeAddress) {
                // The framework inserts the pool's (large) covenant unlocking script AFTER this builder runs, so
                // size-based change would under-fund the fee. Reserve for it explicitly.
                const unlockEst = (cur.lockingScript as unknown as { toBuffer: () => Buffer }).toBuffer().length * 1.2 + 2000
                const sizeEst = (tx as unknown as { toBuffer: () => Buffer }).toBuffer().length + unlockEst
                ;(tx.change(options.changeAddress) as unknown as { fee: (n: number) => void }).fee(
                    Math.ceil((sizeEst / 1000) * FEE_PER_KB)
                )
            }
            // Sign the two P2PKH inputs with the funding key. NONE|ANYONECANPAY so each commits only to its own
            // input — the framework fills the pool's covenant unlock afterwards, which would break SIGHASH_ALL.
            const sighashType = bsv.crypto.Signature.SIGHASH_NONE | bsv.crypto.Signature.SIGHASH_ANYONECANPAY | bsv.crypto.Signature.SIGHASH_FORKID
            const signP2PKH = (idx: number, subscript: bsv.Script, sats: number): void => {
                const sig = bsv.Transaction.Sighash.sign(tx, priv, sighashType, idx, subscript, new bsv.crypto.BN(sats))
                const unlock = bsv.Script.fromHex('') as unknown as { add: (b: Buffer) => void }
                unlock.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType])]))
                unlock.add(priv.publicKey.toBuffer())
                ;(tx.inputs[idx] as unknown as { setScript: (s: unknown) => void }).setScript(unlock)
            }
            signP2PKH(1, bsv.Script.fromHex(token.script), token.satoshis)
            signP2PKH(2, bsv.Script.fromHex(funding.script), funding.satoshis)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })

        const res = await current.methods.redeem(
            isYes, token.supply, PubKeyHash(toByteString(token.holderPkh)), BigInt(token.satoshis),
            toByteString(token.prevHeader), toByteString(token.poolOut), toByteString(token.prevTail), toByteString(allOutpoints),
            { changeAddress: address, autoPayFee: false } as MethodCallOptions<LMSRMarket>
        )
        this.instances.set(b.marketId, captured)
        this.tokens.delete(b.marketId) // the token is burned by this redeem
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex() }
    }
}
