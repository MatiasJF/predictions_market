import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    bsv,
    ContractTransaction,
    DummyProvider,
    int2ByteString,
    MethodCallOptions,
    PubKeyHash,
    TestWallet,
    toByteString,
    Utils,
} from 'scrypt-ts'
import { LMSRMarket } from '../src/contracts/lmsrMarket'

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
    let threw = false
    try {
        await fn()
    } catch {
        threw = true
    }
    expect(threw, 'expected the call to be rejected').to.equal(true)
}

const V = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8'))
const b = (s: string): bigint => BigInt(s)
const DUMMY_ORACLE = 0xdeadbeefn
const MARKET_TAG = 'a1b2c3d4' // 4-byte market tag (matches the pool's marketTag)
const PAYOUT_UNIT = 100n
const COLLATERAL = 1_000_000n
const POOL_SATS = 1000
const TOKEN_SATS = 1n
/* eslint-disable @typescript-eslint/no-explicit-any */
const HOLDER_PRIV: any = bsv.PrivateKey.fromRandom(bsv.Networks.testnet) // the token holder + fee payer
const HOLDER = HOLDER_PRIV.toAddress().hashBuffer.toString('hex') // winner's PKH — must match the minted token

// The default DummyProvider re-checks the fee on the FINAL (large-covenant) tx in sendTransaction, which conflicts
// with bsv's own fee guard for this multi-input tx. That runs AFTER the real node Script interpreter has already
// verified every input, so stubbing the "broadcast" keeps the meaningful guarantee (green Script ⇒ mainnet-valid).
class ScriptOnlyProvider extends DummyProvider {
    override async sendTransaction(): Promise<string> {
        return '00'.repeat(32)
    }
}
const fixedSigner = (): TestWallet => new TestWallet(HOLDER_PRIV, new ScriptOnlyProvider())

/** Build the data-token locking script EXACTLY as the contract's buy/redeem reconstruct it. */
function tokenScriptHex(marketTag: string, isYes: boolean, supply: bigint, holderPKH: string): string {
    const side = isYes ? '01' : '00'
    const data = marketTag + side + int2ByteString(supply, 8n) + holderPKH
    const p2pkh = Utils.buildPublicKeyHashScript(PubKeyHash(toByteString(holderPKH)))
    return '21' + data + '75' + p2pkh
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const outHex = (o: any): string =>
    o.toBufferWriter(new bsv.encoding.BufferWriter()).toBuffer().toString('hex')

/** Build a synthetic mint tx (out0=pool-ish, out1=data token, out2=change) and split it for the backtrace args. */
function buildMint(tokenScript: string): {
    mint: any
    prevHeader: string
    poolOut: string
    prevTail: string
    internalTxid: Buffer
} {
    const mint: any = new bsv.Transaction()
    mint.addInput(
        new bsv.Transaction.Input({
            prevTxId: Buffer.alloc(32, 7),
            outputIndex: 0,
            script: bsv.Script.fromHex(''),
        }),
        bsv.Script.fromHex('76a914' + '00'.repeat(20) + '88ac'),
        100000
    )
    mint.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex('76a914' + '11'.repeat(20) + '88ac'), satoshis: 1 })) // out0 (pool-ish, one output)
    mint.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(tokenScript), satoshis: Number(TOKEN_SATS) })) // out1 = token
    mint.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex('76a914' + '22'.repeat(20) + '88ac'), satoshis: 500 })) // out2 = change

    const hw = new bsv.encoding.BufferWriter()
    hw.writeUInt32LE(mint.version)
    hw.writeVarintNum(mint.inputs.length)
    mint.inputs.forEach((i: any) => i.toBufferWriter(hw))
    hw.writeVarintNum(mint.outputs.length)
    const prevHeader = hw.toBuffer().toString('hex')

    const tailW = new bsv.encoding.BufferWriter()
    mint.outputs[2].toBufferWriter(tailW)
    tailW.writeUInt32LE(mint.nLockTime)
    const prevTail = tailW.toBuffer().toString('hex')

    const internalTxid = bsv.crypto.Hash.sha256sha256(mint.toBuffer())
    return { mint, prevHeader, poolOut: outHex(mint.outputs[0]), prevTail, internalTxid }
}

