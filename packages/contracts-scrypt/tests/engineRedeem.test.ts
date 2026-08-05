import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ScryptEngine } from '../src/scryptEngine'

// CONC-003c engine integration: the ScryptEngine drives the FULL lifecycle including the backtrace-verified
// redeem — it tracks the token minted by buy, co-spends it as input #1, signs it, and hands the pool the
// backtrace pieces. Local network (DummyProvider) executes the REAL node Script ⇒ green here is mainnet-valid.
const V = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8'))
const WAD = 10n ** 18n
const COLLATERAL = 1_000_000_000n
const MARKET_ID = 4242

const cfg = {
    marketId: MARKET_ID,
    bUnits: 10n,
    payoutUnit: 100_000n,
    mult: BigInt(V.mult),
    invMult: BigInt(V.invMult),
}
const poolRefFrom = (txid: string, lockingScript: string, state: Record<string, bigint>) => ({
    txid, vout: 0, satoshis: 1, lockingScript,
    state: { eYes: state.eYes!, eNo: state.eNo!, qYes: state.qYes!, qNo: state.qNo!, collateral: state.collateral!, resolved: state.resolved!, winner: state.winner! },
})

describe('ScryptEngine — full lifecycle incl. backtrace redeem (CONC-003c)', () => {
    it('deploy → buy(mint) → resolve → redeem(co-spend + backtrace) all verify against real Script', async () => {
        const eng = new ScryptEngine('local')

        // DEPLOY
        const deployPlan = await eng.buildDeploy(cfg, 1)
        const deployRes = await eng.authorizeAndBroadcast(deployPlan)
        expect(deployRes.txid).to.have.length(64)

        // BUY YES (mints the data-carrying position token the redeem must co-spend)
        const pool0 = poolRefFrom(deployRes.txid, deployRes.poolLockingScript, {
            eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n,
        })
        const buyPlan = await eng.buildBuy(cfg, pool0, 'yes', 1n)
        const buyRes = await eng.authorizeAndBroadcast(buyPlan)
        expect(buyRes.txid).to.have.length(64)

        // RESOLVE YES
        const eff = buyPlan.effects.pool
        const pool1 = poolRefFrom(buyRes.txid, buyRes.poolLockingScript, {
            eYes: BigInt(eff.eYes), eNo: BigInt(eff.eNo), qYes: BigInt(eff.qYes), qNo: BigInt(eff.qNo),
            collateral: BigInt(eff.collateral), resolved: 0n, winner: 0n,
        })
        const resolvePlan = await eng.buildResolve(cfg, pool1, 'yes')
        const resolveRes = await eng.authorizeAndBroadcast(resolvePlan)
        expect(resolveRes.txid).to.have.length(64)

        // REDEEM — co-spends the minted token and proves it on-chain via the backtrace.
        const reff = resolvePlan.effects.pool
        const pool2 = poolRefFrom(resolveRes.txid, resolveRes.poolLockingScript, {
            eYes: BigInt(reff.eYes), eNo: BigInt(reff.eNo), qYes: BigInt(reff.qYes), qNo: BigInt(reff.qNo),
            collateral: BigInt(reff.collateral), resolved: 1n, winner: 1n,
        })
        const redeemPlan = await eng.buildRedeem(cfg, pool2, 'yes', 1n)
        const redeemRes = await eng.authorizeAndBroadcast(redeemPlan)
        expect(redeemRes.txid).to.have.length(64)
    })

    it('refuses to redeem without a tracked minted token (no token-less redeem)', async () => {
        const eng = new ScryptEngine('local')
        const deployPlan = await eng.buildDeploy(cfg, 1)
        const deployRes = await eng.authorizeAndBroadcast(deployPlan)
        const pool0 = poolRefFrom(deployRes.txid, deployRes.poolLockingScript, {
            eYes: WAD, eNo: WAD, qYes: WAD, qNo: 0n, collateral: COLLATERAL, resolved: 1n, winner: 1n,
        })
        const plan = await eng.buildRedeem(cfg, pool0, 'yes', 1n)
        let threw = false
        try {
            await eng.authorizeAndBroadcast(plan)
        } catch (e) {
            threw = true
            expect(String(e)).to.match(/no minted position token/)
        }
        expect(threw, 'expected the redeem to be refused').to.equal(true)
    })
})
