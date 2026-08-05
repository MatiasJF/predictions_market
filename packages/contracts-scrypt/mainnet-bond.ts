// CONC-003b — GATED mainnet fraud-proof demo: deploy an operator Bond, then SLASH it with a real equivocation
// proof (two conflicting sequencer Rabin attestations for the same settlement key). Proves the enforcement
// primitive live: equivocation is punished on-chain. Funding WIF from repo-root .env, read only here, never
// logged. The slash pays the bond back to our own address (net cost ≈ fees). Run:
//   npx ts-node mainnet-bond.ts --broadcast   (no flag = balance check only)
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
    DefaultProvider,
    MethodCallOptions,
    PubKeyHash,
    TestWallet,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { Bond } from './src/contracts/bond'
import { attest, seqRabinPubKey } from './src/attestation'

function fundingWif(): string {
    const env = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    const m = env.match(/^PM_FUNDING_WIF=(.+)$/m)
    if (!m) throw new Error('no PM_FUNDING_WIF in repo-root .env')
    return m[1]!.trim().replace(/^["']|["']$/g, '')
}

class FeeProvider extends DefaultProvider {
    override async getFeePerKb(): Promise<number> {
        return 500 // 0.5 sat/B — confirm-worthy
    }
}

const BOND_SATS = 1000

async function main() {
    const broadcast = process.argv.includes('--broadcast')
    await Bond.loadArtifact()

    const priv = bsv.PrivateKey.fromWIF(fundingWif())
    const address = priv.toAddress()
    const pkh = bsv.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer()).toString('hex')
    const signer = new TestWallet(priv, new FeeProvider({ network: bsv.Networks.mainnet }))

    console.log('funding address:', address.toString())
    if (!broadcast) {
        console.log('\n[DRY] pass --broadcast to deploy a Bond and slash it with an equivocation proof on mainnet.')
        console.log('      Est. cost: fees only (Bond ~2.3 KB); the slashed bond returns to this address.')
        return
    }

    const operator = PubKeyHash(toByteString(pkh))
    const challenger = PubKeyHash(toByteString(pkh)) // slash pays back to us (demo)
    const matureAt = 2_000_000_000n // far-future CLTV → the bond can only be slashed here, not withdrawn

    console.log('\n=== BROADCAST 1/2: DEPLOY Bond ===')
    const bond = new Bond(seqRabinPubKey, operator, matureAt)
    await bond.connect(signer)
    const deployTx = await bond.deploy(BOND_SATS)
    console.log('  bond deploy txid:', deployTx.id)

    // A real equivocation: two sequencer Rabin attestations for the SAME settlement key, different digests.
    const attA = attest(991, 1, 'ab'.repeat(32))
    const attB = attest(991, 1, 'cd'.repeat(32))

    bond.bindTxBuilder(
        'slash',
        async (current: Bond, options: MethodCallOptions<Bond>): Promise<ContractTransaction> => {
            const script = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(challenger))
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(new bsv.Transaction.Output({ script, satoshis: current.balance }))
            ;(tx as unknown as { feePerKb: (n: number) => void }).feePerKb(500)
            if (options.changeAddress) tx.change(options.changeAddress)
            return { tx, atInputIndex: 0, nexts: [] }
        }
    )

    console.log('\n=== BROADCAST 2/2: SLASH the bond with the equivocation proof ===')
    const { tx } = await bond.methods.slash(
        attA.key,
        toByteString(attA.digest), attA.sig,
        toByteString(attB.digest), attB.sig,
        challenger,
        { changeAddress: address } as MethodCallOptions<Bond>
    )
    console.log('  slash txid:', tx.id)

    console.log('\nDONE:')
    console.log('  bond deploy:', deployTx.id)
    console.log('  slash:      ', tx.id, '(equivocation proven on-chain → bond paid to challenger)')
}

main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
})
