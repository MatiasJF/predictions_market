import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { RunarContract } from 'runar-sdk';
import { TestContract, RABIN_TEST_KEY, rabinSign, hexToBytes, ALICE } from 'runar-testing';
import {
  WAD, initState, unitMultiplier, unitInverseMultiplier, applyUnitBuy, applyUnitSell,
  buyChargeApproxSats, sellPayoutApproxSats, maxLossSats,
  type MarketParams, type MarketState, type Side,
} from '@pm/lmsr';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'LMSRMarket.runar.ts');
const source = readFileSync(SRC, 'utf8');
const FILE = 'LMSRMarket.runar.ts';

const p: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const MULT = unitMultiplier(p);
const INVMULT = unitInverseMultiplier(p);
const COLLATERAL0 = maxLossSats(p);
const ORACLE_N = RABIN_TEST_KEY.n;
const MARKET_TAG = 'a1b2c3d4'; // hex; binds the oracle sig to this market
const MARKET_ID = 42n;
const BUYER = ALICE.pubKey;
const bn = (x: unknown): bigint => BigInt(x as string | bigint);

// ShareToken code template (code part + OP_RETURN) for (MARKET_ID, side); strip the 41-byte state suffix.
const tokenSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ShareToken.runar.ts'), 'utf8');
function tokenCode(side: bigint): string {
  const art = compile(tokenSrc, { fileName: 'ShareToken.runar.ts' }).artifact!;
  const full = new RunarContract(art, [1n, BUYER, MARKET_ID, side]).getLockingScript();
  return full.slice(0, full.length - 82);
}
const TOKEN_CODE_YES = tokenCode(1n);
const TOKEN_CODE_NO = tokenCode(0n);

/** Build the Rúnar constructor/init state from an @pm/lmsr market state. */
function contractState(s: MarketState, collateral: bigint) {
  return {
    eYes: s.eYes, eNo: s.eNo, qYes: s.qYes, qNo: s.qNo, collateral, resolved: 0n, winner: 0n,
    mult: MULT, invMult: INVMULT, payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
    oracleN: ORACLE_N, marketTag: MARKET_TAG, tokenCodeYes: TOKEN_CODE_YES, tokenCodeNo: TOKEN_CODE_NO,
  };
}

/** Little-endian hex of a bigint (padding is read as an unsigned LE bigint by verifyRabinSig). */
function leHex(n: bigint): string {
  if (n === 0n) return '00';
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return (h.match(/../g) as string[]).reverse().join('');
}
/** The exact message the contract hashes: marketTag ‖ num2bin(outcome, 1). */
function oracleMsgBytes(outcome: bigint): Uint8Array {
  const tag = hexToBytes(MARKET_TAG);
  return new Uint8Array([...tag, Number(outcome)]);
}
/** Skew the market by buying `n` units of `side` off a fresh pool (via the reference). */
function skewed(side: Side, n: number): MarketState {
  let s = initState(p);
  for (let i = 0; i < n; i++) s = applyUnitBuy(s, side, MULT, p);
  return s;
}

