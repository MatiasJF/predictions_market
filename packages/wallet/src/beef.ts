// Assembling the proof a wallet needs before it will accept money (FUND-001, step 7).
//
// Paying a winner at a BRC-29 destination made the money *derivable*. It does not make it *appear*. For that,
// the winner's wallet has to `internalizeAction` the payment — and that call takes the transaction as
// **AtomicBEEF**, not raw hex: the wallet insists on being able to verify the transaction itself rather than
// trusting whoever handed it over. Which is the correct instinct, and the reason this file exists.
//
// A BEEF is verifiable one of two ways: carry the whole ancestry back to something proven, or carry a merkle
// path for the transaction itself. The first is hopeless here — a payout spends the pool covenant, whose input
// script alone is ~40 KB, and its ancestry chains back through every settlement. The second is one lookup, and
// costs nothing once the transaction is mined. So: **a payout becomes claimable when it confirms**, not before.
// That is a real constraint on the user experience and it is stated rather than hidden.
import { Beef, Transaction } from '@bsv/sdk';
import { findPaymentOutput } from './brc29.js';

/**
 * Which output of a BEEF'd transaction pays a given hash160, and how much.
 *
 * `internalizeAction` needs the index, and reading it back off the transaction is better than persisting it:
 * the transaction is the thing that actually holds the money, so anything derived from it cannot drift from it.
 */
export function outputPayingPkh(atomicBeefHex: string, pkh: string): { outputIndex: number; satoshis: number } {
  const tx = Transaction.fromAtomicBEEF([...Buffer.from(atomicBeefHex, 'hex')]);
  return findPaymentOutput(tx.outputs, `76a914${pkh}88ac`, 1);
}

/**
 * Somewhere to get the AtomicBEEF for a mined transaction.
 *
 * A seam, not a convenience: the implementation needs `@bsv/wallet-toolbox` (which drags in knex and a second
 * native SQLite), and offline runs must not reach for the network at all. Keeping it behind an interface means
 * `local` gets a truthful "not available" instead of an import that only fails at request time.
 */
export interface BeefSource {
  /**
   * AtomicBEEF for `txid`, hex-encoded, or `undefined` if the chain cannot prove it yet — typically because it
   * is still unconfirmed. `undefined` means "ask again later", never "this transaction is bad".
   */
  atomicBeef(txid: string): Promise<string | undefined>;
}

/** Offline (`PM_NETWORK=local`): there is no chain to ask, and pretending otherwise would be a lie. */
export class NoBeefSource implements BeefSource {
  async atomicBeef(): Promise<undefined> {
    return undefined;
  }
}

/**
 * WhatsOnChain, via `@bsv/wallet-toolbox`'s `Services` — which already knows how to turn a TSC proof into a
 * `MerklePath` and wrap it as BEEF. Hand-rolling that conversion is exactly the kind of code that appears to
 * work and silently produces a proof no wallet accepts, so it is borrowed rather than written.
 *
 * Results are cached because a claim endpoint sits behind a polling UI, and each of these is a network round
 * trip returning tens of kilobytes. Mined transactions do not change, so the cache never needs invalidating.
 */
export class ToolboxBeefSource implements BeefSource {
  private readonly cache = new Map<string, string>();
  private services?: { getBeefForTxid(txid: string): Promise<Beef> };

  constructor(private readonly chain: 'main' | 'test' = 'main') {}

  async atomicBeef(txid: string): Promise<string | undefined> {
    const hit = this.cache.get(txid);
    if (hit) return hit;
    try {
      const services = await this.load();
      const beef = await services.getBeefForTxid(txid);
      // Atomic: the subject transaction plus exactly what proves it, and nothing else.
      const hex = Buffer.from(beef.toBinaryAtomic(txid)).toString('hex');
      this.cache.set(txid, hex);
      return hex;
    } catch {
      // Unconfirmed, or the service is unreachable. Both mean "not yet", and neither is worth failing a request
      // over — the caller still has the remittance, which is the part that cannot be reconstructed.
      return undefined;
    }
  }

  /**
   * Loaded on first use: importing the toolbox pulls in knex and a second native SQLite build.
   *
   * And it does something worse, which is why this is not a bare `await import`. **The toolbox runs
   * `dotenv.config({ override: true })` at import time**, so merely loading it re-reads this repo's `.env` and
   * *overwrites* the running process's environment. That is not cosmetic here: the daemon reads `PM_NETWORK`
   * per request to decide whether to show the MAINNET warning and which explorer to link, and it would flip
   * under a claim — a UI whose entire job is to stop someone spending real money by accident, changing its mind
   * because a winner clicked a button. It would also conjure `PM_FUNDING_WIF` into a process deliberately
   * started without one. So the environment is snapshotted and put back exactly as it was.
   */
  private async load() {
    if (!this.services) {
      const before = { ...process.env };
      try {
        const { Services } = await import('@bsv/wallet-toolbox');
        this.services = new Services(this.chain) as unknown as { getBeefForTxid(txid: string): Promise<Beef> };
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
        Object.assign(process.env, before);
      }
    }
    return this.services;
  }
}
