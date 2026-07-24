import { describe, it, expect } from 'vitest';
import {
  WAD,
  type MarketParams,
  type MarketState,
  initState,
  unitMultiplier,
  unitInverseMultiplier,
  priceYesSats,
  priceNoSats,
  costFnUnits,
  poolSats,
  maxLossSats,
  applyBuyExact,
  applySellExact,
  applyUnitBuy,
  applyUnitSell,
  costSats,
  proceedsSats,
} from '../src/index.js';

const PAYOUT = 100_000n;

/** Deterministic LCG in [0,1) for reproducible stress runs (no Math.random). */
function makeRng(seed: bigint): () => number {
  let s = seed & ((1n << 64n) - 1n);
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & M;
    return Number(s >> 40n) / 2 ** 24;
  };
}

describe('LMSR pricing basics', () => {
  const p: MarketParams = { b: 2n * WAD, payoutUnit: PAYOUT, unit: WAD };

  it('opens 50/50', () => {
    const s = initState(p);
    expect(priceYesSats(s, p)).toBe(50_000n);
    expect(priceNoSats(s, p)).toBe(50_000n);
  });

  it('matches the spec example: one YES share → ~62,246 sats', () => {
    const s0 = initState(p);
    const s1 = applyUnitBuy(s0, 'yes', unitMultiplier(p), p);
    const py = priceYesSats(s1, p);
    expect(py >= 62_244n && py <= 62_248n, `got ${py}`).toBe(true); // spec: 62,246
    expect(priceYesSats(s1, p) + priceNoSats(s1, p)).toBe(PAYOUT); // exact complement
  });

  it('max loss = b·ln2 (spec: ~138,630)', () => {
    expect(maxLossSats(p)).toBe(138_629n); // spec rounds to 138,630
  });

  it('YES+NO price always sums to payoutUnit', () => {
    let s = initState(p);
    const m = unitMultiplier(p);
    for (let i = 0; i < 50; i++) {
      s = applyUnitBuy(s, i % 3 === 0 ? 'no' : 'yes', m, p);
      expect(priceYesSats(s, p) + priceNoSats(s, p)).toBe(PAYOUT);
    }
  });
});

describe('multiplicative-state trick matches exact recompute (ADR-007)', () => {
  const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: WAD };
  it('applyUnitBuy compounded ≈ applyBuyExact(delta = k·unit)', () => {
    const m = unitMultiplier(p);
    let multi = initState(p);
    for (let k = 1; k <= 5000; k++) {
      multi = applyUnitBuy(multi, 'yes', m, p);
      if (k % 1000 === 0) {
        const exact = applyBuyExact(initState(p), 'yes', BigInt(k) * WAD, p);
        // relative drift from compounding must stay tiny
        const d = multi.eYes > exact.eYes ? multi.eYes - exact.eYes : exact.eYes - multi.eYes;
        expect(d <= exact.eYes / 10n ** 9n + 10n, `k=${k} drift ${d}`).toBe(true);
      }
    }
  });
});

describe('solvency + invariants under 100k trades', () => {
  it('pool C(q) ≥ liabilities, prices bounded, monotonic, complement exact', () => {
    const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: WAD };
    const m = unitMultiplier(p);
    const rng = makeRng(0xC0FFEEn);
    const EPS = WAD / 1_000_000n; // 1e-6 share tolerance for fixed-point rounding

    const seed = maxLossSats(p); // the b·ln2 bankroll the pool is opened with
    let s = initState(p);
    let cost = 0n; // cumulative sats actually collected from traders (rounded per trade)
    let minMargin = seed; // min over the run of (real pool − max liability)
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const side = rng() < 0.5 ? 'yes' : 'no';
      const before = priceYesSats(s, p);
      const next = applyUnitBuy(s, side, m, p);

      // cost of this trade (>= 0)
      const c = costSats(s, next, p);
      expect(c >= 0n).toBe(true);
      cost += c;

      // price bounds + exact complement
      const py = priceYesSats(next, p);
      expect(py >= 0n && py <= PAYOUT).toBe(true);
      expect(py + priceNoSats(next, p)).toBe(PAYOUT);

      // monotonic: buying YES cannot lower pYes; buying NO cannot raise it
      if (side === 'yes') expect(py >= before).toBe(true);
      else expect(py <= before).toBe(true);

      // solvency (unit-space): pool C(q) ≥ max outstanding liability (the core LMSR guarantee)
      const C = costFnUnits(next, p);
      expect(C + EPS >= next.qYes).toBe(true);
      expect(C + EPS >= next.qNo).toBe(true);

      // solvency (sats, REAL pool = seed + rounded costs actually collected): must cover the real
      // payout liability every single trade. This bites on cost rounding-direction errors (V3 #5).
      const liability = (PAYOUT * (next.qYes > next.qNo ? next.qYes : next.qNo)) / WAD;
      const margin = seed + cost - liability;
      expect(margin >= 0n).toBe(true);
      if (margin < minMargin) minMargin = margin;

      s = next;
    }
    expect(minMargin >= 0n).toBe(true);

    // pool sats ≈ maxLoss seed + collected costs (within rounding)
    const expected = maxLossSats(p) + cost;
    const actual = poolSats(s, p);
    const d = actual > expected ? actual - expected : expected - actual;
    expect(d <= BigInt(N), `pool ${actual} vs seed+collected ${expected}, drift ${d}`).toBe(true);
  });
});

