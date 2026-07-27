import { StatefulSmartContract, assert, mulDiv, safediv, cat, num2bin, hash160, toByteString } from 'runar-lang';
import { verifyRabinSig } from 'runar-lang/oracle';
import type { ByteString, PubKey, RabinSig, RabinPubKey } from 'runar-lang';

/**
 * LMSRMarket — native on-chain LMSR pool. Buy (CONTRACT-002), sell (CONTRACT-003), oracle resolve (SETTLE-001).
 *
 * Mirrors the `@pm/lmsr` reference in Rúnar Script using ONLY on-chain-available ops (mulDiv/safediv) —
 * no exp/ln, no loops (ADR-002):
 *   • Multiplicative state (ADR-007): buy → `newE = mulDiv(e, mult, scale)`; sell → `newE = mulDiv(e, invMult, scale)`.
 *   • Post-trade-price cost (ADR-011): buy charges ceil(newE·payoutUnit/(newE+otherE)) (round up, MM-safe);
 *     sell pays floor(newE·payoutUnit/(newE+otherE)) (round down, MM-safe).
 *   • Resolution (SETTLE-001): the oracle Rabin-signs `marketTag ‖ outcome`; `resolve()` verifies it with the
 *     baked-in `oracleN` and flips the pool to `resolved`. Trading is disabled once resolved.
 *
 * State (mutable, OP_PUSH_TX), declaration order — this is the addOutput arg order:
 *   eYes, eNo · qYes, qNo · collateral · resolved (0/1) · winner (0=NO,1=YES).
 * Compile-time constants (readonly, baked into the script):
 *   mult (exp(unit/b)·scale) · invMult (exp(−unit/b)·scale) · payoutUnit · scale (WAD) · unit ·
 *   oracleN (Rabin modulus) · marketTag (binds the oracle sig to THIS market).
 *
 * Spike scope (deferred to DEPLOY-001 / TOKEN-001): collateral is tracked as state, not bound to the UTXO's
 * satoshis (`extractAmount`); `outputSatoshis` is unconstrained; ownership (token burn on sell / winner
 * redemption) is TOKEN-001; interpreter ≠ mainnet.
 */
export class LMSRMarket extends StatefulSmartContract {
  eYes: bigint;
  eNo: bigint;
  qYes: bigint;
  qNo: bigint;
  collateral: bigint;
  resolved: bigint;
  winner: bigint;
  readonly mult: bigint;
  readonly invMult: bigint;
  readonly payoutUnit: bigint;
  readonly scale: bigint;
  readonly unit: bigint;
  readonly oracleN: RabinPubKey;
  readonly marketTag: ByteString;
  // ShareToken locking-script templates (code part + OP_RETURN) for a YES / NO token of THIS market,
  // with marketId + side baked in. buyYes/buyNo append `num2bin(1,8) ‖ buyerPubKey` to mint the buyer a token.
  readonly tokenCodeYes: ByteString;
  readonly tokenCodeNo: ByteString;

  constructor(
    eYes: bigint,
    eNo: bigint,
    qYes: bigint,
    qNo: bigint,
    collateral: bigint,
    resolved: bigint,
    winner: bigint,
    mult: bigint,
    invMult: bigint,
    payoutUnit: bigint,
    scale: bigint,
    unit: bigint,
    oracleN: RabinPubKey,
    marketTag: ByteString,
    tokenCodeYes: ByteString,
    tokenCodeNo: ByteString,
  ) {
    super(eYes, eNo, qYes, qNo, collateral, resolved, winner, mult, invMult, payoutUnit, scale, unit, oracleN, marketTag, tokenCodeYes, tokenCodeNo);
    this.eYes = eYes;
    this.eNo = eNo;
    this.qYes = qYes;
    this.qNo = qNo;
    this.collateral = collateral;
    this.resolved = resolved;
    this.winner = winner;
    this.mult = mult;
    this.invMult = invMult;
    this.payoutUnit = payoutUnit;
    this.scale = scale;
    this.unit = unit;
    this.oracleN = oracleN;
    this.marketTag = marketTag;
    this.tokenCodeYes = tokenCodeYes;
    this.tokenCodeNo = tokenCodeNo;
  }

