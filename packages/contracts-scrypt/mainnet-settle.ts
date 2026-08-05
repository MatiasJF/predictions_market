// CONC-002 — the GATED mainnet SETTLEMENT proof: deploy a pool, then settle a whole batch of off-chain fills
// (net 3 YES + 2 NO) into ONE on-chain pool-version tx. Proves N trades cost ONE fee. Runs the daemon's real
// ScryptEngine path (buildDeploy → authorizeAndBroadcast, then buildSettleBatch → authorizeAndBroadcast). Deploy
// and settle share the in-process pool instance (a 0-conf chain in one run). Funding WIF from repo-root .env,
// read only here, never logged. Run: `npx ts-node mainnet-settle.ts --broadcast` (no flag = balance check only).
import { readFileSync } from 'fs'
import { join } from 'path'
import { ScryptEngine } from './src/scryptEngine'

function fundingWif(): string {
    const env = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    const m = env.match(/^PM_FUNDING_WIF=(.+)$/m)
    if (!m) throw new Error('no PM_FUNDING_WIF in repo-root .env')
    return m[1]!.trim().replace(/^["']|["']$/g, '')
}

const WAD = 10n ** 18n
const COLLATERAL = 1_000_000_000n // matches ScryptEngine's pool collateral STATE (not real sats)

async function main() {
    const broadcast = process.argv.includes('--broadcast')
    const V = JSON.parse(readFileSync(join(__dirname, 'tests', 'fixtures', 'vectors.json'), 'utf8'))
    const eng = new ScryptEngine('mainnet', fundingWif)

    const address = await eng.fundingAddress()
    console.log('funding address:', address)

    if (!broadcast) {
        console.log('\n[DRY] pass --broadcast to deploy + settle on mainnet. Est. cost: fees only (~30 KB deploy +')
        console.log('      ~60 KB settle @ 500 sat/KB ≈ 45k sats). Pool sats = dust(1); collateral is STATE.')
        return
    }

    const cfg = {
        marketId: 991,
        bUnits: 10n,
        payoutUnit: 100_000n,
        mult: BigInt(V.mult),
        invMult: BigInt(V.invMult),
    }

    console.log('\n=== BROADCAST 1/2: DEPLOY pool ===')
    const deployPlan = await eng.buildDeploy(cfg, 1)
    const deployRes = await eng.authorizeAndBroadcast(deployPlan)
    console.log('  deploy txid:', deployRes.txid)

    // A batch of 5 off-chain fills (net 3 YES buys + 2 NO buys). netCollateralSats is the batch's net cash
    // (MVP: the contract bounds solvency, not exact cash). orderIds/fills are for the DB effect only.
    const poolRef = {
        txid: deployRes.txid, vout: 0, satoshis: 1, lockingScript: deployRes.poolLockingScript,
        state: { eYes: WAD, eNo: WAD, qYes: 0n, qNo: 0n, collateral: COLLATERAL, resolved: 0n, winner: 0n },
    }
    const batch = {
        netYesUnits: 3n, netNoUnits: 2n, netCollateralSats: 250,
        orderIds: [1, 2, 3, 4, 5],
        fills: [1, 2, 3, 4, 5].map((i) => ({
            trader: 'aa'.repeat(33), side: (i <= 3 ? 'yes' : 'no') as 'yes' | 'no',
            action: 'buy' as const, shares: WAD.toString(), costSats: 50,
        })),
        batchDigest: 'ab'.repeat(32), // CONC-003a commitment (placeholder for this synthetic demo batch)
    }

    console.log('\n=== BROADCAST 2/2: SETTLE batch of 5 fills (net YES 3, NO 2) in ONE tx ===')
    const settlePlan = await eng.buildSettleBatch(cfg, poolRef, batch)
    const settleRes = await eng.authorizeAndBroadcast(settlePlan)
    console.log('  settle txid:', settleRes.txid)

    console.log('\nDONE:')
    console.log('  deploy:', deployRes.txid)
    console.log('  settle:', settleRes.txid, '(5 off-chain fills → 1 on-chain pool-version advance)')
}

main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
})