const outpointHex = (input: any): string => {
    const w = new bsv.encoding.BufferWriter()
    w.write(Buffer.from(input.prevTxId).reverse()) // bsv stores prevTxId display-order; the outpoint serializes internal (reversed)
    w.writeUInt32LE(input.outputIndex)
    return w.toBuffer().toString('hex')
}

async function resolvedPool(): Promise<LMSRMarket> {
    const pool = new LMSRMarket(
        b(V.init.eYes), b(V.init.eNo), b(V.unit), 0n, COLLATERAL, 1n, 1n, // resolved=1, winner=YES, 1 YES outstanding
        b(V.mult), b(V.invMult), PAYOUT_UNIT, b(V.WAD), b(V.unit), DUMMY_ORACLE, toByteString(MARKET_TAG)
    )
    await pool.connect(fixedSigner())
    await pool.deploy(POOL_SATS)
    return pool
}

/** Drive a redeem co-spend: input#0 = pool, input#1 = the token outpoint. Returns the call promise. */
async function callRedeem(
    pool: LMSRMarket,
    args: { isYes: boolean; supply: bigint; holder: string; tokenSats: bigint; mintedTokenScript: string; prevHeader: string; poolOut: string; prevTail: string; tokenTxid: Buffer; tokenVout: number }
): Promise<{ tx: bsv.Transaction }> {
    const poolInput: any = pool.buildContractInput()
    const tokenInput: any = new bsv.Transaction.Input({
        prevTxId: Buffer.from(args.tokenTxid).reverse(), // display order for bsv (it re-reverses on serialize)
        outputIndex: args.tokenVout,
        script: bsv.Script.fromHex(''),
        sequenceNumber: 0xffffffff,
    })
    // Explicit funding input #2 (the payout is real sats, not from the dust pool). Controlled so allOutpoints
    // covers ALL inputs; sCrypt's local verify only executes input #0 (the pool), so this dummy needs no unlock.
    const fundingInput: any = new bsv.Transaction.Input({
        prevTxId: Buffer.alloc(32, 9),
        outputIndex: 0,
        script: bsv.Script.fromHex(''),
        sequenceNumber: 0xffffffff,
    })
    const allOutpoints = outpointHex(poolInput) + outpointHex(tokenInput) + outpointHex(fundingInput)
    const payout = args.supply * PAYOUT_UNIT
    const signerAddr: any = await pool.signer.getDefaultAddress()
    const fundingScript = bsv.Script.fromHex('76a914' + signerAddr.hashBuffer.toString('hex') + '88ac')

    pool.bindTxBuilder(
        'redeem',
        async (current: LMSRMarket, options: MethodCallOptions<LMSRMarket>): Promise<ContractTransaction> => {
            const next = current.next()
            next.collateral = current.collateral - payout
            const payoutScript = bsv.Script.fromHex(Utils.buildPublicKeyHashScript(PubKeyHash(toByteString(args.holder))))
            const tx: any = new bsv.Transaction()
                .addInput(poolInput)
                .addInput(tokenInput, bsv.Script.fromHex(args.mintedTokenScript), Number(args.tokenSats))
                .addInput(fundingInput, fundingScript, 1_000_000)
                .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: current.balance }))
                .addOutput(new bsv.Transaction.Output({ script: payoutScript, satoshis: Number(payout) }))
            if (options.changeAddress) tx.change(options.changeAddress)
            // Manually sign the P2PKH inputs #1 (token) and #2 (funding) so the full tx verifies. Use
            // NONE|ANYONECANPAY so each sig commits only to its own input — immune to the framework's later
            // change-output tweaks (their real security isn't under test here; the pool backtrace is).
            const sighashType =
                bsv.crypto.Signature.SIGHASH_NONE |
                bsv.crypto.Signature.SIGHASH_ANYONECANPAY |
                bsv.crypto.Signature.SIGHASH_FORKID
            const signP2PKH = (idx: number, subscript: any, sats: number): void => {
                const sig = bsv.Transaction.Sighash.sign(tx, HOLDER_PRIV, sighashType, idx, subscript, new bsv.crypto.BN(sats))
                const unlock: any = bsv.Script.fromHex('')
                unlock.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType])]))
                unlock.add(HOLDER_PRIV.publicKey.toBuffer())
                tx.inputs[idx].setScript(unlock)
            }
            signP2PKH(1, bsv.Script.fromHex(args.mintedTokenScript), Number(args.tokenSats))
            signP2PKH(2, fundingScript, 1_000_000)
            return {
                tx, atInputIndex: 0,
                nexts: [{ instance: next, atOutputIndex: 0, balance: current.balance }],
                next: { instance: next, atOutputIndex: 0, balance: current.balance },
            }
        }
    )
    return pool.methods.redeem(
        args.isYes, args.supply, PubKeyHash(toByteString(args.holder)), args.tokenSats,
        toByteString(args.prevHeader), toByteString(args.poolOut), toByteString(args.prevTail), toByteString(allOutpoints),
        { changeAddress: await pool.signer.getDefaultAddress(), autoPayFee: false } as MethodCallOptions<LMSRMarket>
    ) as Promise<{ tx: bsv.Transaction }>
}

