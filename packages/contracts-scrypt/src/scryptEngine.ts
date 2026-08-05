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
    MethodCallOptions,
    PubKeyHash,
    Signer,
    TestWallet,
    Utils,
    toByteString,
} from 'scrypt-ts'
import { LMSRMarket } from './contracts/lmsrMarket'
import { oracleN, signOutcome } from './oracle'
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

// ── structural mirrors of @pm/engine types (kept in sync; the daemon casts ScryptEngine → ChainEngine) ─────
type Side = 'yes' | 'no'
interface MarketConfig { marketId: number; bUnits: bigint; payoutUnit: bigint; mult: bigint; invMult: bigint }
interface PoolState { eYes: bigint; eNo: bigint; qYes: bigint; qNo: bigint; collateral: bigint; resolved: bigint; winner: bigint }
interface PoolRef { txid: string; vout: number; satoshis: number; lockingScript: string; state: PoolState }
interface TxEffects {
    pool: { vout: number; satoshis: number; eYes: string; eNo: string; qYes: string; qNo: string; collateral: string; resolved: 0 | 1; winner: 0 | 1; lockingScript: string }
    spendsPrevPool: boolean
    trade?: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }
    marketState?: 'deployed' | 'trading' | 'resolved'
    resolution?: Side
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

export class ScryptEngine {
    readonly name: string = 'scrypt'
    private readonly network: 'local' | 'mainnet'
    private readonly getWif: () => string
    private readonly instances = new Map<number, LMSRMarket>()
    private _signer?: Signer
    private loaded = false

    constructor(network: 'local' | 'mainnet' = 'local', getWif: () => string = () => '') {
        this.network = network
        this.getWif = getWif
    }

    private async ready(): Promise<void> {
        if (!this.loaded) { LMSRMarket.loadArtifact(lmsrArtifact as never); this.loaded = true }
    }
    private signer(): Signer {
        if (!this._signer) {
            if (this.network === 'mainnet') {
                // FeeProvider forces an adequate fee rate (the WoC default is too low for 26 KB txs to confirm).
                this._signer = new TestWallet(bsv.PrivateKey.fromWIF(this.getWif()), new FeeProvider({ network: bsv.Networks.mainnet }))
            } else {
                this._signer = new TestWallet(bsv.PrivateKey.fromRandom(bsv.Networks.testnet), new DummyProvider())
            }
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

    // ── authorizeAndBroadcast (the only key use / broadcast) ──────────────────────────────────────────────
    async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
        await this.ready()
        const kind = (plan.build as { kind: string }).kind
        if (kind === 'deploy') return this.execDeploy(plan.build as DeployBuild)
        if (kind === 'buy') return this.execBuy(plan.build as BuyBuild)
        if (kind === 'sell') return this.execSell(plan.build as SellBuild)
        if (kind === 'resolve') return this.execResolve(plan.build as ResolveBuild)
        if (kind === 'redeem') return this.execRedeem(plan.build as RedeemBuild)
        throw new Error(`sCrypt engine: unknown plan kind '${kind}'`)
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
            const tokenScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(buyerArg))
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

    private async execRedeem(b: RedeemBuild): Promise<BroadcastResult> {
        const current = this.instances.get(b.marketId)
        if (!current) throw new Error(`sCrypt engine: no live pool for market ${b.marketId}`)
        const supply = BigInt(b.supply)
        const winner = await this.selfPkh()
        const isYes = b.side === 'yes'
        let captured!: LMSRMarket
        // Slimmed contract (CONC-004): single side-parameterized `redeem(isYes, supply, winner)`.
        current.bindTxBuilder('redeem', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>, isYesArg: boolean, supplyArg: bigint, winnerArg: PubKeyHash): Promise<ContractTransaction> => {
            const next = cur.next()
            next.collateral = cur.collateral - supplyArg * cur.payoutUnit
            const payoutScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(winnerArg))
            const tx = new bsv.Transaction().addInput(cur.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: payoutScript, satoshis: Number(supplyArg * cur.payoutUnit) }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(500) // 0.5 sat/B — confirm-worthy
            if (options.changeAddress) tx.change(options.changeAddress)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })
        const res = await current.methods.redeem(isYes, supply, winner, { changeAddress: await this.signer().getDefaultAddress() } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, captured)
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex() }
    }
}
