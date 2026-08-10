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
/**
 * Fee rate in satoshis per 1000 bytes — the single biggest lever on this system's running cost, because the
 * covenant republishes the whole compiled contract on every spend.
 *
 * 100 sat/KB is what miners actually publish. Verified 2026-08-07 against both TAAL and GorillaPool ARC
 * `/v1/policy`: `miningFee: { bytes: 1000, satoshis: 100 }`. This was 500 for a while, which was an
 * over-correction: the original problem was that WhatsOnChain's provider default (~50 sat/KB) sits BELOW the
 * miner minimum, so those transactions were deprioritised and sat unconfirmed for 40+ minutes. The fix for
 * "below policy" is "at policy", not "5× policy" — that mistake cost ~4× the fee on two mainnet runs.
 *
 * Overridable with `PM_FEE_PER_KB` because it is policy, not consensus: if miners raise their minimum, or a
 * transaction sits unconfirmed longer than you like, raise this rather than editing code.
 *
 * WHERE IT TAKES EFFECT — this trips people up. The ONLY thing that sets a transaction's fee is the connected
 * provider's `getFeePerKb()` (below, `FeeProvider`). The `tx.feePerKb(...)` calls inside the custom tx builders
 * are **overridden by the framework afterwards and have no effect** — measured 2026-08-07 by running a local
 * journey with `PM_FEE_PER_KB=9999`: every stage still paid exactly 1.0 sat/KB, the offline provider's rate.
 * They are kept aligned to this constant only so nobody reads a stale number and believes it.
 *
 * Consequence: a `local` run canNOT show mainnet fees (its provider charges ~1 sat/KB), which is why
 * `apps/spike/src/measure-journey.ts` PROJECTS cost as size × rate rather than reading it back. That projection
 * was validated against the 2026-08-07 mainnet run to 0.03%.
 */
const FEE_PER_KB = (() => {
    const raw = process.env.PM_FEE_PER_KB
    const n = raw === undefined ? 100 : Number(raw)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`PM_FEE_PER_KB must be a positive number, got '${raw}'`)
    return n
})()

/**
 * Forces an explicit fee rate. sCrypt derives every transaction's fee from the provider's `getFeePerKb()`, and
 * WhatsOnChain's default (~50 sat/KB) is BELOW the published miner minimum, so those transactions were
 * deprioritised and sat unconfirmed for 40+ minutes. This is the one place the rate is decided — see FEE_PER_KB.
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
    /** Offline stand-in for the chain: remember what we "broadcast" so getTransaction can serve it back. */
    private readonly sent = new Map<string, bsv.Transaction>()
    override async sendTransaction(tx: bsv.Transaction): Promise<string> {
        this.sent.set(tx.id, tx)
        return tx.id
    }
    override async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.sent.get(txid)
        if (!tx) throw new Error(`LocalProvider: tx ${txid} not in the offline set (no chain to fetch from)`)
        return tx
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
    token?: { vout: number; satoshis: number; script: string; holderPkh: string; shares: string; side: Side; burned?: boolean }
    settle?: { orderIds: number[]; netYesUnits: string; netNoUnits: string; netCollateralSats: number; trades: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }[]; batchDigest?: string; attestationSig?: string; attestationPubkey?: string }
    payouts?: { digest: string; winners: { trader: string; pkh: string; shares: string; sats: number }[] }
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
interface BroadcastResult { txid: string; poolLockingScript: string; sizeBytes?: number; feeSats?: number }

export class EngineLimitation extends Error {
    constructor(public readonly kind: string, public readonly pointer: string) {
        super(`engine '${kind}' unsupported: ${pointer}`)
        this.name = 'EngineLimitation'
    }
}

const ceilDiv = (a: bigint, d: bigint): bigint => (a + d - 1n) / d

/**
 * base^exp, WAD-scaled, by square-and-multiply — a MIRROR of `@pm/lmsr`'s `powFixed` and of the on-chain
 * `settle` loop (contracts-scrypt is npm-isolated and cannot import @pm/lmsr; the equality is enforced by the
 * shared vectors in tests/fixtures). The operation order and truncation are consensus-critical (CONC-006).
 */
