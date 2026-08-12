// Assembling the proof a wallet needs before it will accept money (FUND-001, step 7).
//
// Paying a winner at a BRC-29 destination made the money *derivable*. It does not make it *appear*. For that,
// the winner's wallet has to `internalizeAction` the payment — and that call takes the transaction as
// **AtomicBEEF**, not raw hex: the wallet insists on being able to verify the transaction itself rather than
// trusting whoever handed it over. Which is the correct instinct, and the reason this file exists.
//
// A BEEF is verifiable one of two ways: carry a merkle path for the transaction itself, or carry its ancestry
// back to transactions that have one.
//
// This file used to take the first route only, and therefore made a payout claimable **only once it confirmed**
// — roughly a ten-minute wait, on the grounds that the second route was hopeless because a payout spends the
// pool covenant (a ~40 KB unlock script) and "its ancestry chains back through every settlement".
//
// That last part was wrong, and the error is worth naming because it cost users a ten-minute wall for no reason.
// **Ancestry stops at the first proven transaction.** It does not run to the genesis of the market. A payout's
// inputs are the resolve transaction and a funding UTXO, both of which are already mined and both of which
// therefore have merkle paths of their own. The walk is one level deep, not N settlements deep.
//
// So `atomicBeef` now tries the cheap route first and falls back to assembling from the parents. The result is
// bigger on the wire (a mined payout is ~82 KB of itself; the unmined form also carries its parents) which is
// exactly why the cheap route is still tried first — but it means a winner can take their money the moment the
// payout is broadcast, which is what internalizing a payment should have required all along.
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
   * AtomicBEEF for `txid`, hex-encoded, or `undefined` if the chain cannot prove it at all. `undefined` means
   * "ask again later", never "this transaction is bad".
   *
   * Being unconfirmed is NOT a reason to return undefined — see the note at the top of this file.
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

  /**
   * @param rawTxOf fetches raw transaction hex by txid, INCLUDING while it is still in the mempool. Without it
   *   the unconfirmed path is unavailable and this behaves as it did before: mined transactions only.
   */
  constructor(
    private readonly chain: 'main' | 'test' = 'main',
    private readonly rawTxOf?: (txid: string) => Promise<string | undefined>,
  ) {}

  async atomicBeef(txid: string): Promise<string | undefined> {
    const hit = this.cache.get(txid);
    if (hit) return hit;
    // The cheap route: one lookup, and the smallest possible BEEF. Works only once mined.
    try {
      const services = await this.load();
      const beef = await services.getBeefForTxid(txid);
      // Atomic: the subject transaction plus exactly what proves it, and nothing else.
      const hex = Buffer.from(beef.toBinaryAtomic(txid)).toString('hex');
      this.cache.set(txid, hex);
      return hex;
    } catch {
      // Not mined, or the service is unreachable. Fall through and try to build it from the parents.
    }
    return this.fromParents(txid);
  }

  /**
   * Assemble a BEEF for an unconfirmed transaction out of its parents' proofs.
   *
   * Deliberately NOT cached: this is the shape a transaction has only while it is unconfirmed, and caching it
   * would keep serving the large form long after the small one became available.
   */
  private async fromParents(txid: string): Promise<string | undefined> {
    if (!this.rawTxOf) return undefined;
    try {
      const rawHex = await this.rawTxOf(txid);
      if (!rawHex) return undefined;
      const tx = Transaction.fromHex(rawHex);

      const services = await this.load();
      const beef = new Beef();
      for (const input of tx.inputs) {
        const parent = input.sourceTXID;
        if (!parent) return undefined;
        // If a parent is ALSO unconfirmed this throws, and returning undefined is the honest answer: the walk
        // would have to go deeper and this is not the place to recurse without a depth bound.
        beef.mergeBeef((await services.getBeefForTxid(parent)).toBinary());
      }
      beef.mergeRawTx([...Buffer.from(rawHex, 'hex')]);
      return Buffer.from(beef.toBinaryAtomic(txid)).toString('hex');
    } catch {
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
