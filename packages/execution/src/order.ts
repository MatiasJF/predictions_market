// Trader-authenticated orders (LIVE-001a). Before this, `submit()` took a trader pubkey as a plain string and
// verified NOTHING — the operator (or anyone with API access) could fabricate fills in any user's name. Here an
// order is only fillable if the trader's own key signed it, so a receipt is evidence the user actually traded.
// Mirrors the ECDSA pattern in receipt.ts; the trader's private key never leaves their wallet.
import { PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import type { Side } from '@pm/lmsr';
import type { OrderAction } from './receipt.js';

/**
 * How the trader signed (UI-001). Both schemes prove the same thing — the order was authorized by the key it
 * claims — and both reject tampering and impersonation.
 *  - `ecdsa`   — raw ECDSA over the payload. The CLI/runner path; this is what the mainnet runs used.
 *  - `brc100`  — a real BSV wallet signing via BRC-100 `createSignature`. The browser path: the private key
 *                never leaves the user's wallet, and the daemon verifies WITHOUT the wallet.
 */
export type SigScheme = 'ecdsa' | 'brc100';

/** BRC-100 signing context. Fixed so any verifier can reproduce the derived key. */
export const ORDER_PROTOCOL_ID: [0 | 1 | 2, string] = [0, 'pm order'];
export const orderKeyID = (nonce: number): string => String(nonce);

/** The order a trader signs. `nonce` is per-trader-per-market and makes a signed order single-use. */
export interface SignedOrderFields {
  marketId: number;
  trader: string; // trader public key / BRC-100 identity key — the key that must have signed
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
 * Verify an order was authorized by the trader it claims — the impersonation guard: the signature is always
 * checked against `o.trader`, so a valid signature from A submitted under B's key fails, under either scheme.
 *
 * The BRC-100 branch is what makes real-wallet trading possible: the trader signs in their wallet with
 * `counterparty: 'anyone'`, and anyone (here, the daemon) can verify from their public identity key alone —
 * no wallet, no private key, no callback to the client.
 */
export async function verifyOrder(o: SignedOrderFields, sig: string, scheme: SigScheme = 'ecdsa'): Promise<boolean> {
  try {
    if (scheme === 'brc100') {
      const { valid } = await new ProtoWallet('anyone').verifySignature({
        data: Utils.toArray(orderPayload(o), 'utf8'),
        signature: Utils.toArray(sig, 'hex'),
        protocolID: ORDER_PROTOCOL_ID,
        keyID: orderKeyID(o.nonce),
        counterparty: o.trader,
      });
      return valid === true;
    }
    return PublicKey.fromString(o.trader).verify(orderPayload(o), Signature.fromDER(sig, 'hex'), 'utf8');
  } catch {
    return false;
  }
}