  public buyYes(paymentSats: bigint, outputSatoshis: bigint, buyerPubKey: PubKey, tokenSats: bigint) {
    assert(this.resolved == 0n);
    const newEYes = mulDiv(this.eYes, this.mult, this.scale);
    const sum = newEYes + this.eNo;
    const charge = safediv(newEYes * this.payoutUnit + sum - 1n, sum);
    assert(paymentSats >= charge);
    this.addOutput(outputSatoshis, newEYes, this.eNo, this.qYes + this.unit, this.qNo, this.collateral + paymentSats, this.resolved, this.winner);
    // mint 1 YES share to the buyer: tokenCodeYes ‖ num2bin(supply=1, 8) ‖ buyerPubKey
    this.addRawOutput(tokenSats, cat(this.tokenCodeYes, cat(num2bin(1n, 8n), buyerPubKey)));
  }

  public buyNo(paymentSats: bigint, outputSatoshis: bigint, buyerPubKey: PubKey, tokenSats: bigint) {
    assert(this.resolved == 0n);
    const newENo = mulDiv(this.eNo, this.mult, this.scale);
    const sum = this.eYes + newENo;
    const charge = safediv(newENo * this.payoutUnit + sum - 1n, sum);
    assert(paymentSats >= charge);
    this.addOutput(outputSatoshis, this.eYes, newENo, this.qYes, this.qNo + this.unit, this.collateral + paymentSats, this.resolved, this.winner);
    // mint 1 NO share to the buyer
    this.addRawOutput(tokenSats, cat(this.tokenCodeNo, cat(num2bin(1n, 8n), buyerPubKey)));
  }

  public sellYes(outputSatoshis: bigint) {
    assert(this.resolved == 0n);
    assert(this.qYes >= this.unit);
    const newEYes = mulDiv(this.eYes, this.invMult, this.scale);
    const sum = newEYes + this.eNo;
    const proceeds = safediv(newEYes * this.payoutUnit, sum);
    assert(this.collateral >= proceeds);
    this.addOutput(outputSatoshis, newEYes, this.eNo, this.qYes - this.unit, this.qNo, this.collateral - proceeds, this.resolved, this.winner);
  }

  public sellNo(outputSatoshis: bigint) {
    assert(this.resolved == 0n);
    assert(this.qNo >= this.unit);
    const newENo = mulDiv(this.eNo, this.invMult, this.scale);
    const sum = this.eYes + newENo;
    const proceeds = safediv(newENo * this.payoutUnit, sum);
    assert(this.collateral >= proceeds);
    this.addOutput(outputSatoshis, this.eYes, newENo, this.qYes, this.qNo - this.unit, this.collateral - proceeds, this.resolved, this.winner);
  }

  /** Resolve the market on an oracle Rabin signature over `marketTag ‖ outcome` (outcome: 1=YES, 0=NO). */
  public resolve(sig: RabinSig, padding: ByteString, outcome: bigint, outputSatoshis: bigint) {
    assert(this.resolved == 0n);
    assert(outcome == 0n || outcome == 1n);
    const msg = cat(this.marketTag, num2bin(outcome, 1n));
    assert(verifyRabinSig(msg, sig, padding, this.oracleN));
    this.addOutput(outputSatoshis, this.eYes, this.eNo, this.qYes, this.qNo, this.collateral, 1n, outcome);
  }

  /**
   * Redeem a winning share (TOKEN-001c): pays `supply × payoutUnit` sats to `holderPubKey` and continues the
   * pool with reduced collateral. Requires the market resolved and `side == winner`. The winner's ShareToken
   * is burned in the same transaction (a separate input) as proof of ownership.
   *
   * DOCUMENTED TRUST GAP (spike): the pool trusts the supplied `supply`/`holderPubKey`/`side`. A production
   * version must cryptographically verify the co-spent token's genesis + supply (SPV/pushdata) — see VERDICT.
   */
  public redeem(supply: bigint, holderPubKey: PubKey, side: bigint, poolOutSats: bigint) {
    assert(this.resolved == 1n);
    assert(side == this.winner);
    assert(supply > 0n);
    const payout = supply * this.payoutUnit;
    assert(this.collateral >= payout);
    // output 0: pool continuation with collateral reduced by the payout
    this.addOutput(poolOutSats, this.eYes, this.eNo, this.qYes, this.qNo, this.collateral - payout, this.resolved, this.winner);
    // output 1: pay the winner — P2PKH script = 76a914 ‖ hash160(holder) ‖ 88ac
    const payoutScript = cat(cat(toByteString('76a914'), hash160(holderPubKey)), toByteString('88ac'));
    this.addRawOutput(payout, payoutScript);
  }
}
