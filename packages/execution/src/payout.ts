// PAYOUT-001 — the receipt → on-chain payout bridge (off-chain half).
//
// After a market resolves, a trader's position is an audited signed receipt, not a token — so `redeem` (which
// requires a co-spent minted token) cannot pay them. This module derives, from those receipts, exactly who is
// owed what, and commits to that list so the on-chain payout is auditable and (via the sequencer attestation)
// bond-backed.
//
// Nice property: traders are identified by their PUBLIC KEY, so the payout address is derived straight from the
// key they traded with — the key you trade with is the key you get paid to. No registration step.
import { Hash, PublicKey, Utils } from '@bsv/sdk';
import { WAD, type Side } from '@pm/lmsr';
import type { Db, ExecOrderRow } from '@pm/persistence';

export interface WinnerPayout {
  trader: string; // trader public key (DER hex)
  pkh: string; // hash160 of that key — where the satoshis go
  shares: string; // WAD-scaled winning shares
  sats: number; // shares × payoutUnit
}

/**
 * Where a winner's satoshis go, given the key they traded with. Returns the hash160 to pay.
 *
 * A hook rather than a hard-coded `pkhOf` because the answer needs a private key the execution package must
 * never hold: FUND-001 pays winners at a BRC-29 destination derived for them, so their own wallet recognises
 * the money and takes custody of it. The daemon supplies that; the default below is the pre-FUND-001 behaviour.
 */
export type PayoutDestination = (traderPubkeyHex: string) => string;

/**
 * Who is owed what, from the fill ledger. Folds each trader's NET position on the winning side (buys − sells,
 * the same fold `positionsOf` uses) and drops anyone not net-long: losers and flat traders get nothing.
 * Deterministic order (by trader pubkey) so the digest is stable.
 */
export function winningPayouts(
  db: Db,
  marketId: number,
  winner: Side,
  payoutUnit: bigint,
  destination: PayoutDestination = pkhOf,
): WinnerPayout[] {
  const rows = db
    .prepare('SELECT * FROM exec_orders WHERE market_id = ? ORDER BY seq')
    .all(marketId) as ExecOrderRow[];

  const net = new Map<string, bigint>();
  for (const r of rows) {
    if (r.side !== winner) continue; // only the winning side pays out
    const signed = (r.action === 'buy' ? 1n : -1n) * BigInt(r.shares);
    net.set(r.trader_pubkey, (net.get(r.trader_pubkey) ?? 0n) + signed);
  }

  return [...net.entries()]
    .filter(([, shares]) => shares > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([trader, shares]) => ({
      trader,
      pkh: destination(trader),
      shares: shares.toString(),
      sats: Number((shares * payoutUnit) / WAD),
    }))
    .filter((p) => p.sats > 0);
}

/**
 * hash160 of a trader's public key — their payout address, derived with no extra registration.
 *
 * LEGACY as of FUND-001: paying an identity key's own hash160 puts the money outside the recipient wallet's
 * basket flow, so a winner saw nothing they could spend. Kept because markets paid before FUND-001 were paid
 * here and their rows must still resolve; new payouts derive a per-payment key instead.
 */
export function pkhOf(traderPubkeyHex: string): string {
  return PublicKey.fromString(traderPubkeyHex).toHash('hex') as string;
}

/** Commitment to the ordered payout list — pinned on-chain (OP_RETURN) by the `payout` tx. */
export function computePayoutDigest(list: WinnerPayout[]): string {
  const canonical = list.map((p) => `${p.trader}|${p.pkh}|${p.shares}|${p.sats}`).join('\n');
  return Utils.toHex(Hash.sha256(canonical, 'utf8'));
}

/** Total satoshis a payout list moves out of the pool — must be ≤ the pool's collateral (the contract checks). */
export function payoutTotal(list: WinnerPayout[]): number {
  return list.reduce((s, p) => s + p.sats, 0);
}
