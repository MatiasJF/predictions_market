// Signed off-chain fill receipts (CONC-001). A receipt is the trader's proof of a fill AND the sequencer's
// signed attestation of the resulting market state (a state commitment). Anyone holding the signer's public key
// can verify it. Signatures are ECDSA over a canonical payload via @bsv/sdk. NEVER stores a private key.
import { Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';
import type { Side } from '@pm/lmsr';

export type OrderAction = 'buy' | 'sell';

/** The canonical, signed record of one off-chain fill (the trader keeps it as proof). */
export interface Receipt {
  marketId: number;
  seq: number; // per-market monotonic fill index (1-based)
  trader: string; // trader public key, DER hex
  side: Side;
  action: OrderAction;
  shares: string; // WAD-scaled bigint (total shares filled), decimal string
  priceSats: number; // marginal fill price after the fill
  costSats: number; // charge (buy) or proceeds (sell)
  qYes: string;
  qNo: string;
  eYes: string;
  eNo: string; // resulting market state (bigints as decimal strings)
  stateHash: string; // sha256 of the state commitment (hex)
  ts: number; // sequencer timestamp (ms)
}

/** Canonical byte string a receipt signs over. Stable field order — any change invalidates old signatures. */
export function receiptPayload(r: Receipt): string {
  return [
    r.marketId, r.seq, r.trader, r.side, r.action, r.shares,
    r.priceSats, r.costSats, r.qYes, r.qNo, r.eYes, r.eNo, r.stateHash, r.ts,
  ].join('|');
}

/** sha256 commitment to the resulting LMSR state — the on-chain settlement will advance to a matching net state. */
export function stateCommitment(qYes: bigint, qNo: bigint, eYes: bigint, eNo: bigint): string {
  return Utils.toHex(Hash.sha256(`${qYes}|${qNo}|${eYes}|${eNo}`, 'utf8'));
}

export interface ReceiptSigner {
  readonly publicKeyHex: string; // DER hex — stored in the DB (public only)
  sign(payload: string): string; // DER hex signature over the payload
}

/** ECDSA receipt signer from a WIF. The private key stays in memory only (Golden Rule 6). */
export class WifReceiptSigner implements ReceiptSigner {
  private readonly priv: PrivateKey;
  readonly publicKeyHex: string;
  constructor(wif: string) {
    this.priv = PrivateKey.fromWif(wif);
    this.publicKeyHex = this.priv.toPublicKey().toDER('hex') as string;
  }
  sign(payload: string): string {
    return this.priv.sign(payload, 'utf8').toDER('hex') as string;
  }
}

/** Verify a receipt against the signer's public key. Anyone can run this — no secrets needed. */
export function verifyReceipt(r: Receipt, sig: string, signerPubkeyHex: string): boolean {
  try {
    const pub = PublicKey.fromString(signerPubkeyHex);
    return pub.verify(receiptPayload(r), Signature.fromDER(sig, 'hex'), 'utf8');
  } catch {
    return false;
  }
}
