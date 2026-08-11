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
  /**
   * A transaction's raw hex, or `undefined` if the network does not have it.
   *
   * Needed to SPEND a stake: signing an input requires the output being spent, and the stake pot's UTXOs live
   * on chain rather than in any wallet we keep.
   */
  rawTx?(txid: string): Promise<string | undefined>;
  /**
   * Is this address ALREADY funded, and with which transaction?
   *
   * MAINNET-012. Without this a trader who pays and then hits any failure between paying and filling
   * is asked to pay again: the client requests a fresh quote, gets a fresh one-time destination, and
   * the wallet dutifully sends a second payment. The first is stranded at an address that bought
   * nothing. That is how 1,002 sat was lost on 2026-08-10, and the retry advice given at the time —
   * "press it again" — is exactly what triggers it.
   *
   * Answering "you already paid this" is the only way to make a retry safe.
   */
  fundedAt?(address: string, minSats: number): Promise<{ txid: string; rawTx: string } | undefined>;
  /**
   * What an address is actually worth, counting money already on its way out.
   *
   * MAINNET-014. Summing an address's unspent outputs OVERSTATES it the moment anything is pending:
   * the list still contains the inputs a mempool transaction is spending AND the change it creates,
   * so both are counted. Right after two deploys costing 8,148 sat the operator's wallet panel read
   * 405,270 against a real 198,615 — a number that would have been reassuring at exactly the wrong
   * moment, since an operator checks this balance BEFORE authorizing the next spend.
   *
   * `unconfirmed` here is the NET mempool delta (negative while a spend is in flight), so
   * `confirmed + unconfirmed` is self-correcting without enumerating or de-duplicating anything.
   */
  balanceOf?(address: string): Promise<{ confirmed: number; unconfirmed: number; spendable: number }>;
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

  async rawTx(txid: string): Promise<string | undefined> {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/tx/${txid}/hex`);
      if (!res.ok) return undefined;
      const hex = (await res.text()).trim();
      return /^[0-9a-f]+$/i.test(hex) ? hex : undefined;
    } catch {
      return undefined;
    }
  }

  async balanceOf(address: string): Promise<{ confirmed: number; unconfirmed: number; spendable: number }> {
    const at = async (which: 'confirmed' | 'unconfirmed') => {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/address/${address}/${which}/balance`);
      if (!res.ok) throw new Error(`balance: ${which} lookup failed (${res.status})`);
      const body = (await res.json()) as Record<string, number>;
      return Number(body[which] ?? 0);
    };
    const [confirmed, unconfirmed] = await Promise.all([at('confirmed'), at('unconfirmed')]);
    return { confirmed, unconfirmed, spendable: confirmed + unconfirmed };
  }

  async fundedAt(address: string, minSats: number): Promise<{ txid: string; rawTx: string } | undefined> {
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/address/${address}/unspent`);
      if (!res.ok) return undefined;
      const utxos = (await res.json()) as { tx_hash: string; value: number; isSpentInMempoolTx?: boolean }[];
      // Largest first, and never one already being spent in the mempool — that output is gone, it
      // just has not been mined away yet.
      const hit = utxos
        .filter((u) => u.value >= minSats && u.isSpentInMempoolTx !== true)
        .sort((a, b) => b.value - a.value)[0];
      if (!hit) return undefined;
      const rawTx = await this.rawTx(hit.tx_hash);
      return rawTx ? { txid: hit.tx_hash, rawTx } : undefined;
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
