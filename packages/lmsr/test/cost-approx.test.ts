import { describe, it, expect } from 'vitest';
import {
  WAD,
  type MarketParams,
  type Side,
  initState,
  applyBuyExact,
  applySellExact,
  costSats,
  proceedsSats,
  buyChargeApproxSats,
  sellPayoutApproxSats,
} from '../src/index.js';

// LMSR-002 (ADR-011): the on-chain contract can't compute ln, so it prices trades at the POST-trade
// marginal price (a right-Riemann bound). These tests prove that rule is MM-safe in every direction and
// that its error is bounded by the trade-size / liquidity ratio (Δ/b).

const PAYOUT = 100_000n;
const B_VALUES = [2n * WAD, 100n * WAD, 1000n * WAD, 1_000_000n * WAD];
// denominators d give Δ/b = 1/d
const RATIOS: [string, bigint][] = [['1e-3', 1000n], ['1e-2', 100n], ['0.1', 10n]];

function mk(b: bigint): MarketParams {
  return { b, payoutUnit: PAYOUT, unit: WAD };
}
function skew(p: MarketParams, side: Side, n: number) {
  let s = initState(p);
  for (let i = 0; i < n; i++) s = applyBuyExact(s, side, WAD, p);
  return s;
}
function overchargePct(b: bigint, side: Side, den: bigint, startYesBuys: number): number {
  const p = mk(b);
  const start = startYesBuys === 0 ? initState(p) : skew(p, 'yes', startYesBuys);
  const delta = b / den;
  const sTo = applyBuyExact(start, side, delta, p);
  const exact = costSats(start, sTo, p);
  const chg = buyChargeApproxSats(sTo, side, delta, p);
  return exact > 0n ? Number(((chg - exact) * 1_000_000n) / exact) / 10000 : 0;
}
// overcharge as a fraction of trade NOTIONAL (Δ·payout = the most the shares could ever be worth).
// This is the meaningful "how much extra vs potential winnings" metric — bounded even when buying a deep
// out-of-the-money side (where %-of-exact-cost looks large but the absolute sats are trivial).
function overchargeNotionalPct(b: bigint, side: Side, den: bigint, skewSide: Side, n: number): number {
  const p = mk(b);
  let start = initState(p);
  for (let i = 0; i < n; i++) start = applyBuyExact(start, skewSide, WAD, p);
  const delta = b / den;
  const sTo = applyBuyExact(start, side, delta, p);
  const over = buyChargeApproxSats(sTo, side, delta, p) - costSats(start, sTo, p);
  const notional = (delta * PAYOUT) / WAD;
  return notional > 0n ? Number((over * 1_000_000n) / notional) / 10000 : 0;
}

describe('post-trade-price cost approximation is MM-SAFE in every direction', () => {
  it('BUY charge ≥ exact cost across a grid of b, side, size, and skew', () => {
    for (const b of B_VALUES) {
      const p = mk(b);
      for (const start of [initState(p), skew(p, 'yes', 50), skew(p, 'no', 50)]) {
        for (const side of ['yes', 'no'] as Side[]) {
          for (const [lbl, den] of RATIOS) {
            const delta = b / den;
            const sTo = applyBuyExact(start, side, delta, p);
            const exact = costSats(start, sTo, p);
            const charge = buyChargeApproxSats(sTo, side, delta, p);
            expect(charge >= exact, `UNDERCHARGE b=${b} side=${side} Δ/b=${lbl}: charge ${charge} < exact ${exact}`).toBe(true);
          }
        }
      }
    }
  });

  it('SELL payout ≤ exact proceeds across a grid (pool never overpays)', () => {
    for (const b of B_VALUES) {
      const p = mk(b);
      for (const side of ['yes', 'no'] as Side[]) {
        const stocked = skew(p, side, 100); // build an outstanding position to sell back
        for (const [lbl, den] of RATIOS) {
          const delta = b / den;
          const outstanding = side === 'yes' ? stocked.qYes : stocked.qNo;
          if (delta > outstanding) continue;
          const sTo = applySellExact(stocked, side, delta, p);
          const exact = proceedsSats(stocked, sTo, p);
          const pay = sellPayoutApproxSats(sTo, side, delta, p);
          expect(pay <= exact, `OVERPAY b=${b} side=${side} Δ/b=${lbl}: pay ${pay} > exact ${exact}`).toBe(true);
        }
      }
    }
  });
});

describe('approximation error is bounded and controlled by Δ/b', () => {
  it('at Δ/b ≤ 1e-2 the buy overcharge is < 0.2% of trade notional, across every b/side/skew', () => {
    // Measured worst case over this sweep is ~0.125% of notional; assert a 0.2% ceiling with margin.
    for (const b of B_VALUES) {
      for (const side of ['yes', 'no'] as Side[]) {
        for (const skewSide of ['yes', 'no'] as Side[]) {
          for (const n of [0, 50, 200, 1000]) {
            const pct = overchargeNotionalPct(b, side, 100n, skewSide, n); // Δ/b = 1e-2
            expect(pct < 0.2, `b=${b} side=${side} skew=${skewSide}×${n}: overcharge ${pct}% of notional ≥ 0.2%`).toBe(true);
          }
        }
      }
    }
  });

  it('overcharge grows monotonically with Δ/b (smaller trades ⇒ tighter)', () => {
    const b = 1000n * WAD;
    const at1e3 = overchargePct(b, 'yes', 1000n, 0);
    const at1e2 = overchargePct(b, 'yes', 100n, 0);
    const at1e1 = overchargePct(b, 'yes', 10n, 0);
    expect(at1e3).toBeLessThan(at1e2);
    expect(at1e2).toBeLessThan(at1e1);
    expect(at1e1).toBeLessThan(5); // ~2.4% measured; comfortably single-digit
  });
});