const MAX_NET = 4095n
const MAX_PAYOUTS = 8 // mirrors LMSRMarket.MAX_PAYOUTS (the bounded output loop)
function powFixed(base: bigint, exp: bigint): bigint {
    if (exp < 0n || exp > MAX_NET) throw new Error(`powFixed: exp must be 0..${MAX_NET}`)
    let factor = WAD
    let b = base
    let e = exp
    for (let i = 0; i < 12; i++) {
        const half = e / 2n
        if (e - half * 2n === 1n) factor = (factor * b) / WAD
        b = (b * b) / WAD
        e = half
    }
    return factor
}
const marketTagHex = (marketId: number): string => marketId.toString(16).padStart(8, '0') // 4-byte tag
const poolEffect = (s: PoolState): TxEffects['pool'] => ({
    vout: 0, satoshis: POOL_SATS,
    eYes: s.eYes.toString(), eNo: s.eNo.toString(), qYes: s.qYes.toString(), qNo: s.qNo.toString(),
    collateral: s.collateral.toString(), resolved: s.resolved === 1n ? 1 : 0, winner: s.winner === 1n ? 1 : 0,
    lockingScript: '',
})

/**
 * The pool UTXO a plan spends (CONC-005). Carried inside every build descriptor — and therefore persisted in
 * `broadcasts.plan` — so a plan enqueued before a daemon restart is still executable after one: the locking
 * script IS the contract state, so `LMSRMarket.fromUTXO` rebuilds the live instance with no network call and
 * no extra storage. Public data only.
 */
interface PoolUtxoRef { txid: string; vout: number; satoshis: number; lockingScript: string }

/** The token identity as the DB stores it (no ~30 KB backtrace pieces — those are re-derived from the chain). */
interface PersistedToken { txid: string; vout: number; satoshis: number; script: string; holderPkh: string; shares: string; side: Side }

interface DeployBuild { kind: 'deploy'; marketId: number; cfg: { mult: string; invMult: string; payoutUnit: string } }
interface BuyBuild { kind: 'buy'; marketId: number; side: Side; charge: string; pool: PoolUtxoRef }
interface SellBuild { kind: 'sell'; marketId: number; side: Side; pool: PoolUtxoRef }
interface ResolveBuild { kind: 'resolve'; marketId: number; outcome: Side; pool: PoolUtxoRef }
interface RedeemBuild { kind: 'redeem'; marketId: number; side: Side; supply: string; pool: PoolUtxoRef; token?: TokenRef }
interface SettleBuild { kind: 'settle'; marketId: number; netYesUnits: string; netNoUnits: string; netCollateralSats: number; batchDigest: string; pool: PoolUtxoRef }
interface WinnerPayoutRef { trader: string; pkh: string; shares: string; sats: number }
interface PayoutBuild { kind: 'payout'; marketId: number; winners: WinnerPayoutRef[]; digest: string; pool: PoolUtxoRef }

/**
 * A minted position token (CONC-003c). The identity fields are small enough to persist; the three backtrace
 * pieces are ~30 KB so they are DERIVED (from the mint tx) rather than stored — absent after a restart, when
 * `liveToken` re-fetches the mint tx and re-splits it (CONC-005).
 */
interface TokenRef {
    txid: string        // mint txid, display order
    vout: number        // always 1 (buy emits pool, token, change)
    satoshis: number
    script: string      // the data+P2PKH token locking script (hex)
    holderPkh: string
    supply: bigint
    isYes: boolean
    prevHeader?: string // version ‖ varint(nIn) ‖ inputs ‖ varint(nOut)
    poolOut?: string    // serialized output 0 (exactly ONE output ⇒ the token is output index 1)
    prevTail?: string   // serialized outputs 2.. ‖ nLockTime
}

/**
 * Split a mint tx into the three backtrace pieces so that
 * `hash256(prevHeader ‖ poolOut ‖ tokenOutput ‖ prevTail)` reproduces its txid — exactly what the pool's
 * `redeem` recomputes on-chain. Throws if the reconstruction doesn't match (defensive: never hand the contract
 * pieces that cannot verify).
 */
