// The trader's signing seam. An order is only fillable if the trader's own key signed it, and that key must
// never reach the daemon — so signing happens here, in the browser, and the daemon verifies from the public
// identity key alone.
//
//   WalletSigner — a REAL BSV wallet over BRC-100. The private key stays in the user's wallet.
//   LocalSigner  — a dev key in this tab. Clearly labelled in the UI; for running the app without a wallet.
//
// Everything else in the app depends only on this interface, so swapping custody changes nothing else.
export interface OrderFields {
  marketId: number;
  trader: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  units: number;
  nonce: number;
}

export type SigScheme = 'ecdsa' | 'brc100';

export interface Signer {
  readonly kind: 'wallet' | 'local';
  /** Public identity the daemon will verify against. */
  identityKey(): Promise<string>;
  signOrder(o: OrderFields): Promise<{ sig: string; sigScheme: SigScheme }>;
  /**
   * FUND-001: actually pay for a buy. Returns the raw payment transaction so the daemon can verify it pays the
   * quoted destination — and so a fill only exists if money really moved.
   *
   * This is the capability that separates a real wallet from the dev key: `LocalSigner` cannot implement it
   * (it holds no funds), which is exactly why an unfunded browser cannot place a buy any more.
   */
  pay(p: PaymentRequest): Promise<{ txid: string; rawTx: string }>;
}

export interface PaymentRequest {
  /** Hex locking script the daemon derived for this order. Pay THIS, not an address of your choosing. */
  lockingScript: string;
  satoshis: number;
  /** Shown to the user in their wallet's approval prompt — keep it recognisable. */
  description: string;
}

/** Canonical payload — must match `orderPayload` in @pm/execution exactly, or signatures won't verify. */
export function orderPayload(o: OrderFields): string {
  return [o.marketId, o.trader, o.side, o.action, String(o.units), o.nonce].join('|');
}

export const ORDER_PROTOCOL_ID: [0 | 1 | 2, string] = [0, 'pm order'];
export const orderKeyID = (nonce: number): string => String(nonce);
