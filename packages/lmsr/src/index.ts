// @pm/lmsr — pure integer LMSR reference (ground truth). No I/O, no chain, no DB (Golden Rule 5).
//
// STUB — implemented in ticket LMSR-001. Intended surface (all bigint, scaled by SCALE; see ADR-007):
//
//   export interface MarketState { qYes: bigint; qNo: bigint; eYes: bigint; eNo: bigint; b: bigint; }
//   export function priceYes(s: MarketState, scale: bigint): bigint;   // 0..payoutUnit
//   export function costToBuy(s: MarketState, side: Side, shares: bigint): bigint;  // sats
//   export function applyBuy(s: MarketState, side: Side, shares: bigint): MarketState;
//   export function maxLoss(b: bigint, scale: bigint): bigint;         // b*ln2
//
// The multiplicative-state trick lives here so the Rúnar contract (@pm/contracts) can mirror the exact
// integer transitions this module defines.

export const PLACEHOLDER = true;
