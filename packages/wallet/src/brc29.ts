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
import { KeyDeriver, P2PKH, PrivateKey, PublicKey, Random, Utils, type WalletProtocol } from '@bsv/sdk';

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
