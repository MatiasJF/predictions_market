// CONC-003c — GATED mainnet proof of the HARDENED redeem: a redeem that co-spends a REAL on-chain position
// token and verifies it by backtrace, live on BSV. Funding WIF from repo-root .env, read only here, never logged.
//
// Three transactions (deliberately NOT the 4-tx lifecycle): the hardened pool script is ~33 KB, so each stateful
// spend is ~66 KB and a 4-tx chain (~230 KB) would blow BSV's ~101 KB unconfirmed-ancestor budget. Instead:
//   1. MINT   — a plain tx laying out out0 = one output, out1 = the data-carrying position token, out2 = change.
//               (The backtrace only requires that layout; it does not care that this isn't a `buy` tx.)
//   2. DEPLOY — a pool constructed ALREADY RESOLVED (winner = YES, 1 YES outstanding), so no buy/resolve chain.
//   3. REDEEM — spends pool #0 + token #1 + funding #2; the contract rebuilds the token output, derives the mint
//               txid and binds it via hashPrevouts. Paying out therefore REQUIRES the real token.
// Run: `npx ts-node mainnet-redeem.ts --broadcast` (no flag = balance check only).
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
    DefaultProvider,
    int2ByteString,
    MethodCallOptions,
    PubKeyHash,
    TestWallet,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { LMSRMarket } from './src/contracts/lmsrMarket'
import { splitMintTx } from './src/scryptEngine'
import { oracleN } from './src/oracle'