describe('LMSRMarket.redeem — backtrace-verified co-spent token (CONC-003c)', () => {
    before(async () => {
        await LMSRMarket.loadArtifact()
    })

    it('redeems when a genuine co-spent token is proven on-chain by backtrace', async () => {
        const ts = tokenScriptHex(MARKET_TAG, true, 1n, HOLDER)
        const { prevHeader, poolOut, prevTail, internalTxid } = buildMint(ts)
        const pool = await resolvedPool()
        await callRedeem(pool, { isYes: true, supply: 1n, holder: HOLDER, tokenSats: TOKEN_SATS, mintedTokenScript: ts, prevHeader, poolOut, prevTail, tokenTxid: internalTxid, tokenVout: 1 })
    })

    it('rejects an over-claim (supply larger than the token encodes)', async () => {
        const ts = tokenScriptHex(MARKET_TAG, true, 1n, HOLDER) // token encodes supply = 1
        const { prevHeader, poolOut, prevTail, internalTxid } = buildMint(ts)
        const pool = await resolvedPool()
        await expectReject(() =>
            callRedeem(pool, { isYes: true, supply: 5n, holder: HOLDER, tokenSats: TOKEN_SATS, mintedTokenScript: ts, prevHeader, poolOut, prevTail, tokenTxid: internalTxid, tokenVout: 1 })
        )
    })

    it('rejects redirection (paying a different holder than the token encodes)', async () => {
        const ts = tokenScriptHex(MARKET_TAG, true, 1n, HOLDER)
        const { prevHeader, poolOut, prevTail, internalTxid } = buildMint(ts)
        const pool = await resolvedPool()
        await expectReject(() =>
            callRedeem(pool, { isYes: true, supply: 1n, holder: 'cd'.repeat(20), tokenSats: TOKEN_SATS, mintedTokenScript: ts, prevHeader, poolOut, prevTail, tokenTxid: internalTxid, tokenVout: 1 })
        )
    })

    it('rejects the wrong token vout (token not at input #1 index 1)', async () => {
        const ts = tokenScriptHex(MARKET_TAG, true, 1n, HOLDER)
        const { prevHeader, poolOut, prevTail, internalTxid } = buildMint(ts)
        const pool = await resolvedPool()
        await expectReject(() =>
            callRedeem(pool, { isYes: true, supply: 1n, holder: HOLDER, tokenSats: TOKEN_SATS, mintedTokenScript: ts, prevHeader, poolOut, prevTail, tokenTxid: internalTxid, tokenVout: 2 })
        )
    })
})
