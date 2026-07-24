import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { TestContract } from 'runar-testing';
import {
  WAD, initState, unitMultiplier, applyUnitBuy, buyChargeApproxSats, maxLossSats,
  type MarketParams, type MarketState, type Side,
} from '@pm/lmsr';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'LMSRMarket.runar.ts');
const source = readFileSync(SRC, 'utf8');
const FILE = 'LMSRMarket.runar.ts';

const p: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const MULT = unitMultiplier(p);
const COLLATERAL0 = maxLossSats(p);
const bn = (x: unknown): bigint => BigInt(x as string | bigint);

/** Build the Rúnar constructor/init state from an @pm/lmsr market state. */
function contractState(s: MarketState, collateral: bigint) {
  return {
    eYes: s.eYes, eNo: s.eNo, qYes: s.qYes, qNo: s.qNo, collateral,
    mult: MULT, payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
  };
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
    const res = c.call('buyYes', { paymentSats: charge, outputSatoshis: 1n });
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
    const res = c.call('buyNo', { paymentSats: charge, outputSatoshis: 1n });
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
        .call(method, { paymentSats: charge, outputSatoshis: 1n });
      expect(ok.success, `exact charge ${charge} rejected for ${side}: ${ok.error}`).toBe(true);

      const under = TestContract.fromSource(source, contractState(s, COLLATERAL0), FILE)
        .call(method, { paymentSats: charge - 1n, outputSatoshis: 1n });
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

      const res = TestContract.fromSource(source, st, FILE).call(method, { paymentSats: charge, outputSatoshis: 1n });
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
        mult: MULT, payoutUnit: p.payoutUnit, scale: WAD, unit: p.unit,
      };
    }
  });
});
