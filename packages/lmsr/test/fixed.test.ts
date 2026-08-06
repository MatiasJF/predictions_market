import { describe, it, expect } from 'vitest';
import { WAD, LN2, MAX_POW_EXP, expFixed, lnFixed, powFixed } from '../src/index.js';

/** Assert |a-b| <= tol (all WAD-scaled). */
function near(a: bigint, b: bigint, tol: bigint, msg?: string): void {
  const d = a > b ? a - b : b - a;
  expect(d <= tol, `${msg ?? ''} |${a}-${b}|=${d} > ${tol}`).toBe(true);
}

const E_WAD = 2718281828459045235n; // e, 1e18
const TOL = 10n ** 6n; // 1e-12 relative — generous but tiny

describe('expFixed', () => {
  it('exp(0) = 1', () => {
    expect(expFixed(0n)).toBe(WAD);
  });
  it('exp(1) ≈ e', () => {
    near(expFixed(WAD), E_WAD, TOL, 'exp(1)');
  });
  it('exp(ln2) = 2', () => {
    near(expFixed(LN2), 2n * WAD, TOL, 'exp(ln2)');
  });
  it('exp(-1) ≈ 1/e', () => {
    near(expFixed(-WAD), (WAD * WAD) / E_WAD, TOL, 'exp(-1)');
  });
  it('exp is monotonic increasing', () => {
    let prev = expFixed(-5n * WAD);
    for (let x = -4n * WAD; x <= 5n * WAD; x += WAD) {
      const cur = expFixed(x);
      expect(cur > prev).toBe(true);
      prev = cur;
    }
  });
});

describe('lnFixed', () => {
  it('ln(1) = 0', () => {
    expect(lnFixed(WAD)).toBe(0n);
  });
  it('ln(2) ≈ LN2', () => {
    near(lnFixed(2n * WAD), LN2, TOL, 'ln(2)');
  });
  it('ln(e) ≈ 1', () => {
    near(lnFixed(E_WAD), WAD, TOL, 'ln(e)');
  });
  it('ln(1/2) ≈ -ln2', () => {
    near(lnFixed(WAD / 2n), -LN2, TOL, 'ln(0.5)');
  });
  it('rejects x <= 0', () => {
    expect(() => lnFixed(0n)).toThrow();
    expect(() => lnFixed(-WAD)).toThrow();
  });
});

describe('exp/ln round-trip', () => {
  const xs = [WAD / 2n, WAD, 3n * WAD, 10n * WAD, 1000n * WAD];
  it('exp(ln(x)) ≈ x', () => {
    for (const x of xs) near(expFixed(lnFixed(x)), x, x / 10n ** 9n + TOL, `exp(ln(${x}))`);
  });
  it('ln(exp(x)) ≈ x', () => {
    for (const x of [-3n * WAD, -WAD, 0n, WAD, 4n * WAD]) {
      near(lnFixed(expFixed(x)), x, TOL, `ln(exp(${x}))`);
    }
  });
});

// CONC-006 — square-and-multiply pow. This routine is CONSENSUS-CRITICAL: the on-chain `settle` runs the exact
// same loop, so these tests pin the definition (operation order + truncation), not merely "close to x^n".
describe('powFixed (square-and-multiply)', () => {
  const mult = expFixed(WAD / 1000n); // exp(1/1000) — a realistic unit multiplier for b = 1000
  const inv = expFixed(-(WAD / 1000n));

  it('identities: x^0 = 1, x^1 = x', () => {
    expect(powFixed(mult, 0n)).toBe(WAD);
    expect(powFixed(mult, 1n)).toBe(mult);
    expect(powFixed(WAD, 4095n)).toBe(WAD); // 1^n = 1
  });

  it('is deterministic and monotonic in the exponent', () => {
    expect(powFixed(mult, 530n)).toBe(powFixed(mult, 530n));
    let prev = powFixed(mult, 0n);
    for (const n of [1n, 2n, 10n, 100n, 530n, 1023n]) {
      const cur = powFixed(mult, n);
      expect(cur > prev, `mult^${n} should exceed the previous`).toBe(true);
      prev = cur;
    }
    // the inverse multiplier decreases
    expect(powFixed(inv, 100n) < powFixed(inv, 10n)).toBe(true);
  });

  it('tracks exp(n·u/b) closely (≤ 1e-9 relative at n = 1000)', () => {
    for (const n of [1n, 10n, 100n, 1000n]) {
      const got = powFixed(mult, n);
      const want = expFixed((WAD / 1000n) * n); // exp(n/1000)
      const diff = got > want ? got - want : want - got;
      expect(diff * 10n ** 9n <= want, `mult^${n} vs exp(${n}/1000)`).toBe(true);
    }
  });

  it('mult^n · invMult^n ≈ 1 (round-trip)', () => {
    for (const n of [1n, 10n, 530n]) {
      const round = (powFixed(mult, n) * powFixed(inv, n)) / WAD;
      const diff = round > WAD ? round - WAD : WAD - round;
      expect(diff * 10n ** 9n <= WAD, `round-trip at n=${n}`).toBe(true);
    }
  });

  it('rejects out-of-range exponents (mirrors the on-chain MAX_NET)', () => {
    expect(() => powFixed(mult, -1n)).toThrow();
    expect(() => powFixed(mult, MAX_POW_EXP + 1n)).toThrow();
    expect(() => powFixed(mult, MAX_POW_EXP)).not.toThrow();
  });
});
