// Fixed-point (WAD = 1e18) exp/ln over BigInt — deterministic off-chain reference math.
//
// These use unbounded series + loops. That is ALLOWED here: @pm/lmsr is the off-chain ground truth
// (Golden Rule 5). The on-chain Rúnar contract must NOT compute exp/ln (no such primitives, no loops —
// ADR-002); it relies on precomputed multipliers instead (ADR-007). This module exists so the contract's
// integer transitions can be checked against exact math.

/** Fixed-point unit: values represent x = X / WAD. */
export const WAD = 10n ** 18n;

/** ln(2), WAD-scaled (truncated at 1e-18). */
export const LN2 = 693147180559945309n;

/** Fixed-point multiply: (a/WAD)·(b/WAD) → result/WAD. */
export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/**
 * Maximum exponent `powFixed` accepts — mirrors the on-chain `MAX_NET` (12 bits) so a batch the sequencer can
 * compute is exactly a batch the contract can verify (CONC-006 / ADR-025).
 */
export const MAX_POW_EXP = 4095n;

/**
 * base^exp with base and the result WAD-scaled, by SQUARE-AND-MULTIPLY (CONC-006).
 *
 * THE OPERATION ORDER IS CONSENSUS-CRITICAL. The on-chain `settle` runs this exact loop, so any change to the
 * order/rounding here breaks settlement verification (safely — the contract just rejects). The bit test avoids
 * `%` (`e - (e/2)*2`) because only `*` and `/` are known-good in the sCrypt method body. Truncating division at
 * each step is deliberate and part of the definition.
 *
 * Note this does NOT equal multiplying by `base` `exp` times — repeated squaring rounds differently (and in
 * fact more accurately, ~log₂ truncations instead of `exp` of them). The settled state is DEFINED by this
 * routine on both sides.
 */
export function powFixed(base: bigint, exp: bigint): bigint {
  if (exp < 0n) throw new Error('powFixed: exp must be ≥ 0');
  if (exp > MAX_POW_EXP) throw new Error(`powFixed: exp must be ≤ ${MAX_POW_EXP} (on-chain MAX_NET)`);
  let factor = WAD; // 1.0
  let b = base;
  let e = exp;
  for (let i = 0; i < 12; i++) {
    const half = e / 2n;
    if (e - half * 2n === 1n) factor = (factor * b) / WAD; // bit set → multiply in
    b = (b * b) / WAD; // square
    e = half;
  }
  return factor;
}

/**
 * exp(x) with x and the result WAD-scaled. Supports negative x.
 * Range-reduces x = k·ln2 + f (f ∈ [0, ln2)) then Taylor-expands exp(f), and scales by 2^k.
 */
export function expFixed(x: bigint): bigint {
  if (x < 0n) {
    const pos = expFixed(-x); // exp(-|x|) = WAD² / exp(|x|)
    return (WAD * WAD) / pos;
  }
  const k = x / LN2;
  const f = x - k * LN2;

  // Taylor: exp(f) = Σ fⁿ/n!  (f < ln2 < 0.7 → fast convergence)
  let term = WAD; // n = 0 term
  let sum = WAD;
  for (let n = 1n; n <= 60n; n++) {
    term = (term * f) / WAD / n;
    if (term === 0n) break;
    sum += term;
  }
  return sum << k; // × 2^k
}

/**
 * ln(x) with x (> 0) and the result WAD-scaled. Result is negative for x < WAD.
 * Writes x = 2^k·m with m ∈ [1,2), then ln(m) = 2·Σ y^(2i+1)/(2i+1), y = (m−1)/(m+1).
 */
export function lnFixed(x: bigint): bigint {
  if (x <= 0n) throw new Error('lnFixed: x must be > 0');
  if (x === WAD) return 0n;

  let k = 0n;
  let m = x;
  while (m >= 2n * WAD) {
    m /= 2n;
    k += 1n;
  }
  while (m < WAD) {
    m *= 2n;
    k -= 1n;
  }

  const y = ((m - WAD) * WAD) / (m + WAD); // y ∈ [0, 1/3)
  const y2 = mul(y, y);
  let term = y;
  let sum = y;
  for (let n = 3n; n <= 121n; n += 2n) {
    term = mul(term, y2);
    const add = term / n;
    if (add === 0n) break;
    sum += add;
  }
  return k * LN2 + 2n * sum;
}
