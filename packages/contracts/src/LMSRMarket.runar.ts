import { StatefulSmartContract, assert, mulDiv, safediv } from 'runar-lang';

/**
 * LMSRMarket — native on-chain LMSR pool (buy path). CONTRACT-002: the crux math-feasibility contract.
 *
 * Mirrors the `@pm/lmsr` reference in Rúnar Script, using ONLY on-chain-available ops (mulDiv/safediv) —
 * no exp/ln, no loops (ADR-002). Two techniques from the reference:
 *   • Multiplicative state (ADR-007): a unit buy multiplies the side's e-value by the precomputed
 *     `mult = exp(unit/b)·scale` → `newE = mulDiv(e, mult, scale)`.
 *   • Post-trade-price cost (ADR-011): charge = ceil(newE · payoutUnit / (newE + otherE)), an MM-safe
 *     upper bound computable without ln. Rounded UP so the pool never undercharges.
 *
 * Sell (CONTRACT-003) is the mirror: multiply the side's e by the precomputed inverse `invMult`
 * (= exp(−unit/b)·scale), pay out floor(newE · payoutUnit / (newE + otherE)) — rounded DOWN so the pool
 * never overpays — and guard `q ≥ unit` so net shares never go negative. Scoped like buy: this proves the
 * pool-side math/state transition; ownership enforcement (burning the seller's YES/NO token) is TOKEN-001.
 *
 * State carried across transactions (mutable, OP_PUSH_TX), in declaration order:
 *   eYes, eNo (multiplicative state) · qYes, qNo (net shares, for settlement) · collateral (sats held).
 * Compile-time constants (readonly, baked into the script):
 *   mult (= exp(unit/b)·scale) · invMult (= exp(−unit/b)·scale) · payoutUnit · scale (WAD) · unit.
 *
 * Scope note: `unit == scale` (one-share unit) here, so the charge needs no unit factor; multi-unit trades
 * (via `pow`) are a later ticket. Collateral is tracked as state (like a token balance) rather than bound to
 * the UTXO's satoshis — that binding (via extractAmount) compiles but can't be exercised in the offline
 * interpreter, so it's deferred to the on-chain deploy ticket.
 */
export class LMSRMarket extends StatefulSmartContract {
  eYes: bigint;
  eNo: bigint;
  qYes: bigint;
  qNo: bigint;
  collateral: bigint;
  readonly mult: bigint;
  readonly invMult: bigint;
  readonly payoutUnit: bigint;
  readonly scale: bigint;
  readonly unit: bigint;

  constructor(
    eYes: bigint,
    eNo: bigint,
    qYes: bigint,
    qNo: bigint,
    collateral: bigint,
    mult: bigint,
    invMult: bigint,
    payoutUnit: bigint,
    scale: bigint,
    unit: bigint,
  ) {
    super(eYes, eNo, qYes, qNo, collateral, mult, invMult, payoutUnit, scale, unit);
    this.eYes = eYes;
    this.eNo = eNo;
    this.qYes = qYes;
    this.qNo = qNo;
    this.collateral = collateral;
    this.mult = mult;
    this.invMult = invMult;
    this.payoutUnit = payoutUnit;
    this.scale = scale;
    this.unit = unit;
  }

  public buyYes(paymentSats: bigint, outputSatoshis: bigint) {
    const newEYes = mulDiv(this.eYes, this.mult, this.scale); // multiplicative state update
    const sum = newEYes + this.eNo;
    // MM-safe charge = ceil(newEYes · payoutUnit / sum)  (post-trade YES price × 1 share, rounded up)
    const charge = safediv(newEYes * this.payoutUnit + sum - 1n, sum);
    assert(paymentSats >= charge);
    this.addOutput(
      outputSatoshis,
      newEYes,
      this.eNo,
      this.qYes + this.unit,
      this.qNo,
      this.collateral + paymentSats,
    );
  }

  public buyNo(paymentSats: bigint, outputSatoshis: bigint) {
    const newENo = mulDiv(this.eNo, this.mult, this.scale);
    const sum = this.eYes + newENo;
    const charge = safediv(newENo * this.payoutUnit + sum - 1n, sum);
    assert(paymentSats >= charge);
    this.addOutput(
      outputSatoshis,
      this.eYes,
      newENo,
      this.qYes,
      this.qNo + this.unit,
      this.collateral + paymentSats,
    );
  }

  public sellYes(outputSatoshis: bigint) {
    assert(this.qYes >= this.unit); // can't sell more than the net outstanding (keeps q ≥ 0, e ≥ scale)
    const newEYes = mulDiv(this.eYes, this.invMult, this.scale); // multiplicative inverse update
    const sum = newEYes + this.eNo;
    // MM-safe proceeds = floor(newEYes · payoutUnit / sum)  (post-trade YES price × 1 share, rounded down)
    const proceeds = safediv(newEYes * this.payoutUnit, sum);
    assert(this.collateral >= proceeds);
    this.addOutput(
      outputSatoshis,
      newEYes,
      this.eNo,
      this.qYes - this.unit,
      this.qNo,
      this.collateral - proceeds,
    );
  }

  public sellNo(outputSatoshis: bigint) {
    assert(this.qNo >= this.unit);
    const newENo = mulDiv(this.eNo, this.invMult, this.scale);
    const sum = this.eYes + newENo;
    const proceeds = safediv(newENo * this.payoutUnit, sum);
    assert(this.collateral >= proceeds);
    this.addOutput(
      outputSatoshis,
      this.eYes,
      newENo,
      this.qYes,
      this.qNo - this.unit,
      this.collateral - proceeds,
    );
  }
}
