import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { TestContract, RABIN_TEST_KEY, ALICE } from 'runar-testing';
import { RunarContract } from 'runar-sdk';
import { WAD, initState, unitMultiplier, unitInverseMultiplier, applyUnitBuy, buyChargeApproxSats, maxLossSats, type MarketParams } from '@pm/lmsr';

const DIR = dirname(fileURLToPath(import.meta.url));
const marketSrc = readFileSync(join(DIR, '..', 'src', 'LMSRMarket.runar.ts'), 'utf8');
const tokenSrc = readFileSync(join(DIR, '..', 'src', 'ShareToken.runar.ts'), 'utf8');
const FILE = 'LMSRMarket.runar.ts';

const p: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const MARKET_ID = 42n;
const BUYER = ALICE.pubKey;

/** ShareToken code template (code part + OP_RETURN) for (MARKET_ID, side) — strip the 41-byte state suffix. */
function tokenCode(side: bigint): string {
  const art = compile(tokenSrc, { fileName: 'ShareToken.runar.ts' }).artifact!;
  const full = new RunarContract(art, [1n, BUYER, MARKET_ID, side]).getLockingScript();
  return full.slice(0, full.length - 82); // 41 bytes = 8 (supply) + 33 (holder)
}
const TOKEN_CODE_YES = tokenCode(1n);
const TOKEN_CODE_NO = tokenCode(0n);
const bn = (x: unknown): bigint => BigInt(x as string | bigint);

function poolState() {
  const s0 = initState(p);
  return {
    eYes: s0.eYes, eNo: s0.eNo, qYes: 0n, qNo: 0n, collateral: maxLossSats(p), resolved: 0n, winner: 0n,
    mult: unitMultiplier(p), invMult: unitInverseMultiplier(p), payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
    oracleN: RABIN_TEST_KEY.n, marketTag: 'a1b2c3d4', tokenCodeYes: TOKEN_CODE_YES, tokenCodeNo: TOKEN_CODE_NO,
  };
}

describe('TOKEN-001b — mint-on-buy', () => {
  it('compiles with token minting', () => {
    const r = compile(marketSrc, { fileName: FILE });
    expect(r.success, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 2)).toBe(true);
  });

  it('buyYes emits a pool continuation + a YES ShareToken output for the buyer', () => {
    const s1 = applyUnitBuy(initState(p), 'yes', unitMultiplier(p), p);
    const charge = buyChargeApproxSats(s1, 'yes', p.unit, p);
    const c = TestContract.fromSource(marketSrc, poolState(), FILE);
    const res = c.call('buyYes', { paymentSats: charge, outputSatoshis: 1000n, buyerPubKey: BUYER, tokenSats: 1n });
    console.log('buyYes outputs:', JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)?.slice(0, 1200));
    expect(res.success, res.error).toBe(true);
    // output 0 = pool continuation (state advanced)
    expect(bn(res.outputs[0]!.qYes)).toBe(p.unit);
    // output 1 = the minted YES ShareToken: tokenCodeYes ‖ num2bin(1,8) ‖ buyerPubKey
    expect(res.outputs).toHaveLength(2);
    const tokenScript = String(res.outputs[1]!._rawScript).toLowerCase();
    expect(tokenScript.startsWith(TOKEN_CODE_YES.toLowerCase())).toBe(true);
    expect(tokenScript.endsWith('0100000000000000' + BUYER.toLowerCase())).toBe(true);
  });

  it('buyNo mints a NO ShareToken', () => {
    const s1 = applyUnitBuy(initState(p), 'no', unitMultiplier(p), p);
    const charge = buyChargeApproxSats(s1, 'no', p.unit, p);
    const res = TestContract.fromSource(marketSrc, poolState(), FILE)
      .call('buyNo', { paymentSats: charge, outputSatoshis: 1000n, buyerPubKey: BUYER, tokenSats: 1n });
    expect(res.success, res.error).toBe(true);
    const tokenScript = String(res.outputs[1]!._rawScript).toLowerCase();
    expect(tokenScript.startsWith(TOKEN_CODE_NO.toLowerCase())).toBe(true);
    expect(tokenScript.endsWith('0100000000000000' + BUYER.toLowerCase())).toBe(true);
  });
});

describe('TOKEN-001c — winner redemption (pool pays the winner)', () => {
  const resolvedYes = () => ({ ...poolState(), resolved: 1n, winner: 1n });

  it('redeem: resolved-YES pays supply×payoutUnit to the holder, pool collateral reduced', () => {
    const res = TestContract.fromSource(marketSrc, resolvedYes(), FILE)
      .call('redeem', { supply: 1n, holderPubKey: BUYER, side: 1n, poolOutSats: 1n });
    expect(res.success, res.error).toBe(true);
    const payout = 1n * p.payoutUnit;
    expect(bn(res.outputs[0]!.collateral)).toBe(maxLossSats(p) - payout); // pool collateral reduced
    expect(bn(res.outputs[1]!.satoshis)).toBe(payout); // winner paid
    const script = String(res.outputs[1]!._rawScript).toLowerCase();
    expect(script.startsWith('76a914')).toBe(true);
    expect(script.endsWith('88ac')).toBe(true);
    expect(script.length).toBe(50); // 25-byte P2PKH
  });

  it('redeem rejected before resolution', () => {
    const res = TestContract.fromSource(marketSrc, poolState(), FILE)
      .call('redeem', { supply: 1n, holderPubKey: BUYER, side: 1n, poolOutSats: 1n });
    expect(res.success).toBe(false);
  });

  it('redeem rejected for the losing side (YES won, NO token)', () => {
    const res = TestContract.fromSource(marketSrc, resolvedYes(), FILE)
      .call('redeem', { supply: 1n, holderPubKey: BUYER, side: 0n, poolOutSats: 1n });
    expect(res.success).toBe(false);
  });
});
