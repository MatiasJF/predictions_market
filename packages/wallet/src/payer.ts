// Paying money OUT of the stake pot (FUND-001 step 7b).
//
// Everything before this either verified a payment someone else made, or spent the pool covenant. This is the
// daemon originating an ordinary payment: a seller is owed satoshis and nothing has ever sent them any. On
// mainnet 2026-08-10 a real run booked 998 sat of proceeds that no code path could pay — the platform quietly
// defaulting on its own ledger.
//
// **Where the money comes from matters.** Stakes do not sit in a wallet; each one was paid to a one-time BRC-29
// address, spendable only by re-deriving its key. Paying sellers out of exactly those UTXOs is what makes "the
// pot" a real thing rather than an accounting fiction: the satoshis a trader staked are the satoshis another
// trader is paid with, and the pot's balance is the sum of stakes not yet paid out. Falling back to the
// operator's general funding wallet would have been easier and would have quietly reintroduced the operator
// subsidising the market.
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { deriveDestination, derivePaymentKey, scopedNonces, type PaymentRemittance } from './brc29.js';

/** A stake sitting at a one-time address, with the derivation needed to unlock it. */
export interface StakeUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** How the destination was derived when the trader paid it — the only way back to its key. */
  remittance: PaymentRemittance;
  /** The funding transaction, raw hex. Needed to sign: the sighash covers the output being spent. */
  sourceRawTx: string;
}

export interface ProceedsRecipient {
  /** Identity key of whoever is owed — a seller, and later anyone else the market owes. */
  trader: string;
  satoshis: number;
  /** Stable scope for the BRC-29 nonces, so the destination re-derives after a restart. See `scopedNonces`. */
  scope: string;
}

export interface ProceedsPayment {
  rawTx: string;
  txid: string;
  sizeBytes: number;
  feeSats: number;
  /** Total satoshis returned to the pot as change. */
  changeSats: number;
  paid: {
    trader: string;
    satoshis: number;
    outputIndex: number;
    pkh: string;
    remittance: PaymentRemittance;
  }[];
}

/** Miner minimum, as measured on mainnet (ADR-038): 100 satoshis per 1000 bytes. */
export const FEE_PER_KB = 100;

/**
 * Build and sign a payment from the stake pot to everyone it names.
 *
 * Deliberately NOT broadcast here — the caller puts it through the human sign-off queue first, like every other
 * spend in this system. A signed transaction that nobody has sent is inert.
 *
 * Fee handling is estimate-then-rebuild rather than a guess with padding: sign once to learn the true size, then
 * sign again with the fee that size implies. Two cheap passes beat either overpaying or landing under the
 * relay minimum, and this project has already been burned by both.
 */
export async function buildProceedsPayment(
  potKey: PrivateKey,
  stakes: readonly StakeUtxo[],
  recipients: readonly ProceedsRecipient[],
  feePerKb = FEE_PER_KB,
): Promise<ProceedsPayment> {
  if (recipients.length === 0) throw new Error('proceeds: nobody is owed anything');
  const owed = recipients.reduce((s, r) => s + r.satoshis, 0);
  if (owed <= 0) throw new Error('proceeds: nothing to pay');
  const available = stakes.reduce((s, u) => s + u.satoshis, 0);
  if (available < owed) {
    throw new Error(
      `proceeds: the stake pot holds ${available} sat but ${owed} sat is owed — it cannot cover its own book`,
    );
  }

  // Derive every destination once: the same values go into the transaction and into the record of it.
  const destinations = recipients.map((r) => ({
    ...r,
    dest: deriveDestination(potKey, r.trader, scopedNonces(r.scope)),
  }));

  const build = (feeSats: number): Transaction => {
    const tx = new Transaction();
    for (const s of stakes) {
      tx.addInput({
        sourceTransaction: Transaction.fromHex(s.sourceRawTx),
        sourceOutputIndex: s.vout,
        unlockingScriptTemplate: new P2PKH().unlock(derivePaymentKey(potKey, s.remittance)),
      });
    }
    for (const d of destinations) {
      tx.addOutput({ lockingScript: new P2PKH().lock(d.dest.address), satoshis: d.satoshis });
    }
    // Change goes back to the pot's own address, so what is left over is visible in one place and the pot's
    // balance means something. Dust is left to the miner rather than creating an unspendable output.
    const change = available - owed - feeSats;
    if (change >= 546) {
      tx.addOutput({ lockingScript: new P2PKH().lock(potKey.toPublicKey().toAddress()), satoshis: change });
    }
    return tx;
  };

  const probe = build(0);
  await probe.sign();
  const feeSats = Math.max(1, Math.ceil((probe.toHex().length / 2 / 1000) * feePerKb));
  if (available - owed - feeSats < 0) {
    throw new Error(`proceeds: the pot cannot cover ${owed} sat plus a ${feeSats} sat fee (holds ${available})`);
  }

  const tx = build(feeSats);
  await tx.sign();
  const rawTx = tx.toHex();
  const sizeBytes = rawTx.length / 2;
  const change = available - owed - feeSats;

  return {
    rawTx,
    txid: tx.id('hex'),
    sizeBytes,
    feeSats,
    changeSats: change >= 546 ? change : 0,
    paid: destinations.map((d, i) => ({
      trader: d.trader,
      satoshis: d.satoshis,
      outputIndex: i, // recipients are added first, in order, before any change output
      pkh: d.dest.pkh,
      remittance: d.dest.remittance,
    })),
  };
}
