// Pure integer LMSR reference (ground truth). No I/O, no chain, no DB (Golden Rule 5).
//
// Representation (see docs/GLOSSARY, ADR-006/007):
//   - WAD = 1e18 fixed point. Shares (qYes/qNo) and b are share-units, WAD-scaled (1 share = WAD).
//   - Prices/costs convert to sats via payoutUnit (sats a winning share pays, e.g. 100000).
//   - State carries eYes=exp(qYes/b), eNo=exp(qNo/b) — the multiplicative-state trick (ADR-007).
//   - Pool holds exactly C(q)=b·ln(eYes+eNo) units; C(q) ≥ max(qYes,qNo) always ⇒ solvent; max loss b·ln2.

import { WAD, LN2, expFixed, lnFixed, mul } from './fixed.js';

export type Side = 'yes' | 'no';

export interface MarketParams {
  /** Liquidity, share-units, WAD-scaled (e.g. 2n*WAD gives the doc's "b = 200,000 sats" at 1e5 payout). */
  b: bigint;
  /** Sats a winning share redeems for (e.g. 100000n). */
  payoutUnit: bigint;
  /** Fixed trade unit in shares, WAD-scaled (e.g. WAD = 1 share) — basis of the multiplicative trick. */
  unit: bigint;
}

export interface MarketState {
  qYes: bigint; // net YES shares, WAD-scaled
  qNo: bigint; // net NO shares, WAD-scaled
  eYes: bigint; // exp(qYes/b), WAD-scaled
  eNo: bigint; // exp(qNo/b), WAD-scaled
}

const ceilDiv = (a: bigint, d: bigint): bigint => (a + d - 1n) / d;

/** exp(q/b), WAD-scaled, with q and b both WAD-scaled (q/b is dimensionless). */
function expQoverB(q: bigint, b: bigint): bigint {
  return expFixed((q * WAD) / b);
}

export function initState(p: MarketParams): MarketState {
  const e = expQoverB(0n, p.b); // = WAD
  return { qYes: 0n, qNo: 0n, eYes: e, eNo: e };
}

/** Precomputed multiplier exp(unit/b) for the on-chain-friendly multiplicative BUY update (ADR-007). */
export function unitMultiplier(p: MarketParams): bigint {
  return expFixed((p.unit * WAD) / p.b);
}

/** Precomputed inverse multiplier exp(-unit/b) for the multiplicative SELL update (ADR-007/008). */
export function unitInverseMultiplier(p: MarketParams): bigint {
  return expFixed(-((p.unit * WAD) / p.b));
}

/** Marginal YES price in sats, 0..payoutUnit. */
export function priceYesSats(s: MarketState, p: MarketParams): bigint {
  return (s.eYes * p.payoutUnit) / (s.eYes + s.eNo);
}

/** Marginal NO price in sats. YES + NO === payoutUnit exactly, by construction. */
export function priceNoSats(s: MarketState, p: MarketParams): bigint {
  return p.payoutUnit - priceYesSats(s, p);
}

/** Cost function C(q) = b·ln(eYes+eNo), share-units, WAD-scaled. The pool holds exactly this many units. */
export function costFnUnits(s: MarketState, p: MarketParams): bigint {
  return mul(p.b, lnFixed(s.eYes + s.eNo));
}

/** Pool balance implied by the state, in sats = C(q)·payoutUnit. */
export function poolSats(s: MarketState, p: MarketParams): bigint {
  return (costFnUnits(s, p) * p.payoutUnit) / WAD;
}

/** Market-maker maximum loss = b·ln2 (units)·payoutUnit, in sats. */
export function maxLossSats(p: MarketParams): bigint {
  return (p.b * LN2 * p.payoutUnit) / WAD / WAD;
}

