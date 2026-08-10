// BRC-29 payment derivation — how one party pays another such that the RECIPIENT'S WALLET recognises the money
// and takes custody of it.
//
// Why this exists (FUND-001). Two defects share one root cause:
//   1. Traders never paid for a bet. They signed a message; nothing collected anything.
//   2. Winners were paid to `hash160(identity pubkey)` — an address outside the normal BRC-100 basket flow, so
//      the recipient's wallet showed nothing meaningful and the money looked lost.
// Both are fixed by paying to a ONE-TIME key derived for the counterparty, and telling them how it was derived
// so their wallet can internalize it. The derivation is symmetric: the payer derives a public key using the
// recipient's identity key, and the recipient derives the matching private key using the payer's.
//
// Verified end-to-end on Node 20 with @bsv/sdk 2.1.9 before any of this was built (ADR-039): keys correspond
// and the recipient can spend the resulting P2PKH.
import { Hash, KeyDeriver, P2PKH, PrivateKey, PublicKey, Random, Utils, type WalletProtocol } from '@bsv/sdk';

/**
 * The BRC-29 protocol identifier. Security level 2 = per-counterparty keys requiring explicit permission; the
 * string is fixed by the standard, so do NOT invent a project-specific one — a different protocol ID derives a
 * different key and the recipient's wallet would never find the money.
 */
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8'];

/** BRC-43 key ID: the two derivation nonces, space-separated. Order matters. */
export const brc29KeyID = (prefix: string, suffix: string): string => `${prefix} ${suffix}`;

/** A fresh base64 nonce. `prefix` is per payment request, `suffix` per output. */
export const newDerivationNonce = (): string => Utils.toBase64(Random(8));

/**
 * Nonces derived from a caller-chosen scope string instead of randomness — same scope, same destination, for
 * ever.
 *
 * Random nonces are right for a payment REQUEST (the trader asks, we quote, we store), because there is a
 * database row created at the same moment to remember them in. They are wrong for a PAYOUT, because a payout's
 * destination has to be agreed on before the money moves and stay identical afterwards:
 *
 *   - the payout digest commits to every winner's address, so the preview, the built transaction and any
 *     rebuild after a restart must all derive the same one or the commitment is worthless;
 *   - and — the real reason — the nonces are what make the money spendable. `payment_intents` is honest that
 *     losing the table loses money. Deriving a payout's nonces from `(market, trader)` means a winner can be
 *     paid again, or repaid, from nothing but the market id and the key they traded with. No row to lose.
 *
 * Predictability costs nothing here: the key ID travels in the clear inside every remittance anyway, and
 * deriving the private key still needs one of the two identity keys.
 */
export function scopedNonces(scope: string): { prefix: string; suffix: string } {
  const h = Hash.sha256(scope, 'utf8');
  return { prefix: Utils.toBase64(h.slice(0, 8)), suffix: Utils.toBase64(h.slice(8, 16)) };
}

/**
 * Everything the recipient needs to internalize a payment, and everything we must persist to be able to spend
 * it ourselves later. This is the payload that travels alongside the transaction — losing it means losing the
 * ability to derive the key, which means the satoshis are unrecoverable even though they are "ours".
 */
export interface PaymentRemittance {
  derivationPrefix: string;
  derivationSuffix: string;
  /** Identity key of the party that PAID. The recipient derives against this. */
  senderIdentityKey: string;
}

export interface DerivedDestination {
  /** Hex P2PKH locking script to pay to. */
  lockingScript: string;
  /** Address form, for display and for chain queries. */
  address: string;
  /** hash160 of the one-time public key — what the covenant's payout method takes as a winner. */
  pkh: string;
  /** The one-time public key the script pays. */
  publicKey: string;
  remittance: PaymentRemittance;
}

/**
 * PAYER side: derive a one-time destination that only `recipientIdentityKey` can spend.
 *
 * `derivePublicKey(..., forSelf = false)` derives the COUNTERPARTY's key — the recipient's. Passing `forSelf`
 * true here would derive our own key and quietly pay ourselves, which is the single most expensive mistake
 * available in this file.
 */
export function deriveDestination(
  payerKey: PrivateKey,
  recipientIdentityKey: string,
  nonces?: { prefix: string; suffix: string },
): DerivedDestination {
  const prefix = nonces?.prefix ?? newDerivationNonce();
  const suffix = nonces?.suffix ?? newDerivationNonce();
  const pub = new KeyDeriver(payerKey).derivePublicKey(
    BRC29_PROTOCOL,
    brc29KeyID(prefix, suffix),
    recipientIdentityKey,
  );
  const address = pub.toAddress();
  return {
    lockingScript: new P2PKH().lock(address).toHex(),
    address,
    pkh: pub.toHash('hex') as string,
    publicKey: pub.toString(),
    remittance: {
      derivationPrefix: prefix,
      derivationSuffix: suffix,
      senderIdentityKey: payerKey.toPublicKey().toString(),
    },
  };
}

/**
 * RECIPIENT side: derive the private key for a payment made to us, so we can spend it.
 *
 * The server needs this even while using a wallet: it is what lets us prove (in a test, or during recovery)
 * that a payment we accepted is genuinely spendable rather than merely present on chain.
 */
export function derivePaymentKey(
  recipientKey: PrivateKey,
  remittance: PaymentRemittance,
): PrivateKey {
  return new KeyDeriver(recipientKey).derivePrivateKey(
    BRC29_PROTOCOL,
    brc29KeyID(remittance.derivationPrefix, remittance.derivationSuffix),
    remittance.senderIdentityKey,
  );
}

/** The address a remittance resolves to for us — cheap way to locate the output in a transaction. */
export function derivePaymentAddress(recipientKey: PrivateKey, remittance: PaymentRemittance): string {
  return derivePaymentKey(recipientKey, remittance).toPublicKey().toAddress();
}

/**
 * Find the output in `tx` that pays a derived destination, and check it pays at least `minSats`.
 *
 * This is the verification behind the payment gate, and it is deliberately strict about the failure it reports:
 * "no output pays us" and "an output pays us but too little" are different problems, and conflating them makes
 * a short payment look like a missing one.
 */
export function findPaymentOutput(
  outputs: readonly { satoshis?: number; lockingScript: { toHex(): string } }[],
  expectedLockingScript: string,
  minSats: number,
): { outputIndex: number; satoshis: number } {
  const want = expectedLockingScript.toLowerCase();
  let bestIndex = -1;
  let best = 0;
  outputs.forEach((o, i) => {
    if (o.lockingScript.toHex().toLowerCase() !== want) return;
    const sats = o.satoshis ?? 0;
    if (sats > best) { best = sats; bestIndex = i; }
  });
  if (bestIndex < 0) throw new Error('payment: no output pays the expected destination');
  if (best < minSats) {
    throw new Error(`payment: underpaid — output pays ${best} sat, expected at least ${minSats}`);
  }
  return { outputIndex: bestIndex, satoshis: best };
}

/** Public identity key for a private key, as hex — the form every remittance and API uses. */
export const identityKeyOf = (key: PrivateKey): string => key.toPublicKey().toString();

/** Parse an identity key defensively; a malformed one must fail loudly, not derive a garbage destination. */
export function assertIdentityKey(hex: string): string {
  try {
    return PublicKey.fromString(hex).toString();
  } catch {
    throw new Error(`payment: invalid identity key '${String(hex).slice(0, 16)}…'`);
  }
}
