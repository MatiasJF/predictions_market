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
}

/** WhatsOnChain — the same service the rest of the project uses for chain queries. */
export class WocChainCheck implements ChainCheck {
  constructor(private readonly network: 'main' | 'test' = 'main') {}
  async exists(txid: string): Promise<boolean> {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/tx/hash/${txid}`);
    return res.ok;
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
  if (!(await chain.exists(txid))) {
    throw new Error(`payment: transaction ${txid.slice(0, 16)}… is not on the network — was it broadcast?`);
  }
  return { txid, outputIndex, satoshis };
}