export function splitMintTx(tx: bsv.Transaction, tokenVout: number): { prevHeader: string; poolOut: string; prevTail: string } {
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
        this.ensureArtifact()
    }
    /**
     * Load the compiled artifact. Synchronous, and separate from `ready()`, because a SYNC caller needs it too
     * — see `poolSpendable`, where its absence marked a perfectly good pool as unspendable.
     */
    private ensureArtifact(): void {
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
    /**
     * The read-only chain provider. Held separately from the signer because reads MUST NOT go through the
     * wallet: `TestWallet.listUnspent()` is not a query — with `splitFeeTx` on (the default) it delegates to
     * `CacheableUtxoManager.fetchUtxos(0)`, whose first line is `availableUtxos.splice(0)`. It DRAINS the
     * wallet's funding cache and hands the entries to the caller. A polled balance view therefore empties the
     * wallet, and the next spend dies with "no sufficient utxos". Reads go here; only spends touch the signer.
     */
    private _provider?: DefaultProvider | LocalProvider
    private provider(): DefaultProvider | LocalProvider {
        if (!this._provider) {
            // FeeProvider forces an adequate fee rate (the WoC default is too low for large pool txs to confirm).
            this._provider = this.network === 'mainnet'
                ? new FeeProvider({ network: bsv.Networks.mainnet })
                : new LocalProvider()
        }
        return this._provider
    }
    private signer(): Signer {
        if (!this._signer) {
            this._signer = new TestWallet(this.priv(), this.provider() as never)
        }
        return this._signer
    }
    /**
     * The market's live pool instance (CONC-005 — restart safety). Prefers the warm in-process instance; if the
     * process restarted, rebuilds it from the plan's pool UTXO — the locking script encodes every @prop, so this
     * is a full recovery with no network call. Verified: `fromUTXO` restores all mutable state AND the
     * constructor consts, and the rebuilt instance can produce a continuation.
     */
    private async livePool(marketId: number, ref?: PoolUtxoRef): Promise<LMSRMarket> {
        const warm = this.instances.get(marketId)
        if (warm) return warm
        if (!ref || !ref.lockingScript) {
            throw new Error(`sCrypt engine: no live pool for market ${marketId} and no pool ref to rebuild from`)
        }
        let inst: LMSRMarket
        try {
            inst = LMSRMarket.fromUTXO({
                txId: ref.txid, outputIndex: ref.vout, script: ref.lockingScript, satoshis: ref.satoshis,
            })
        } catch (e) {
            // The locking script IS the compiled contract, so a pool deployed by an older build cannot be spent
            // by this one. sCrypt reports that as "the raw script cannot match the ASM template", which tells a
            // human nothing. Say what actually happened and what can be done about it.
            const why = e instanceof Error ? e.message : String(e)
            if (/ASM template/i.test(why)) {
                throw new Error(
                    `market ${marketId}: this pool was deployed by a DIFFERENT build of the LMSRMarket contract ` +
                    `(${ref.lockingScript.length / 2} B on chain vs ${LMSRMarket.getArtifact().hex.length / 2} B compiled now), ` +
                    `so this build cannot spend it — the locking script no longer matches the compiled artifact. ` +
                    `Deploy a fresh market with the current build; the old pool's funds are only spendable by the ` +
                    `build that created it. (Original: ${why})`,
                )
            }
            throw e
        }
        await inst.connect(this.signer())
        this.instances.set(marketId, inst)
        return inst
    }

    /**
     * Can this build spend that pool? Pure CPU (script-vs-template match, no network), but `/markets` is polled
     * every couple of seconds, so the verdict is cached per UTXO.
     *
     * MAINNET-009 — two bugs lived here, and together they condemned a healthy pool on mainnet (2026-08-10,
     * market #7, `9798adff…`):
     *
     *   1. The artifact was only loaded by `ready()`, which every *build* path awaits and this one does not.
     *      `/markets` is polled the instant the app opens, so on a fresh daemon this ran first and
     *      `fromUTXO` threw "No artifact found" — nothing to do with the pool at all.
     *   2. That answer was then CACHED. One unlucky ordering and the market was declared unspendable for the
     *      lifetime of the process, with the console disabling settle, resolve and payout on a pool that was
     *      perfectly fine. Restarting the daemon — the obvious remedy — reproduced it every time.
     *
     * So: load the artifact first, and only ever cache a verdict reached with one loaded. A cache is for
     * answers, not for accidents.
     */
    private readonly spendableCache = new Map<string, boolean>()
    poolSpendable(pool: PoolRef): boolean {
        if (!pool.lockingScript) return false
        const key = `${pool.txid}:${pool.vout}`
        const hit = this.spendableCache.get(key)
        if (hit !== undefined) return hit
        try {
            this.ensureArtifact()
        } catch {
            return false // cannot judge without the compiled contract — say no, but do not remember saying it
        }
        let ok = true
        try {
            LMSRMarket.fromUTXO({
                txId: pool.txid, outputIndex: pool.vout, script: pool.lockingScript, satoshis: pool.satoshis,
            })
        } catch {
            ok = false
        }
        this.spendableCache.set(key, ok)
        return ok
    }

    private poolRefOf(pool: PoolRef): PoolUtxoRef {
        return { txid: pool.txid, vout: pool.vout, satoshis: pool.satoshis, lockingScript: pool.lockingScript }
    }

    /**
     * The market's minted position token (CONC-005). Prefers the warm in-process ref. After a restart the plan
     * carries the token's identity (txid/vout/script/holder/supply/side) but NOT the mint tx's backtrace pieces —
     * those are ~30 KB, so instead of storing them we re-derive them from the chain: fetch the mint tx by txid
     * and re-split it with the same verified `splitMintTx`. Chain is the source of truth.
     */
    private async liveToken(marketId: number, ref?: TokenRef): Promise<TokenRef | undefined> {
        const warm = this.tokens.get(marketId)
        if (warm) return warm
        if (!ref) return undefined
        if (ref.prevHeader && ref.poolOut) return ref // already complete
        const mint = await this.signer().provider!.getTransaction(ref.txid)
        const { prevHeader, poolOut, prevTail } = splitMintTx(mint as unknown as bsv.Transaction, ref.vout)
        const full: TokenRef = { ...ref, prevHeader, poolOut, prevTail }
        this.tokens.set(marketId, full)
        return full
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
    /**
     * The funding wallet's spendable UTXOs. sCrypt auto-funds internally, so this exists purely for the
     * wallet-balance view — but that view is what an operator checks BEFORE authorizing a mainnet spend, so
     * returning a stubbed empty list (as this did) reports a real, funded wallet as EMPTY. Offline there is no
     * chain to ask, so `local` legitimately has none.
     */
    async getUtxos(address: string): Promise<{ txid: string; outputIndex: number; satoshis: number; script: string }[]> {
        if (this.network !== 'mainnet') return []
        // Straight to the provider — see provider() for why this must never go through the signer.
        const utxos = await this.provider().listUnspent(bsv.Address.fromString(address))
        return utxos.map((u) => ({ txid: u.txId, outputIndex: u.outputIndex, satoshis: u.satoshis, script: u.script }))
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
        const build: BuyBuild = { kind: 'buy', marketId: cfg.marketId, side, charge: charge.toString(), pool: this.poolRefOf(pool) }
        // The minted token is surfaced as an effect so the service can PERSIST it (CONC-005) — the txid is
        // filled in from the broadcast result, exactly like the pool.
        const tokenScript = '21' + marketTagHex(cfg.marketId) + (side === 'yes' ? '01' : '00') +
            int2ByteString(1n, 8n) + (await this.selfPkh()) + '75' + Utils.buildPublicKeyHashScript(await this.selfPkh())
        return {
            kind: 'buy', summary: `buy 1 ${side.toUpperCase()} + mint token → charge ${charge} sat`, spendSats: 100, build,
            effects: {
                pool: poolEffect(s), spendsPrevPool: true,
                trade: { side, action: 'buy', shares: WAD.toString(), costSats: Number(charge) },
                token: { vout: 1, satoshis: TOKEN_SATS, script: tokenScript, holderPkh: await this.selfPkh(), shares: WAD.toString(), side },
                marketState: 'trading',
            },
        }
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
        const build: SellBuild = { kind: 'sell', marketId: cfg.marketId, side, pool: this.poolRefOf(pool) }
        return { kind: 'sell', summary: `sell 1 ${side.toUpperCase()} → proceeds ${proceeds} sat`, spendSats: 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true, trade: { side, action: 'sell', shares: WAD.toString(), costSats: Number(proceeds) }, marketState: 'trading' } }
    }

    async buildResolve(cfg: MarketConfig, pool: PoolRef, outcome: Side): Promise<TxPlan> {
        const s: PoolState = { ...pool.state, resolved: 1n, winner: outcome === 'yes' ? 1n : 0n }
        const build: ResolveBuild = { kind: 'resolve', marketId: cfg.marketId, outcome, pool: this.poolRefOf(pool) }
        return { kind: 'resolve', summary: `resolve ${outcome.toUpperCase()} (Rabin oracle)`, spendSats: 100, build, effects: { pool: poolEffect(s), spendsPrevPool: true, marketState: 'resolved', resolution: outcome } }
    }

    /**
     * `token` (optional) is the PERSISTED token identity the service read back from the DB — it makes redeem
     * survive a restart (CONC-005). When omitted, the warm in-process ref is used. Either way the backtrace
     * pieces are re-derived from the mint tx at authorize time.
     */
    async buildRedeem(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint, token?: PersistedToken): Promise<TxPlan> {
        if (pool.state.resolved !== 1n) throw new Error('market not resolved')
        const payout = shares * cfg.payoutUnit
        const s: PoolState = { ...pool.state, collateral: pool.state.collateral - payout }
        const ref: TokenRef | undefined = this.tokens.get(cfg.marketId) ?? (token
            ? { txid: token.txid, vout: token.vout, satoshis: token.satoshis, script: token.script, holderPkh: token.holderPkh, supply: BigInt(token.shares) / WAD, isYes: token.side === 'yes' }
            : undefined)
        const build: RedeemBuild = { kind: 'redeem', marketId: cfg.marketId, side, supply: shares.toString(), pool: this.poolRefOf(pool), token: ref }
        return {
            kind: 'redeem', summary: `redeem ${shares} ${side.toUpperCase()} → pay winner ${payout} sat`,
            spendSats: Number(payout) + 100, build,
            effects: {
                pool: poolEffect(s), spendsPrevPool: true,
                ...(ref ? { token: { vout: ref.vout, satoshis: ref.satoshis, script: ref.script, holderPkh: ref.holderPkh, shares: (ref.supply * WAD).toString(), side, burned: true } } : {}),
            },
        }
    }

    async buildSettleBatch(cfg: MarketConfig, pool: PoolRef, batch: SettleBatch): Promise<TxPlan> {
        // Net-state advance (CONC-002/006): the settled state = pool advanced by the batch's NET units, computed
        // the SAME way the contract does (square-and-multiply), so it matches by construction.
        const WADc = WAD
        const stepE = (e0: bigint, net: bigint): bigint => {
            const n = net < 0n ? -net : net
            const factor = powFixed(net >= 0n ? cfg.mult : cfg.invMult, n)
            return (e0 * factor) / WADc
        }
        const eYes = stepE(pool.state.eYes, batch.netYesUnits)
        const eNo = stepE(pool.state.eNo, batch.netNoUnits)
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
            pool: this.poolRefOf(pool),
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

    /**
     * PAYOUT (PAYOUT-001) — pay every winner of a resolved market in ONE tx, closing the receipt→payout bridge.
     * The winner list comes from the audited receipts; the contract enforces resolution, solvency and the exact
     * collateral decrement, and the digest is pinned on-chain so the list is auditable + slashable.
     */
    async buildPayout(cfg: MarketConfig, pool: PoolRef, winners: WinnerPayoutRef[], digest: string): Promise<TxPlan> {
        if (pool.state.resolved !== 1n) throw new Error('market not resolved')
        if (winners.length === 0) throw new Error('no winners to pay')
        if (winners.length > MAX_PAYOUTS) {
            throw new EngineLimitation('payout', `at most ${MAX_PAYOUTS} winners per payout tx (split across several)`)
        }
        const total = winners.reduce((s, w) => s + w.sats, 0)
        if (BigInt(total) > pool.state.collateral) throw new Error('payout exceeds pool collateral')
        const s: PoolState = { ...pool.state, collateral: pool.state.collateral - BigInt(total) }
        const build: PayoutBuild = { kind: 'payout', marketId: cfg.marketId, winners, digest, pool: this.poolRefOf(pool) }
        return {
            kind: 'payout',
            summary: `pay ${winners.length} winner(s) ${total} sat total`,
            spendSats: total + 200, build,
            effects: {
                pool: poolEffect(s), spendsPrevPool: true,
                payouts: { digest, winners },
            },
        }
    }

    private async execPayout(b: PayoutBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool)
        const address = await this.signer().getDefaultAddress()
        const total = b.winners.reduce((s, w) => s + w.sats, 0)
        const digest = toByteString(b.digest)

        // Pad the fixed-size arrays the contract expects (unused slots are skipped by `count`).
        const winners = new Array(MAX_PAYOUTS).fill(PubKeyHash(toByteString('00'.repeat(20))))
        const amounts = new Array(MAX_PAYOUTS).fill(0n)
        b.winners.forEach((w, i) => {
            winners[i] = PubKeyHash(toByteString(w.pkh))
            amounts[i] = BigInt(w.sats)
        })

        let captured!: LMSRMarket
        current.bindTxBuilder('payout', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
            const next = cur.next()
            next.collateral = cur.collateral - BigInt(total)
            next.paid = 1n // must mirror the contract's own state change, or hashOutputs won't match
            const tx = new bsv.Transaction().addInput(cur.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(Utils.buildOpreturnScript(digest)), satoshis: 0 }))
            for (const w of b.winners) {
                tx.addOutput(new bsv.Transaction.Output({
                    script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(PubKeyHash(toByteString(w.pkh)))),
                    satoshis: w.sats,
                }))
            }
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(FEE_PER_KB)
            if (options.changeAddress) tx.change(options.changeAddress)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })

        const res = await current.methods.payout(winners, amounts, BigInt(b.winners.length), digest, {
            changeAddress: address,
        } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, captured)
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex(), ...this.cost(res.tx) }
    }

    /** Size + fee of a broadcast tx. Fee = inputs − outputs; the covenant makes size the dominant cost. */
    private cost(tx: bsv.Transaction): { sizeBytes: number; feeSats: number } {
        let feeSats = 0
        try {
            feeSats = (tx as unknown as { getFee: () => number }).getFee()
        } catch {
            feeSats = 0
        }
        return { sizeBytes: (tx as unknown as { toBuffer: () => Buffer }).toBuffer().length, feeSats }
    }

    // ── authorizeAndBroadcast (the only key use / broadcast) ──────────────────────────────────────────────
    async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
        await this.ready()
        const kind = (plan.build as { kind: string }).kind
        try {
            if (kind === 'deploy') return await this.execDeploy(plan.build as DeployBuild)
            if (kind === 'buy') return await this.execBuy(plan.build as BuyBuild)
            if (kind === 'sell') return await this.execSell(plan.build as SellBuild)
            if (kind === 'resolve') return await this.execResolve(plan.build as ResolveBuild)
            if (kind === 'redeem') return await this.execRedeem(plan.build as RedeemBuild)
            if (kind === 'settle') return await this.execSettle(plan.build as SettleBuild)
            if (kind === 'payout') return await this.execPayout(plan.build as PayoutBuild)
            throw new Error(`sCrypt engine: unknown plan kind '${kind}'`)
        } catch (e) {
            // A failed broadcast leaves the wallet's funding cache MISSING the utxos it had already claimed for
            // the attempt — sCrypt removes them when it funds and restores them only on success. Without this,
            // one failure poisons every later spend in the process with "no sufficient utxos". Drop the wallet so
            // the next attempt re-reads the chain, and drop the warm contract instances bound to it: CONC-005
            // rebuilds those from the plan's pool UTXO with no network call, which is exactly this situation.
            this._signer = undefined
            this._provider = undefined
            this.instances.clear()
            throw e
        }
    }

    private async execSettle(b: SettleBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool) // CONC-005: rebuild after a restart
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
            // Square-and-multiply — the identical routine the contract runs (CONC-006).
            next.eYes = (cur.eYes * powFixed(yBuy ? cur.mult : cur.invMult, yAbs)) / cur.scale
            next.eNo = (cur.eNo * powFixed(nBuy ? cur.mult : cur.invMult, nAbs)) / cur.scale
            next.qYes = cur.qYes + netYes * cur.unit
            next.qNo = cur.qNo + netNo * cur.unit
            next.collateral = colUp ? cur.collateral + colAbs : cur.collateral - colAbs
            const opret = bsv.Script.fromHex(Utils.buildOpreturnScript(digest))
            const tx = new bsv.Transaction().addInput(cur.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
                .addOutput(new bsv.Transaction.Output({ script: opret, satoshis: 0 }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(FEE_PER_KB)
            if (options.changeAddress) tx.change(options.changeAddress)
            captured = next
            return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
        })
        const res = await current.methods.settle(yAbs, yBuy, nAbs, nBuy, colAbs, colUp, digest, {
            changeAddress: await this.signer().getDefaultAddress(),
        } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, captured)
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex(), ...this.cost(res.tx) }
    }

    private async execDeploy(b: DeployBuild): Promise<BroadcastResult> {
        const pool = this.freshPool({ marketId: b.marketId, bUnits: 0n, payoutUnit: BigInt(b.cfg.payoutUnit), mult: BigInt(b.cfg.mult), invMult: BigInt(b.cfg.invMult) })
        await pool.connect(this.signer())
        const tx = await pool.deploy(POOL_SATS)
        this.instances.set(b.marketId, pool)
        return { txid: tx.id, poolLockingScript: pool.lockingScript.toHex(), ...this.cost(tx) }
    }

    private async execBuy(b: BuyBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool) // CONC-005: rebuild after a restart
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
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(FEE_PER_KB)
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
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex(), ...this.cost(res.tx) }
    }

    private async execSell(b: SellBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool) // CONC-005: rebuild after a restart
        const next = current.next()
        if (b.side === 'yes') { next.eYes = (current.eYes * current.invMult) / current.scale; next.qYes = current.qYes - current.unit }
        else { next.eNo = (current.eNo * current.invMult) / current.scale; next.qNo = current.qNo - current.unit }
        const newE = b.side === 'yes' ? next.eYes : next.eNo
        next.collateral = current.collateral - (newE * current.payoutUnit) / (next.eYes + next.eNo)
        // Slimmed contract (CONC-004): single side-parameterized `sell(isYes)` (state-only continuation).
        const res = await current.methods.sell(b.side === 'yes', { next: { instance: next, balance: current.balance } } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, next)
        return { txid: res.tx.id, poolLockingScript: next.lockingScript.toHex(), ...this.cost(res.tx) }
    }

    private async execResolve(b: ResolveBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool) // CONC-005: rebuild after a restart
        const outcomeN = b.outcome === 'yes' ? 1n : 0n
        const next = current.next()
        next.resolved = 1n
        next.winner = outcomeN
        const sig = signOutcome(marketTagHex(b.marketId), outcomeN)
        const res = await current.methods.resolve(sig, outcomeN, { next: { instance: next, balance: current.balance } } as MethodCallOptions<LMSRMarket>)
        this.instances.set(b.marketId, next)
        return { txid: res.tx.id, poolLockingScript: next.lockingScript.toHex(), ...this.cost(res.tx) }
    }

    /**
     * REDEEM (CONC-003c) — co-spends the market's minted position token as input #1 and lets the pool BACKTRACE
     * it on-chain. Inputs are added explicitly (pool, token, funding) so `allOutpoints` is deterministic and
     * matches `hashPrevouts`; the token + funding P2PKH inputs are signed here with the funding key (the token
     * holder is this engine's own address). `autoPayFee: false` keeps the framework from appending inputs after
     * the covenant has committed to the outpoint set.
     */
    private async execRedeem(b: RedeemBuild): Promise<BroadcastResult> {
        const current = await this.livePool(b.marketId, b.pool) // CONC-005: rebuild after a restart
        const token = await this.liveToken(b.marketId, b.token) // CONC-005: rebuild after a restart
        if (!token) {
            throw new EngineLimitation('redeem', 'no minted position token for this market — buy first (CONC-003c requires co-spending the real token)')
        }
        const isYes = b.side === 'yes'
        if (token.isYes !== isYes) throw new Error(`sCrypt engine: tracked token is ${token.isYes ? 'YES' : 'NO'}, not ${b.side.toUpperCase()}`)

        const priv = this.priv()
        const address = await this.signer().getDefaultAddress()
        const payout = token.supply * current.payoutUnit

        // Explicit funding input (the payout is real sats; the pool UTXO is dust).
        // NOTE: going through the signer here DRAINS the wallet's funding cache (see provider()). That is
        // tolerable only because this path claims a funding utxo to spend explicitly; never copy it for a read.
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
        return { txid: res.tx.id, poolLockingScript: captured.lockingScript.toHex(), ...this.cost(res.tx) }
    }
}
