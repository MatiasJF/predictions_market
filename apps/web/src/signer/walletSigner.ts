// Real BSV wallet signing over BRC-100 (the production path). The user's private key never leaves their wallet:
// we ask it to sign the order payload with `counterparty: 'anyone'`, which lets the daemon verify from the
// public identity key alone — no wallet, no key, no callback to this browser.
import { Utils, WalletClient } from '@bsv/sdk';
import { ORDER_PROTOCOL_ID, orderKeyID, orderPayload, type OrderFields, type Signer } from './index';

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
}
