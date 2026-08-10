/**
 * What the bonding curve will do, previewed before a market exists.
 *
 * LMSR has always priced this market as a bonding curve; what it did not have was any way to SEE the curve's
 * shape before committing to it. Market #7 shipped with a hard-coded `b=1000` against trades of two shares,
 * which pinned every displayed price at 500 sat and made the curve look like a fixed price. `b` is the one
 * number that decides how much a bet moves the market, so it needs to be visible while it is being chosen.
 *
 * From a fresh market (`qNo = 0`, `qYes = n`) the LMSR price of YES is
 *
 *     payout · e^(n/b) / (e^(n/b) + e^0)  =  payout / (1 + e^(-n/b))
 *
 * Floating point is fine here and only here: this is a label, never a charge. Every satoshi that actually
 * changes hands is computed by `@pm/lmsr` in exact integer arithmetic. `curve.test.ts` pins this approximation
 * against that exact math so the preview cannot quietly drift from what the engine will really charge.
 */
export function previewPrice(bUnits: number, payoutUnit: number, buys: number): number {
  return Math.round(payoutUnit / (1 + Math.exp(-buys / bUnits)));
}

/**
 * The most this market can lose, which the operator underwrites: `b · ln2 · payoutUnit`.
 *
 * The same knob that makes the curve interesting also sets the exposure, and in the same direction — a smaller
 * `b` moves prices more AND risks less. Worth showing next to the input rather than in a doc, because the
 * temptation is to raise `b` for "more liquidity" without noticing what it costs.
 */
export function maxLossSats(bUnits: number, payoutUnit: number): number {
  return Math.round(bUnits * Math.LN2 * payoutUnit);
}
