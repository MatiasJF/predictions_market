import { describe, it, expect } from 'vitest';
import { WAD, LN2, expFixed, lnFixed } from '../src/index.js';

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
