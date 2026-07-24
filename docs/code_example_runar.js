import {
  StatefulSmartContract,
  assert,
  checkSig,
  PubKey,
  Sig,
  // Math helpers available in Rúnar
  mulDiv,   // safe (a * b) / c
  pow,
  log2,
  // Add more as needed
} from 'runar-lang';

/**
* Binary LMSR Market Maker on BSV via Rúnar
*
* State:
*   qYes, qNo  – net shares sold (fixed-point scaled, e.g. * 1e6)
*   b          – liquidity parameter (scaled)
*   collateral – satoshis locked to back the market
*
* Scaling: we treat 1e6 as 1.0 share for integer math.
* Price and cost use approximations of the LMSR formulas.
*/
class LMSRMarket extends StatefulSmartContract {
  // Mutable state carried in the UTXO
  qYes: bigint;          // net YES shares sold (scaled)
  qNo: bigint;           // net NO shares sold (scaled)
  b: bigint;             // liquidity parameter (scaled)
  collateral: bigint;    // satoshis currently locked
  readonly creator: PubKey;

  // Scaling constants (tune these)
  static readonly SCALE = 1_000_000n;           // 1 share = 1e6 units
  static readonly PRICE_SCALE = 1_000_000n;     // prices in micro-sats / micro-prob

  constructor(
    creator: PubKey,
    initialB: bigint,           // e.g. 10 * SCALE
    initialCollateral: bigint   // satoshis to fund the market
  ) {
    super(creator, 0n, 0n, initialB, initialCollateral);
    this.creator = creator;
    this.qYes = 0n;
    this.qNo = 0n;
    this.b = initialB;
    this.collateral = initialCollateral;
  }

  /**
   * Approximate cost of moving from (qYes, qNo) to (qYes + dYes, qNo + dNo)
   * Using a simplified / first-order + fixed-point LMSR cost.
   * Real implementation should use a proper fixed-point exp/log.
   */
  private approxCost(dYes: bigint, dNo: bigint): bigint {
    // Placeholder – replace with proper fixed-point LMSR:
    // C(q) ≈ b * log( exp(qYes/b) + exp(qNo/b) )
    // delta = C(new) - C(old)
    //
    // For demo we use a linear approximation + impact term.
    // In production integrate bsv-fixmath style exp/log or a series.

    const avgPriceYes = this.marginalPriceYes(); // 0..PRICE_SCALE
    const impact = mulDiv(dYes * dYes, 1n, this.b * 2n); // crude quadratic impact

    const costYes = mulDiv(dYes, avgPriceYes, LMSRMarket.PRICE_SCALE) + impact;
    // similar for NO side if needed
    return costYes > 0n ? costYes : 0n;
  }

  /** Marginal price of YES (0 .. PRICE_SCALE) – softmax approximation */
  private marginalPriceYes(): bigint {
    // p = exp(qYes/b) / (exp(qYes/b) + exp(qNo/b))
    // Approx with log2 / pow for illustration
    // Real code needs accurate fixed-point exp.
    if (this.qYes === this.qNo) return LMSRMarket.PRICE_SCALE / 2n;

    // Very rough placeholder
    const diff = this.qYes - this.qNo;
    // clamp and map to [0, PRICE_SCALE]
    // ... proper implementation omitted for brevity
    return LMSRMarket.PRICE_SCALE / 2n; // replace
  }

  /**
   * Buy YES shares. Caller pays the calculated cost in satoshis.
   * The contract UTXO must receive the payment (handled by SDK outputs).
   */
  public buyYes(
    buyer: PubKey,
    buyerSig: Sig,
    shares: bigint,          // number of shares * SCALE
    maxCost: bigint,         // slippage protection (satoshis)
    paymentSats: bigint      // actual satoshis being sent to the contract
  ) {
    assert(checkSig(buyerSig, buyer));
    assert(shares > 0n);

    const cost = this.approxCost(shares, 0n);
    assert(cost <= maxCost);
    assert(paymentSats >= cost);

    // Update state
    this.qYes += shares;
    this.collateral += paymentSats;

    // (Optional) emit YES tokens to buyer via multi-output / token standard
    // or keep pure accounting and redeem later.
  }

  public buyNo(
    buyer: PubKey,
    buyerSig: Sig,
    shares: bigint,
    maxCost: bigint,
    paymentSats: bigint
  ) {
    assert(checkSig(buyerSig, buyer));
    assert(shares > 0n);

    const cost = this.approxCost(0n, shares);
    assert(cost <= maxCost);
    assert(paymentSats >= cost);

    this.qNo += shares;
    this.collateral += paymentSats;
  }

  /**
   * Resolve the market (only creator or oracle).
   * Winner redeems 1 satoshi per winning share (or scaled).
   * In a full design you would also support early exit / selling back to the AMM.
   */
  public resolve(
    creatorSig: Sig,
    yesWins: boolean
  ) {
    assert(checkSig(creatorSig, this.creator));
    // Mark resolved, allow redemptions, etc.
    // (add a resolved flag + winner state)
  }

  // Additional methods you would add:
  // - sellYes / sellNo (buy back from AMM)
  // - redeem after resolution
  // - increaseLiquidity (raise b / collateral)
  // - emergency withdraw (creator only, with conditions)
}

export { LMSRMarket };