function fundingWif(): string {
    const env = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    const m = env.match(/^PM_FUNDING_WIF=(.+)$/m)
    if (!m) throw new Error('no PM_FUNDING_WIF in repo-root .env')
    return m[1]!.trim().replace(/^["']|["']$/g, '')
}

const FEE_PER_KB = 500
class FeeProvider extends DefaultProvider {
    override async getFeePerKb(): Promise<number> {
        return FEE_PER_KB
    }
}

const WAD = 10n ** 18n
const MARKET_TAG = 'a1b2c3d4'
const PAYOUT_UNIT = 100n // tiny payout — the winner is us
const COLLATERAL = 1_000_000n // pool STATE (not locked sats)
const TOKEN_SATS = 1
const POOL_SATS = 1

async function main() {
    const broadcast = process.argv.includes('--broadcast')
    const V = JSON.parse(readFileSync(join(__dirname, 'tests', 'fixtures', 'vectors.json'), 'utf8'))
    await LMSRMarket.loadArtifact()

    const priv = bsv.PrivateKey.fromWIF(fundingWif())
    const address = priv.toAddress()
    const pkh = bsv.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer()).toString('hex')
    const provider = new FeeProvider({ network: bsv.Networks.mainnet })
    const signer = new TestWallet(priv, provider)
    await provider.connect()

    console.log('funding address:', address.toString())
    if (!broadcast) {
        console.log('\n[DRY] pass --broadcast to run the hardened-redeem proof on mainnet (3 txs).')
        console.log('      Est. cost: fees only (~33 KB deploy + ~66 KB redeem @ 500 sat/KB ≈ 50k sats);')
        console.log('      the payout returns to this address.')
        return
    }

    // ── 1. MINT the position token (out0 = one output, out1 = token, out2 = change) ─────────────────────
    const holder = PubKeyHash(toByteString(pkh))
    const tokenScript =
        '21' + MARKET_TAG + '01' + int2ByteString(1n, 8n) + pkh + '75' + Utils.buildPublicKeyHashScript(holder)
    const utxos = await provider.listUnspent(address)
    if (utxos.length === 0) throw new Error('no funding UTXOs')
    // One largest UTXO only: WoC can still list outputs a previous run just spent, and every extra input is
    // another chance to hit txn-mempool-conflict (BUG-003). Everything after this chains in-process.
    const seed = [...(utxos as any[])].sort((a, b) => b.satoshis - a.satoshis)[0]
    console.log('  seed utxo:', seed.txId.slice(0, 16) + '…:' + seed.outputIndex, seed.satoshis, 'sat')

    console.log('\n=== BROADCAST 1/3: MINT the position token ===')
    const mintTx: any = new bsv.Transaction()
        .from([seed] as any)
        .addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(holder)), satoshis: 1 }))
        .addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(tokenScript), satoshis: TOKEN_SATS }))
        .change(address)
    mintTx.feePerKb(FEE_PER_KB)
    mintTx.sign(priv)
    await provider.sendTransaction(mintTx)
    console.log('  mint txid:', mintTx.id, `(token at vout 1, ${TOKEN_SATS} sat)`)

    const { prevHeader, poolOut, prevTail } = splitMintTx(mintTx, 1)

    // Chain the funding IN-PROCESS (BUG-003): WhatsOnChain keeps listing UTXOs we just spent, so each stage
    // spends the previous stage's change output explicitly rather than trusting the provider's UTXO set.
    const utxoOf = (tx: any, vout: number) => ({
        txId: tx.id, outputIndex: vout,
        script: tx.outputs[vout].script.toHex(), satoshis: tx.outputs[vout].satoshis,
    })

    // ── 2. DEPLOY a pool that is ALREADY RESOLVED (winner = YES, 1 YES outstanding) ─────────────────────
    console.log('\n=== BROADCAST 2/3: DEPLOY an already-resolved pool ===')
    const pool = new LMSRMarket(
        BigInt(V.init.eYes), BigInt(V.init.eNo), WAD, 0n, COLLATERAL, 1n, 1n,
        BigInt(V.mult), BigInt(V.invMult), PAYOUT_UNIT, WAD, WAD, oracleN, toByteString(MARKET_TAG)
    )
    await pool.connect(signer)
    ;(pool as any).buildDeployTransaction = async (_u: unknown, amount: number, changeAddr: any) => {
        const tx: any = new bsv.Transaction()
            .from([utxoOf(mintTx, 2)] as any) // the mint's change — not a (stale) provider lookup
            .addOutput(new bsv.Transaction.Output({ script: pool.lockingScript, satoshis: amount }))
        tx.feePerKb(FEE_PER_KB)
        tx.change(changeAddr ?? address)
        return tx
    }
    const deployTx: any = await pool.deploy(POOL_SATS)
    console.log('  pool deploy txid:', deployTx.id)

    // ── 3. REDEEM — co-spend the token; the pool backtraces it on-chain ────────────────────────────────
    const payout = 1n * PAYOUT_UNIT
    const funding = utxoOf(deployTx, 1) // the deploy's change
    if (funding.satoshis < Number(payout) + 60_000) {
        throw new Error(`deploy change ${funding.satoshis} sat is too small to fund the redeem`)
    }

    const poolInput = pool.buildContractInput()
    const tokenInput: any = new bsv.Transaction.Input({
        prevTxId: Buffer.from(mintTx.id, 'hex'), outputIndex: 1,
        script: bsv.Script.fromHex(''), sequenceNumber: 0xffffffff,
    })
    const fundingInput: any = new bsv.Transaction.Input({
        prevTxId: Buffer.from((funding as any).txId, 'hex'), outputIndex: (funding as any).outputIndex,
        script: bsv.Script.fromHex(''), sequenceNumber: 0xffffffff,
    })
    const opHex = (i: any): string => {
        const w: any = new bsv.encoding.BufferWriter()
        w.write(Buffer.from(i.prevTxId).reverse())
        w.writeUInt32LE(i.outputIndex)
        return w.toBuffer().toString('hex')
    }
    const allOutpoints = opHex(poolInput) + opHex(tokenInput) + opHex(fundingInput)

    pool.bindTxBuilder('redeem', async (cur: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
        const next = cur.next()
        next.collateral = cur.collateral - payout
        const tx: any = new bsv.Transaction()
            .addInput(poolInput)
            .addInput(tokenInput, bsv.Script.fromHex(tokenScript), TOKEN_SATS)
            .addInput(fundingInput, bsv.Script.fromHex((funding as any).script), (funding as any).satoshis)
            .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: cur.balance }))
            .addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(Utils.buildPublicKeyHashScript(holder)), satoshis: Number(payout) }))
        tx.feePerKb(FEE_PER_KB)
        const unlockEst = (cur.lockingScript as any).toBuffer().length * 1.2 + 2000
        const sizeEst = tx.toBuffer().length + unlockEst
        tx.change(options.changeAddress).fee(Math.ceil((sizeEst / 1000) * FEE_PER_KB))
        const sighashType = bsv.crypto.Signature.SIGHASH_NONE | bsv.crypto.Signature.SIGHASH_ANYONECANPAY | bsv.crypto.Signature.SIGHASH_FORKID
        const signP2PKH = (idx: number, subscript: any, sats: number): void => {
            const sig = bsv.Transaction.Sighash.sign(tx, priv, sighashType, idx, subscript, new bsv.crypto.BN(sats))
            const unlock: any = bsv.Script.fromHex('')
            unlock.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType])]))
            unlock.add(priv.publicKey.toBuffer())
            tx.inputs[idx].setScript(unlock)
        }
        signP2PKH(1, bsv.Script.fromHex(tokenScript), TOKEN_SATS)
        signP2PKH(2, bsv.Script.fromHex((funding as any).script), (funding as any).satoshis)
        return { tx, atInputIndex: 0, nexts: [{ instance: next, atOutputIndex: 0, balance: cur.balance }], next: { instance: next, atOutputIndex: 0, balance: cur.balance } }
    })

    console.log('\n=== BROADCAST 3/3: REDEEM (co-spend + on-chain backtrace) ===')
    const { tx: redeemTx } = await pool.methods.redeem(
        true, 1n, holder, BigInt(TOKEN_SATS),
        toByteString(prevHeader), toByteString(poolOut), toByteString(prevTail), toByteString(allOutpoints),
        { changeAddress: address, autoPayFee: false } as MethodCallOptions<LMSRMarket>
    )
    console.log('  redeem txid:', redeemTx.id)

    console.log('\nDONE:')
    console.log('  mint:  ', mintTx.id)
    console.log('  deploy:', deployTx.id)
    console.log('  redeem:', redeemTx.id, '(spends pool + the real token; backtrace verified on-chain)')
}

main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
})