describe('one-sided buying respects the max-loss bound', () => {
  it('MM loss (payout − collected) ≤ b·ln2 even if the winning side is bought hard', () => {
    const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: WAD };
    const m = unitMultiplier(p);
    let s = initState(p);
    let collected = 0n;
    for (let i = 0; i < 20_000; i++) {
      const next = applyUnitBuy(s, 'yes', m, p);
      collected += costSats(s, next, p);
      s = next;
      // pool always covers the YES payout liability
      expect(poolSats(s, p) + 1n >= (p.payoutUnit * s.qYes) / WAD).toBe(true);
    }
    // If YES wins: MM pays payoutUnit·qYes, collected `collected`; net loss ≤ maxLoss.
    const liability = (p.payoutUnit * s.qYes) / WAD;
    const mmLoss = liability - collected;
    expect(mmLoss <= maxLossSats(p) + 2n, `mmLoss ${mmLoss} > maxLoss ${maxLossSats(p)}`).toBe(true);
  });
});

describe('price actually discovers (not a constant) — strict monotonicity in a non-saturated regime', () => {
  // b large + payout large so one unit moves price by many sats and never saturates: a frozen-price
  // implementation cannot pass these. (V3 #1)
  const p: MarketParams = { b: 100n * WAD, payoutUnit: 1_000_000n, unit: WAD };

  it('buying YES strictly increases pYes; buying NO strictly decreases it', () => {
    const m = unitMultiplier(p);
    let s = initState(p);
    let prev = priceYesSats(s, p);
    expect(prev).toBe(500_000n); // 50%
    for (let i = 0; i < 200; i++) {
      s = applyUnitBuy(s, 'yes', m, p);
      const py = priceYesSats(s, p);
      expect(py > prev, `YES buy #${i} did not strictly raise price: ${prev}→${py}`).toBe(true);
      prev = py;
    }
    // and back down with NO buys
    for (let i = 0; i < 200; i++) {
      s = applyUnitBuy(s, 'no', m, p);
      const py = priceYesSats(s, p);
      expect(py < prev, `NO buy #${i} did not strictly lower price: ${prev}→${py}`).toBe(true);
      prev = py;
    }
  });
});

describe('symmetry: NO side and non-unit trade sizes (V3 #3, #4)', () => {
  it('applyUnitBuy(NO) compounded ≈ applyBuyExact(NO, k·unit)', () => {
    const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: WAD };
    const m = unitMultiplier(p);
    let multi = initState(p);
    for (let k = 1; k <= 5000; k++) {
      multi = applyUnitBuy(multi, 'no', m, p);
      if (k % 1000 === 0) {
        const exact = applyBuyExact(initState(p), 'no', BigInt(k) * WAD, p);
        const d = multi.eNo > exact.eNo ? multi.eNo - exact.eNo : exact.eNo - multi.eNo;
        expect(d <= exact.eNo / 10n ** 9n + 10n, `k=${k} NO drift ${d}`).toBe(true);
        expect(multi.eYes).toBe(exact.eYes); // untouched side stays exactly equal
      }
    }
  });

  it('YES/NO are mirror images from the same balanced start', () => {
    const p: MarketParams = { b: 500n * WAD, payoutUnit: PAYOUT, unit: WAD };
    const m = unitMultiplier(p);
    const yes = applyUnitBuy(initState(p), 'yes', m, p);
    const no = applyUnitBuy(initState(p), 'no', m, p);
    // Reflection symmetry holds to within 1 sat: priceYes floors, so it and (payout − priceNo) can
    // differ by 1. This 1-sat side asymmetry is a real property the on-chain contract must respect.
    const a = priceYesSats(yes, p);
    const b = priceNoSats(no, p);
    expect(a - b <= 1n && b - a <= 1n, `${a} vs ${b}`).toBe(true);
    // Cost IS exactly symmetric — C(q)=b·ln(eYes+eNo) is symmetric under swapping the sides.
    expect(costSats(initState(p), yes, p)).toBe(costSats(initState(p), no, p));
  });

  it('non-unit trade size (unit = 3 shares) prices and equivalence hold', () => {
    const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: 3n * WAD };
    const m = unitMultiplier(p);
    let s = initState(p);
    expect(priceYesSats(s, p) + priceNoSats(s, p)).toBe(PAYOUT);
    for (let k = 1; k <= 10; k++) {
      s = applyUnitBuy(s, 'yes', m, p);
      const exact = applyBuyExact(initState(p), 'yes', BigInt(k) * p.unit, p);
      const d = s.eYes > exact.eYes ? s.eYes - exact.eYes : exact.eYes - s.eYes;
      expect(d <= exact.eYes / 10n ** 9n + 10n).toBe(true);
      expect(s.qYes).toBe(BigInt(k) * p.unit);
    }
  });
});

