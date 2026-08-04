import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runLifecycle } from '../src/lifecycle'
import { localSigner } from './utils/signer'
import { oracleN, signOutcome } from './utils/oracle'

const V = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'vectors.json'), 'utf8')
)
const b = (s: string): bigint => BigInt(s)

describe('LMSRMarket (sCrypt) — full lifecycle', () => {
    it('deploy → buy+mint → resolve → redeem all verify locally (DummyProvider)', async () => {
        const res = await runLifecycle(localSigner(), {
            eYes: b(V.init.eYes),
            eNo: b(V.init.eNo),
            mult: b(V.mult),
            invMult: b(V.invMult),
            wad: b(V.WAD),
            payoutUnit: 1000n, // small payout keeps mainnet amounts tiny
            collateral: 100_000n, // state; ≥ payout
            oracleN,
            marketTag: 'a1b2c3d4',
            poolSats: 1,
            tokenSats: 1,
            winnerPkh: 'ab'.repeat(20),
            signOutcome,
        })
        // Every stage produced a verified tx (DummyProvider gives 64-hex txids).
        expect(res.deployTxid).to.have.length(64)
        expect(res.buyTxid).to.have.length(64)
        expect(res.resolveTxid).to.have.length(64)
        expect(res.redeemTxid).to.have.length(64)
        expect(res.payout).to.equal('1000')
    })
})
