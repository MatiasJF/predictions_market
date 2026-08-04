// SCRYPT-004 — the GATED mainnet lifecycle: deploy → buy+mint → resolve → redeem, all on BSV mainnet under
// sCrypt. Same runLifecycle() proven offline; only the signer differs (DefaultProvider mainnet + the funding
// WIF from the repo-root .env — read only here, never logged). Winner = our own address, so the payout returns
// to us (net cost ≈ fees). Run: `npx ts-node mainnet-lifecycle.ts --broadcast` (no flag = balance check only).
import { readFileSync } from 'fs'
import { join } from 'path'
import { bsv, DefaultProvider, TestWallet } from 'scrypt-ts'
import { runLifecycle } from './src/lifecycle'
import { oracleN, signOutcome } from './tests/utils/oracle'

function fundingWif(): string {
    const env = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    const m = env.match(/^PM_FUNDING_WIF=(.+)$/m)
    if (!m) throw new Error('no PM_FUNDING_WIF in repo-root .env')
    return m[1].trim().replace(/^["']|["']$/g, '')
}

async function main() {
    const broadcast = process.argv.includes('--broadcast')
    const V = JSON.parse(
        readFileSync(join(__dirname, 'tests', 'fixtures', 'vectors.json'), 'utf8')
    )
    const b = (s: string): bigint => BigInt(s)

    const priv = bsv.PrivateKey.fromWIF(fundingWif())
    const address = priv.toAddress()
    const pkh = bsv.crypto.Hash.sha256ripemd160(
        priv.publicKey.toBuffer()
    ).toString('hex')
    const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
    const signer = new TestWallet(priv, provider)

    console.log('funding address:', address.toString())
    await provider.connect()
    const bal = await provider.getBalance(address)
    console.log('balance:', bal.confirmed + bal.unconfirmed, 'sats')

    if (!broadcast) {
        console.log('\n[DRY] pass --broadcast to run the mainnet lifecycle. Est. cost: fees only (large sCrypt')
        console.log('      txs) + a payout that returns to this same address. payoutUnit=1000, pool dust=1.')
        return
    }

    console.log('\n=== BROADCASTING mainnet sCrypt lifecycle ===')
    const res = await runLifecycle(
        signer,
        {
            eYes: b(V.init.eYes), eNo: b(V.init.eNo), mult: b(V.mult), invMult: b(V.invMult), wad: b(V.WAD),
            payoutUnit: 1000n, collateral: 100_000n, oracleN, marketTag: 'a1b2c3d4',
            poolSats: 1, tokenSats: 1, winnerPkh: pkh, signOutcome,
        },
        (m) => console.log('  ' + m)
    )
    console.log('\nDONE:', JSON.stringify(res, null, 2))
}

main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
})
