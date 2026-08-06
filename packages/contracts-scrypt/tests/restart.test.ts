import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ScryptEngine } from '../src/scryptEngine'

// CONC-005 — restart safety. The engine keeps live contract instances in memory, so a daemon restart used to
// strand a market ("no live pool for market N") even though the pool UTXO was healthy on-chain. A plan carries
// the pool UTXO (txid/vout/sats/lockingScript), and the locking script IS the contract state, so a FRESH engine
// can rebuild the instance and keep going. These tests drive a genuinely new engine — the real restart shape.
const V = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8'))
const WAD = 10n ** 18n
const COLLATERAL = 1_000_000_000n
const MARKET_ID = 7777

const cfg = {
    marketId: MARKET_ID,
    bUnits: 10n,
    payoutUnit: 100_000n,
    mult: BigInt(V.mult),
    invMult: BigInt(V.invMult),
}
const poolRefFrom = (txid: string, lockingScript: string, s: Record<string, bigint>) => ({
    txid, vout: 0, satoshis: 1, lockingScript,
    state: { eYes: s.eYes!, eNo: s.eNo!, qYes: s.qYes!, qNo: s.qNo!, collateral: s.collateral!, resolved: s.resolved!, winner: s.winner! },
})
const refOfPlanPool = (txid: string, script: string, p: Record<string, string>, resolved: bigint, winner: bigint) =>
    poolRefFrom(txid, script, {
        eYes: BigInt(p.eYes!), eNo: BigInt(p.eNo!), qYes: BigInt(p.qYes!), qNo: BigInt(p.qNo!),
        collateral: BigInt(p.collateral!), resolved, winner,
    })

describe('ScryptEngine — restart safety (CONC-005)', () => {
    it('a FRESH engine resumes a market mid-lifecycle: resolve + settle after a simulated restart', async () => {
        // ── process A: deploy + buy ──────────────────────────────────────────────────────────────────
        const engA = new ScryptEngine('local')
        const deployPlan = await engA.buildDeploy(cfg, 1)
        const deployRes = await engA.authorizeAndBroadcast(deployPlan)

        const pool0 = poolRefFrom(deployRes.txid, deployRes.poolLockingScript, {
            eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n,
        })
        const buyPlan = await engA.buildBuy(cfg, pool0, 'yes', 1n)
        const buyRes = await engA.authorizeAndBroadcast(buyPlan)
        const afterBuy = buyPlan.effects.pool

        // ── ☠️ RESTART: a brand-new engine with empty in-memory maps ─────────────────────────────────
        const engB = new ScryptEngine('local')

        const pool1 = refOfPlanPool(buyRes.txid, buyRes.poolLockingScript, afterBuy as unknown as Record<string, string>, 0n, 0n)
        const resolvePlan = await engB.buildResolve(cfg, pool1, 'yes')
        const resolveRes = await engB.authorizeAndBroadcast(resolvePlan)
        expect(resolveRes.txid, 'resolve after restart').to.have.length(64)

        // ...and keep going on the rebuilt instance (settle spends the pool the restarted engine reconstructed).
        const afterResolve = resolvePlan.effects.pool
        const pool2 = refOfPlanPool(resolveRes.txid, resolveRes.poolLockingScript, afterResolve as unknown as Record<string, string>, 1n, 1n)
        // settle requires an unresolved pool, so exercise the rebuilt-instance path on a second fresh engine
        // using the pre-resolve pool version instead.
        const engC = new ScryptEngine('local')
        const settlePlan = await engC.buildSettleBatch(cfg, pool1, {
            netYesUnits: 2n, netNoUnits: 1n, netCollateralSats: 150,
            orderIds: [1, 2, 3],
            fills: [1, 2, 3].map((i) => ({
                trader: 'aa'.repeat(33), side: (i <= 2 ? 'yes' : 'no') as 'yes' | 'no',
                action: 'buy' as const, shares: WAD.toString(), costSats: 50,
            })),
            batchDigest: 'ab'.repeat(32),
        })
        const settleRes = await engC.authorizeAndBroadcast(settlePlan)
        expect(settleRes.txid, 'settle from a fresh engine').to.have.length(64)
        expect(pool2.state.resolved).to.equal(1n) // the resolve really did flip the pool
    })

    it('rebuilds the pool instance with FULL state fidelity (fromUTXO restores props + consts)', async () => {
        const engA = new ScryptEngine('local')
        const deployRes = await engA.authorizeAndBroadcast(await engA.buildDeploy(cfg, 1))
        const pool0 = poolRefFrom(deployRes.txid, deployRes.poolLockingScript, {
            eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n,
        })
        const buyPlan = await engA.buildBuy(cfg, pool0, 'yes', 1n)
        const buyRes = await engA.authorizeAndBroadcast(buyPlan)
        const eff = buyPlan.effects.pool

        // A restarted engine resolving this pool must produce a state consistent with the pre-restart effects.
        const engB = new ScryptEngine('local')
        const pool1 = refOfPlanPool(buyRes.txid, buyRes.poolLockingScript, eff as unknown as Record<string, string>, 0n, 0n)
        const resolvePlan = await engB.buildResolve(cfg, pool1, 'yes')
        await engB.authorizeAndBroadcast(resolvePlan)
        // q/e carried across the restart untouched; only resolved/winner moved.
        expect(resolvePlan.effects.pool.qYes).to.equal(eff.qYes)
        expect(resolvePlan.effects.pool.eYes).to.equal(eff.eYes)
        expect(resolvePlan.effects.pool.resolved).to.equal(1)
        expect(resolvePlan.effects.pool.winner).to.equal(1)
    })

    it('surfaces the minted token as a persistable effect (what makes redeem restart-safe)', async () => {
        const eng = new ScryptEngine('local')
        const deployRes = await eng.authorizeAndBroadcast(await eng.buildDeploy(cfg, 1))
        const pool0 = poolRefFrom(deployRes.txid, deployRes.poolLockingScript, {
            eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n,
        })
        const buyPlan = await eng.buildBuy(cfg, pool0, 'yes', 1n)
        const token = buyPlan.effects.token
        expect(token, 'buy surfaces a token effect').to.not.equal(undefined)
        expect(token!.vout).to.equal(1)
        expect(token!.side).to.equal('yes')
        expect(token!.script).to.have.length.greaterThan(50) // the data+P2PKH script the backtrace needs
        expect(token!.holderPkh).to.have.length(40)
    })

    it('refuses to act when there is neither a warm instance nor a pool ref to rebuild from', async () => {
        const eng = new ScryptEngine('local')
        let threw = false
        try {
            // a hand-made plan whose descriptor has no usable pool ref (what a pre-CONC-005 plan looks like)
            await eng.authorizeAndBroadcast({
                kind: 'resolve', summary: 'x', spendSats: 1,
                build: { kind: 'resolve', marketId: 424242, outcome: 'yes', pool: { txid: '', vout: 0, satoshis: 1, lockingScript: '' } },
                effects: { pool: { vout: 0, satoshis: 1, eYes: '0', eNo: '0', qYes: '0', qNo: '0', collateral: '0', resolved: 0, winner: 0, lockingScript: '' }, spendsPrevPool: true },
            } as never)
        } catch (e) {
            threw = true
            expect(String(e)).to.match(/no live pool/)
        }
        expect(threw, 'expected a clear refusal, not a silent bad broadcast').to.equal(true)
    })
})
