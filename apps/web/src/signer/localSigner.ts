// DEV ONLY — a trader key held in this browser tab so the app is usable without a BRC-100 wallet installed.
// This is NOT production custody: the key lives in localStorage. The UI labels it plainly wherever it is used.
// Same interface as WalletSigner, so nothing else in the app knows or cares which one is active.
import { PrivateKey } from '@bsv/sdk';
import { orderPayload, type OrderFields, type PaymentRequest, type Signer } from './index';

const KEY = 'pm.dev.trader.wif';

export class LocalSigner implements Signer {
  readonly kind = 'local' as const;
  private readonly priv: PrivateKey;

  constructor() {
    let wif = localStorage.getItem(KEY);
    if (!wif) {
      wif = PrivateKey.fromRandom().toWif();
      localStorage.setItem(KEY, wif);
    }
    this.priv = PrivateKey.fromWif(wif);
  }

  /** Start over as a different trader (handy for demoing several participants in one browser). */
  static reset(): void {
    localStorage.removeItem(KEY);
  }

  async identityKey(): Promise<string> {
    return this.priv.toPublicKey().toDER('hex') as string;
  }

  async signOrder(o: OrderFields): Promise<{ sig: string; sigScheme: 'ecdsa' }> {
    return { sig: this.priv.sign(orderPayload(o), 'utf8').toDER('hex') as string, sigScheme: 'ecdsa' };
  }
  /**
   * A development key holds no funds, so it cannot buy. This is deliberate and it is the honest failure: since
   * FUND-001 a buy requires a real payment, so trading without a wallet is no longer possible rather than
   * silently free. The UI catches this and tells the user to connect a BRC-100 wallet.
   */
  async pay(_p: PaymentRequest): Promise<{ txid: string; rawTx: string }> {
    throw new Error(
      'the development key cannot pay for a bet — connect a BSV wallet (e.g. MetaNet Desktop) to trade',
    );
  }

}
