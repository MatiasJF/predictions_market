// Trader-authenticated orders (LIVE-001a). Before this, `submit()` took a trader pubkey as a plain string and
// verified NOTHING — the operator (or anyone with API access) could fabricate fills in any user's name. Here an
// order is only fillable if the trader's own key signed it, so a receipt is evidence the user actually traded.
// Mirrors the ECDSA pattern in receipt.ts; the trader's private key never leaves their wallet.
import { PrivateKey, PublicKey, Signature } from '@bsv/sdk';
import type { Side } from '@pm/lmsr';
import type { OrderAction } from './receipt.js';

/** The order a trader signs. `nonce` is per-trader-per-market and makes a signed order single-use. */
export interface SignedOrderFields {
  marketId: number;
  trader: string; // trader public key, DER hex — the key that must have signed
  side: Side;
  action: OrderAction;
  units: bigint;
  nonce: number;
}

/** Canonical bytes an order signs over. Stable field order — changing it invalidates existing signatures. */
export function orderPayload(o: SignedOrderFields): string {
  return [o.marketId, o.trader, o.side, o.action, o.units.toString(), o.nonce].join('|');
}

/**
 * Create a trader wallet. This is CLIENT-side material: the `wif` stays in the trader's wallet and is never
 * sent to the daemon — only the pubkey and the per-order signature are. Traders need no BSV to trade; the
 * operator pays all on-chain fees.
 */
export function makeTraderWallet(): { wif: string; pubkey: string } {
  const priv = PrivateKey.fromRandom();
  return { wif: priv.toWif(), pubkey: priv.toPublicKey().toDER('hex') as string };
}

/** Sign an order with the trader's key (client-side; the daemon never sees this key). */
export function signOrder(traderWif: string, o: SignedOrderFields): string {
  return PrivateKey.fromWif(traderWif).sign(orderPayload(o), 'utf8').toDER('hex') as string;
}

/**
 * Verify an order was authorized by the trader it claims. Also the impersonation guard: the signature is checked
 * against `o.trader`, so a valid signature from A submitted under B's pubkey fails.
 */
export function verifyOrder(o: SignedOrderFields, sig: string): boolean {
  try {
    return PublicKey.fromString(o.trader).verify(orderPayload(o), Signature.fromDER(sig, 'hex'), 'utf8');
  } catch {
    return false;
  }
}
