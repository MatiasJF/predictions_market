// The console's curve preview must not lie about what the engine will charge.
//
// The preview is a float approximation shown while an operator picks `b`; every satoshi that actually moves is
// computed by `@pm/lmsr` in exact integer arithmetic. Those are two implementations of the same curve, and the
// dangerous failure is silent divergence — an operator choosing `b` from a number the market will not honour.
// So the approximation is pinned against the exact math here, across the whole range of `b` worth using.
import { describe, it, expect } from 'vitest';
import { WAD, initState, unitMultiplier, applyUnitBuy, priceYesSats, maxLossSats as exactMaxLoss, type MarketParams } from '@pm/lmsr';
import { previewPrice, maxLossSats } from '../src/curve';

/** The engine's own answer: apply n exact unit buys and read the price it would quote. */
function exactPrice(bUnits: number, payoutUnit: number, buys: number): number {
  const p: MarketParams = { b: BigInt(bUnits) * WAD, payoutUnit: BigInt(payoutUnit), unit: WAD };
  const mult = unitMultiplier(p);
  let s = initState(p);
  for (let i = 0; i < buys; i++) s = applyUnitBuy(s, 'yes', mult, p);
  return Number(priceYesSats(s, p));
}

describe('curve preview', () => {
  it('matches the exact integer engine within a satoshi, across every useful b', () => {
    for (const b of [5, 10, 20, 50, 200, 1000]) {
      for (const n of [1, 5, 10, 20, 50]) {
        const preview = previewPrice(b, 1000, n);
        const exact = exactPrice(b, 1000, n);
        expect(
          Math.abs(preview - exact),
          `b=${b} n=${n}: preview ${preview} vs engine ${exact} — the console would mislead the operator`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('shows a steeper curve for smaller b — the whole point of exposing the knob', () => {
    const steep = previewPrice(10, 1000, 20);
    const flat = previewPrice(1000, 1000, 20);
    expect(steep).toBeGreaterThan(flat);
    // The default that shipped in market #7 barely moved at all: 20 buys, 4 satoshis.
    expect(flat - 500).toBeLessThan(10);
    expect(steep - 500).toBeGreaterThan(300);
  });

  it('starts every market at an even 50/50', () => {
    expect(previewPrice(20, 1000, 0)).toBe(500);
    expect(previewPrice(20, 100_000, 0)).toBe(50_000);
  });

  it('reports the operator\'s exposure as the engine computes it', () => {
    for (const b of [10, 20, 1000]) {
      const shown = maxLossSats(b, 1000);
      const real = Number(exactMaxLoss({ b: BigInt(b) * WAD, payoutUnit: 1000n, unit: WAD }));
      expect(Math.abs(shown - real), `b=${b}: showing ${shown}, real exposure ${real}`).toBeLessThanOrEqual(1);
    }
  });
});