/** Exact recompute of state after buying `delta` (WAD-scaled, ≥0) shares of a side. */
export function applyBuyExact(s: MarketState, side: Side, delta: bigint, p: MarketParams): MarketState {
  if (delta < 0n) throw new Error('applyBuyExact: delta must be ≥ 0 (use applySellExact to sell)');
  if (side === 'yes') {
    const qYes = s.qYes + delta;
    return { qYes, qNo: s.qNo, eYes: expQoverB(qYes, p.b), eNo: s.eNo };
  }
  const qNo = s.qNo + delta;
  return { qYes: s.qYes, qNo, eYes: s.eYes, eNo: expQoverB(qNo, p.b) };
}

/**
 * Exact recompute of state after selling `delta` (WAD-scaled, ≥0) shares of a side.
 * Guards `delta ≤ q` so net shares never go negative — this keeps eYes,eNo ≥ WAD and the sum ≥ 2·WAD,
 * so the div-by-zero / negative-C branches flagged by verification stay unreachable (ADR-008).
 */
export function applySellExact(s: MarketState, side: Side, delta: bigint, p: MarketParams): MarketState {
  if (delta < 0n) throw new Error('applySellExact: delta must be ≥ 0');
  if (side === 'yes') {
    if (delta > s.qYes) throw new Error('applySellExact: cannot sell more YES than the net outstanding');
    const qYes = s.qYes - delta;
    return { qYes, qNo: s.qNo, eYes: expQoverB(qYes, p.b), eNo: s.eNo };
  }
  if (delta > s.qNo) throw new Error('applySellExact: cannot sell more NO than the net outstanding');
  const qNo = s.qNo - delta;
  return { qYes: s.qYes, qNo, eYes: s.eYes, eNo: expQoverB(qNo, p.b) };
}

/**
 * Multiplicative-state update for a single unit buy — the path the on-chain contract mirrors.
 * `mult` must be unitMultiplier(p). Only bigint mul/add: no exp, no loop.
 */
export function applyUnitBuy(s: MarketState, side: Side, mult: bigint, p: MarketParams): MarketState {
  if (side === 'yes') {
    return { qYes: s.qYes + p.unit, qNo: s.qNo, eYes: mul(s.eYes, mult), eNo: s.eNo };
  }
  return { qYes: s.qYes, qNo: s.qNo + p.unit, eYes: s.eYes, eNo: mul(s.eNo, mult) };
}

/**
 * Multiplicative-state update for a single unit sell — divides the side's e by `inv`
 * (= unitInverseMultiplier(p)). Only bigint mul/sub: no exp, no loop. Guards q ≥ unit (ADR-008).
 */
export function applyUnitSell(s: MarketState, side: Side, inv: bigint, p: MarketParams): MarketState {
  if (side === 'yes') {
    if (s.qYes < p.unit) throw new Error('applyUnitSell: cannot sell more YES than the net outstanding');
    return { qYes: s.qYes - p.unit, qNo: s.qNo, eYes: mul(s.eYes, inv), eNo: s.eNo };
  }
  if (s.qNo < p.unit) throw new Error('applyUnitSell: cannot sell more NO than the net outstanding');
  return { qYes: s.qYes, qNo: s.qNo - p.unit, eYes: s.eYes, eNo: mul(s.eNo, inv) };
}

/** Cost in sats to move from `sFrom` to `sTo` for a BUY (≥0). Rounded UP so the pool stays MM-safe. */
export function costSats(sFrom: MarketState, sTo: MarketState, p: MarketParams): bigint {
  const c = costFnUnits(sTo, p) - costFnUnits(sFrom, p); // units, WAD-scaled
  if (c <= 0n) return 0n;
  return ceilDiv(c * p.payoutUnit, WAD);
}

/** Proceeds in sats for a SELL moving `sFrom`→`sTo` (≥0). Rounded DOWN so the pool never overpays (ADR-008). */
export function proceedsSats(sFrom: MarketState, sTo: MarketState, p: MarketParams): bigint {
  const c = costFnUnits(sFrom, p) - costFnUnits(sTo, p); // units, WAD-scaled, ≥0 for a sell
  if (c <= 0n) return 0n;
  return (c * p.payoutUnit) / WAD; // floor
}