describe('sell / early exit (ADR-008)', () => {
  const p: MarketParams = { b: 1000n * WAD, payoutUnit: PAYOUT, unit: WAD };

  it('exact buy→sell round-trip returns to the opening state', () => {
    const s0 = initState(p);
    const bought = applyBuyExact(s0, 'yes', 5n * WAD, p);
    const back = applySellExact(bought, 'yes', 5n * WAD, p);
    expect(back.qYes).toBe(0n);
    expect(back.eYes).toBe(s0.eYes); // exact recompute is exactly invertible
    expect(priceYesSats(back, p)).toBe(50_000n);
  });

  it('multiplicative sell inverts multiplicative buy within tolerance', () => {
    const m = unitMultiplier(p);
    const inv = unitInverseMultiplier(p);
    let s = initState(p);
    for (let i = 0; i < 50; i++) s = applyUnitBuy(s, 'yes', m, p);
    for (let i = 0; i < 50; i++) s = applyUnitSell(s, 'yes', inv, p);
    expect(s.qYes).toBe(0n);
    const d = s.eYes > WAD ? s.eYes - WAD : WAD - s.eYes;
    expect(d <= WAD / 10n ** 9n + 10n, `round-trip eYes drift ${d}`).toBe(true);
  });

  it('sell proceeds are ≥0, rounded DOWN, and never exceed the matching buy cost (spread favors pool)', () => {
    const s0 = initState(p);
    const s1 = applyBuyExact(s0, 'yes', 10n * WAD, p);
    const buyCost = costSats(s0, s1, p);
    const sellProceeds = proceedsSats(s1, s0, p); // sell right back to the start
    expect(sellProceeds >= 0n).toBe(true);
    expect(sellProceeds <= buyCost, `proceeds ${sellProceeds} > cost ${buyCost}`).toBe(true);
    // floor vs the true-ish unrounded proceeds: floor never rounds up
    const raw = ((costFnUnits(s1, p) - costFnUnits(s0, p)) * PAYOUT) / WAD;
    expect(sellProceeds).toBe(raw);
  });

  it('cannot sell more than the net outstanding (both sides, both paths)', () => {
    const s0 = initState(p);
    const s1 = applyBuyExact(s0, 'yes', 2n * WAD, p);
    expect(() => applySellExact(s1, 'yes', 3n * WAD, p)).toThrow();
    expect(() => applySellExact(s1, 'no', 1n * WAD, p)).toThrow(); // no NO outstanding
    expect(() => applyUnitSell(s0, 'yes', unitInverseMultiplier(p), p)).toThrow();
  });

  it('NO-side sell works symmetrically', () => {
    const s0 = initState(p);
    const s1 = applyBuyExact(s0, 'no', 4n * WAD, p);
    const back = applySellExact(s1, 'no', 4n * WAD, p);
    expect(back.qNo).toBe(0n);
    expect(back.eNo).toBe(s0.eNo);
  });

  it('rejects negative deltas on the exact paths', () => {
    const s0 = initState(p);
    expect(() => applyBuyExact(s0, 'yes', -1n, p)).toThrow();
    expect(() => applySellExact(s0, 'yes', -1n, p)).toThrow();
  });
});
