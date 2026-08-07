// Real BSV wallet signing over BRC-100 (the production path). The user's private key never leaves their wallet:
// we ask it to sign the order payload with `counterparty: 'anyone'`, which lets the daemon verify from the
// public identity key alone — no wallet, no key, no callback to this browser.
import { Transaction, Utils, WalletClient } from '@bsv/sdk';
import { ORDER_PROTOCOL_ID, orderKeyID, orderPayload, type OrderFields, type PaymentRequest, type Signer } from './index';

export class WalletSigner implements Signer {
  readonly kind = 'wallet' as const;
  private readonly wallet = new WalletClient();
  private cached?: string;

  /** True if a BRC-100 wallet is actually reachable (e.g. MetaNet Desktop). */
  static async available(): Promise<boolean> {
    try {
      const w = new WalletClient();
      const { authenticated } = await w.isAuthenticated();
      return authenticated === true;
    } catch {
      return false;
    }
  }

  async identityKey(): Promise<string> {
    if (!this.cached) {
      const { publicKey } = await this.wallet.getPublicKey({ identityKey: true });
      this.cached = publicKey;
    }
    return this.cached;
  }

  async signOrder(o: OrderFields): Promise<{ sig: string; sigScheme: 'brc100' }> {
    const { signature } = await this.wallet.createSignature({
      data: Utils.toArray(orderPayload(o), 'utf8'),
      protocolID: ORDER_PROTOCOL_ID,
      keyID: orderKeyID(o.nonce),
      counterparty: 'anyone',
    });
    return { sig: Utils.toHex(signature), sigScheme: 'brc100' };
  }
  /**
   * Pay for a bet. The wallet builds, funds, signs AND broadcasts the payment — we never see a key, and the
   * user approves the amount in their own wallet UI.
   *
   * `createAction` returns the transaction as Atomic BEEF; the daemon verifies a raw transaction, so it is
   * converted here rather than teaching the server a second format.
   */
  async pay(p: PaymentRequest): Promise<{ txid: string; rawTx: string }> {
    const { txid, tx } = await this.wallet.createAction({
      description: p.description.slice(0, 50), // BRC-100 caps this at 50 bytes, and the wallet SHOWS it
      outputs: [{
        lockingScript: p.lockingScript,
        satoshis: p.satoshis,
        outputDescription: 'Market stake',
      }],
    });
    if (!tx) throw new Error('wallet did not return the payment transaction');
    return { txid: txid ?? '', rawTx: Transaction.fromAtomicBEEF(tx).toHex() };
  }

}
