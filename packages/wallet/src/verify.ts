import { Transaction } from '@bsv/sdk';
import { findPaymentOutput } from './brc29.js';

/**
 * Confirms a payment transaction actually exists on the network.
 *
 * This seam is not optional decoration — it closes the obvious hole in the payment gate. A trader's wallet
 * builds and broadcasts the payment, but the daemon only ever sees the raw transaction the client hands it.
 * Without an independent check, a trader could construct a perfectly valid payment, NOT broadcast it, submit it
 * for a fill, and then spend those inputs elsewhere. The fill would be real; the money never would be. That is
 * the free option coming back through a side door.
 */
export interface ChainCheck {
  /** True if the network has this transaction (mempool or mined). */
  exists(txid: string): Promise<boolean>;
  /**
   * Push a signed transaction to the network ourselves, returning true if it is now there.
   *
   * MAINNET-010. Waiting for someone else's wallet to propagate turned out to be the wrong design. On mainnet
   * (2026-08-10) a trader's wallet signed three payments, handed all three to the browser, and broadcast
   * exactly one — the other two existed nowhere on the network, confirmed or unconfirmed. From the daemon's
   * side that is indistinguishable from a trader trying to get a fill without paying, so it refused, correctly
   * and uselessly: the trader could see the transaction in their own wallet and could not spend it into the
   * market.
   *
   * We are holding the signed transaction. Sending it costs nothing, cannot forge anything (it is signed by
   * the trader's keys, not ours), and turns "your wallet failed to broadcast" from a dead end into a
   * non-event. Re-broadcasting one the network already has is a no-op.
   */
  publish?(rawTxHex: string): Promise<boolean>;
  /**
   * The block height a transaction was mined in, or `undefined` while it is still unconfirmed.
   *
   * Cheap enough to poll, unlike assembling a BEEF. It exists so a winner's "claim" button can be *disabled*
   * until claiming can actually succeed, rather than enabled and then failing — a payout is only claimable once
   * mined, and letting someone press a button whose only possible outcome is an error is its own small defect.
   */
  minedAt?(txid: string): Promise<number | undefined>;
}

/** WhatsOnChain — the same service the rest of the project uses for chain queries. */
export class WocChainCheck implements ChainCheck {
  constructor(private readonly network: 'main' | 'test' = 'main') {}
  async exists(txid: string): Promise<boolean> {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/tx/hash/${txid}`);
    return res.ok;
  }

  async minedAt(txid: string): Promise<number | undefined> {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/tx/hash/${txid}`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { blockheight?: number };
      // WoC reports height 0 for a mempool transaction, which is not a block.
      return body.blockheight && body.blockheight > 0 ? body.blockheight : undefined;
    } catch {
      return undefined;
    }
  }

  async publish(rawTxHex: string): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/tx/raw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txhex: rawTxHex }),
      });
    } catch {
      return false; // the service is unreachable; the caller falls back to asking whether it turned up anyway
    }
    if (res.ok) return true;
    // "already known" is success wearing an error's clothes — the goal is the transaction being on the
    // network, and it already is.
    const body = (await res.text().catch(() => '')).toLowerCase();
    return /already|txn-already-known|in the mempool|in mempool/.test(body);
  }
}

/**
 * For `PM_NETWORK=local`, where transactions are built and Script-verified but deliberately never broadcast.
 * Accepts everything — correct offline, and catastrophic on mainnet, which is why selecting it is tied to the
 * network setting rather than left to a flag someone might flip.
 */
export class OfflineChainCheck implements ChainCheck {
  async exists(): Promise<boolean> {
    return true;
  }
}

export interface VerifiedPayment {
  txid: string;
  outputIndex: number;
  satoshis: number;
}

/**
 * Verify a trader's payment against what we asked them to pay.
 *
 * Order matters: parse → check it pays US → check the amount → check it is on the network. Each failure is
 * reported distinctly, because "malformed", "paid someone else", "paid too little" and "never broadcast" are
 * four different conversations to have with a user.
 */
export async function verifyPayment(
  rawTxHex: string,
  expectedLockingScript: string,
  minSats: number,
  chain: ChainCheck,
): Promise<VerifiedPayment> {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(rawTxHex);
  } catch {
    throw new Error('payment: could not parse the payment transaction');
  }
  const { outputIndex, satoshis } = findPaymentOutput(tx.outputs, expectedLockingScript, minSats);
  const txid = tx.id('hex');
  // Only after the transaction is known to pay US, the right amount, do we help it onto the network. Order
  // matters: publishing first would make us a free relay for anything a client cared to POST.
  if (!(await chain.exists(txid))) await chain.publish?.(rawTxHex);
  if (!(await seenOnChain(txid, chain))) {
    throw new TransientPaymentError(
      `payment: transaction ${txid.slice(0, 16)}… has not reached the network yet — it may still be propagating`,
    );
  }
  return { txid, outputIndex, satoshis };
}

/**
 * A payment that is not WRONG, only not visible yet.
 *
 * The distinction is load-bearing and was missing at first, which cost a real trader a real payment on mainnet
 * (2026-08-10, `16bbde85…`): their wallet broadcast 1,002 sat, WhatsOnChain had not indexed it at the instant we
 * asked, and the intent was marked `rejected` — permanently burning a quote the trader had *already paid*. A
 * transient network condition must never consume something irreplaceable, so this type exists to let the caller
 * leave the intent alone and be retried.
 */
export class TransientPaymentError extends Error {
  readonly transient = true as const;
}

/**
 * Ask the network a few times before believing "no".
 *
 * A wallet broadcasts and returns immediately; an indexer sees the transaction a beat later. Between those two
 * moments a single query answers "no" truthfully and misleadingly at once. Three tries over ~4 seconds covers
 * the ordinary case without making a genuinely-unbroadcast payment wait around.
 */
async function seenOnChain(txid: string, chain: ChainCheck, attempts = 3, gapMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await chain.exists(txid)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}