describe('CONTRACT-002 — LMSRMarket buy() in Rúnar matches the @pm/lmsr reference', () => {
  it('compiles to Bitcoin Script', () => {
    const r = compile(source, { fileName: FILE });
    expect(r.success, JSON.stringify(r.diagnostics, null, 2)).toBe(true);
    expect((r.scriptHex ?? '').length).toBeGreaterThan(0);
  });

  it('buyYes: output state equals the reference multiplicative update + collateral += payment', () => {
    const s0 = initState(p);
    const s1 = applyUnitBuy(s0, 'yes', MULT, p);
    const charge = buyChargeApproxSats(s1, 'yes', p.unit, p);

    const c = TestContract.fromSource(source, contractState(s0, COLLATERAL0), FILE);
    const res = c.call('buyYes', { paymentSats: charge, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.eYes)).toBe(s1.eYes);
    expect(bn(o.eNo)).toBe(s1.eNo); // = s0.eNo, untouched
    expect(bn(o.qYes)).toBe(p.unit);
    expect(bn(o.qNo)).toBe(0n);
    expect(bn(o.collateral)).toBe(COLLATERAL0 + charge);
  });

  it('buyNo: symmetric — only the NO side and collateral move', () => {
    const s0 = initState(p);
    const s1 = applyUnitBuy(s0, 'no', MULT, p);
    const charge = buyChargeApproxSats(s1, 'no', p.unit, p);

    const c = TestContract.fromSource(source, contractState(s0, COLLATERAL0), FILE);
    const res = c.call('buyNo', { paymentSats: charge, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.eNo)).toBe(s1.eNo);
    expect(bn(o.eYes)).toBe(s1.eYes); // untouched
    expect(bn(o.qNo)).toBe(p.unit);
    expect(bn(o.collateral)).toBe(COLLATERAL0 + charge);
  });

  it('the contract enforces EXACTLY the reference charge (pay charge → ok, charge−1 → fail)', () => {
    // Across skewed states + both sides, the on-chain charge must equal @pm/lmsr's buyChargeApproxSats.
    const scenarios: [Side, MarketState][] = [
      ['yes', initState(p)],
      ['yes', skewed('yes', 200)],
      ['no', skewed('yes', 200)],  // buy the cheap side at a skew
      ['no', skewed('no', 500)],
      ['yes', skewed('no', 500)],
    ];
    for (const [side, s] of scenarios) {
      const next = applyUnitBuy(s, side, MULT, p);
      const charge = buyChargeApproxSats(next, side, p.unit, p);
      const method = side === 'yes' ? 'buyYes' : 'buyNo';

      const ok = TestContract.fromSource(source, contractState(s, COLLATERAL0), FILE)
        .call(method, { paymentSats: charge, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
      expect(ok.success, `exact charge ${charge} rejected for ${side}: ${ok.error}`).toBe(true);

      const under = TestContract.fromSource(source, contractState(s, COLLATERAL0), FILE)
        .call(method, { paymentSats: charge - 1n, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
      expect(under.success, `underpayment (charge−1) accepted for ${side}`).toBe(false);
    }
  });

  it('stays in exact lockstep with the reference over a 60-step feedback loop', () => {
    // Feed each buy's output state back in as the next input; the contract must equal @pm/lmsr every step.
    let ref = initState(p);
    let st = contractState(ref, COLLATERAL0);
    let collateral = COLLATERAL0;
    for (let i = 0; i < 60; i++) {
      const side: Side = i % 3 === 0 || i % 7 === 0 ? 'no' : 'yes'; // deterministic mixed pattern
      const next = applyUnitBuy(ref, side, MULT, p);
      const charge = buyChargeApproxSats(next, side, p.unit, p);
      const method = side === 'yes' ? 'buyYes' : 'buyNo';

      const res = TestContract.fromSource(source, st, FILE).call(method, { paymentSats: charge, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
      expect(res.success, `step ${i} ${side}: ${res.error}`).toBe(true);
      const o = res.outputs[0]!;
      collateral += charge;
      expect(bn(o.eYes)).toBe(next.eYes);
      expect(bn(o.eNo)).toBe(next.eNo);
      expect(bn(o.qYes)).toBe(next.qYes);
      expect(bn(o.qNo)).toBe(next.qNo);
      expect(bn(o.collateral)).toBe(collateral);

      ref = next;
      st = {
        eYes: bn(o.eYes), eNo: bn(o.eNo), qYes: bn(o.qYes), qNo: bn(o.qNo), collateral: bn(o.collateral),
        resolved: bn(o.resolved), winner: bn(o.winner),
        mult: MULT, invMult: INVMULT, payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
        oracleN: ORACLE_N, marketTag: MARKET_TAG, tokenCodeYes: TOKEN_CODE_YES, tokenCodeNo: TOKEN_CODE_NO,
      };
    }
  });
});

describe('CONTRACT-003 — LMSRMarket sell() in Rúnar matches the @pm/lmsr reference', () => {
  it('sellYes: output state equals the reference inverse update, collateral −= proceeds', () => {
    // Build a stocked YES position first, then sell one unit back.
    const stocked = applyUnitBuy(applyUnitBuy(initState(p), 'yes', MULT, p), 'yes', MULT, p); // qYes = 2 units
    const afterSell = applyUnitSell(stocked, 'yes', INVMULT, p);
    const proceeds = sellPayoutApproxSats(afterSell, 'yes', p.unit, p);

    const c = TestContract.fromSource(source, contractState(stocked, COLLATERAL0), FILE);
    const res = c.call('sellYes', { outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.eYes)).toBe(afterSell.eYes);
    expect(bn(o.eNo)).toBe(afterSell.eNo);
    expect(bn(o.qYes)).toBe(afterSell.qYes); // one unit removed
    expect(bn(o.collateral)).toBe(COLLATERAL0 - proceeds);
  });

  it('sellNo: symmetric', () => {
    const stocked = applyUnitBuy(applyUnitBuy(initState(p), 'no', MULT, p), 'no', MULT, p);
    const afterSell = applyUnitSell(stocked, 'no', INVMULT, p);
    const proceeds = sellPayoutApproxSats(afterSell, 'no', p.unit, p);

    const res = TestContract.fromSource(source, contractState(stocked, COLLATERAL0), FILE).call('sellNo', { outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.eNo)).toBe(afterSell.eNo);
    expect(bn(o.qNo)).toBe(afterSell.qNo);
    expect(bn(o.collateral)).toBe(COLLATERAL0 - proceeds);
  });

  it('cannot sell with no outstanding shares (q < unit) — guard rejects', () => {
    const res = TestContract.fromSource(source, contractState(initState(p), COLLATERAL0), FILE).call('sellYes', { outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });

  it('sell proceeds ≤ the buy charge for the same unit (bid/ask spread favours the pool)', () => {
    // Buy one YES from fresh, then sell it straight back; the pool must not lose on the round-trip.
    const s0 = initState(p);
    const s1 = applyUnitBuy(s0, 'yes', MULT, p);
    const charge = buyChargeApproxSats(s1, 'yes', p.unit, p);
    const back = applyUnitSell(s1, 'yes', INVMULT, p);
    const proceeds = sellPayoutApproxSats(back, 'yes', p.unit, p);
    expect(proceeds <= charge, `proceeds ${proceeds} > charge ${charge}`).toBe(true);

    // and the contract's collateral after buy-then-sell ends ≥ where it started (pool never loses)
    const afterBuy = TestContract.fromSource(source, contractState(s0, COLLATERAL0), FILE)
      .call('buyYes', { paymentSats: charge, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n }).outputs[0]!;
    const afterSell = TestContract.fromSource(source, {
      eYes: bn(afterBuy.eYes), eNo: bn(afterBuy.eNo), qYes: bn(afterBuy.qYes), qNo: bn(afterBuy.qNo),
      collateral: bn(afterBuy.collateral), resolved: 0n, winner: 0n,
      mult: MULT, invMult: INVMULT, payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
      oracleN: ORACLE_N, marketTag: MARKET_TAG, tokenCodeYes: TOKEN_CODE_YES, tokenCodeNo: TOKEN_CODE_NO,
    }, FILE).call('sellYes', { outputSatoshis: 1n }).outputs[0]!;
    expect(bn(afterSell.collateral) >= COLLATERAL0).toBe(true);
  });
});

describe('SETTLE-001 — oracle resolution via Rabin signature', () => {
  function signOutcome(outcome: bigint) {
    const { sig, padding } = rabinSign(oracleMsgBytes(outcome), RABIN_TEST_KEY);
    return { sig, padding: leHex(padding) };
  }

  it('resolve(YES): a valid oracle signature flips the pool to resolved, winner=YES', () => {
    const { sig, padding } = signOutcome(1n);
    const c = TestContract.fromSource(source, contractState(initState(p), COLLATERAL0), FILE);
    const res = c.call('resolve', { sig, padding, outcome: 1n, outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.resolved)).toBe(1n);
    expect(bn(o.winner)).toBe(1n);
    expect(bn(o.collateral)).toBe(COLLATERAL0); // unchanged by resolution
  });

  it('resolve(NO): valid signature over outcome=0 sets winner=NO', () => {
    const { sig, padding } = signOutcome(0n);
    const res = TestContract.fromSource(source, contractState(initState(p), COLLATERAL0), FILE)
      .call('resolve', { sig, padding, outcome: 0n, outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    expect(bn(res.outputs[0]!.winner)).toBe(0n);
  });

  it('rejects a forged signature', () => {
    const { padding } = signOutcome(1n);
    const res = TestContract.fromSource(source, contractState(initState(p), COLLATERAL0), FILE)
      .call('resolve', { sig: 123456789n, padding, outcome: 1n, outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });

  it('rejects a signature for a different outcome (message binding)', () => {
    // Oracle signed YES(1); caller claims NO(0) with the YES signature → message mismatch → reject.
    const { sig, padding } = signOutcome(1n);
    const res = TestContract.fromSource(source, contractState(initState(p), COLLATERAL0), FILE)
      .call('resolve', { sig, padding, outcome: 0n, outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });

  it('trading is disabled after resolution (buy and sell rejected)', () => {
    const resolved = { ...contractState(initState(p), COLLATERAL0), resolved: 1n, winner: 1n };
    const buy = TestContract.fromSource(source, resolved, FILE).call('buyYes', { paymentSats: 10_000_000n, outputSatoshis: 1n, buyerPubKey: BUYER, tokenSats: 1n });
    expect(buy.success).toBe(false);
    const stocked = { ...contractState(applyUnitBuy(initState(p), 'yes', MULT, p), COLLATERAL0), resolved: 1n, winner: 1n };
    const sell = TestContract.fromSource(source, stocked, FILE).call('sellYes', { outputSatoshis: 1n });
    expect(sell.success).toBe(false);
  });

  it('cannot resolve an already-resolved market', () => {
    const { sig, padding } = signOutcome(1n);
    const resolved = { ...contractState(initState(p), COLLATERAL0), resolved: 1n, winner: 1n };
    const res = TestContract.fromSource(source, resolved, FILE).call('resolve', { sig, padding, outcome: 1n, outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });
});
