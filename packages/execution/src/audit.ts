// Settlement auditing (CONC-003a). Makes a batch settlement publicly verifiable against the signed receipts it
// claims to clear — so any operator cheat (dropped/fabricated fills, wrong net, wrong cash, equivocation) is
// DETECTABLE and PROVABLE by anyone, without trusting the operator. The settle tx also pins `batchDigest` on-chain
// (OP_RETURN) and the sequencer signs an attestation binding batch→settlement; this module recomputes both from
// the receipts + the on-chain pool lineage and reports the specific violation on any mismatch.
import { Hash, PublicKey, Signature, Utils } from '@bsv/sdk';
import { WAD } from '@pm/lmsr';
import type { Db, ExecBatchRow, ExecOrderRow, PoolUtxoRow } from '@pm/persistence';
import { receiptPayload, stateCommitment, verifyReceipt, type Receipt, type ReceiptSigner } from './receipt.js';

/** Reconstruct the exact signed Receipt from a persisted exec_orders row (ts persisted since migration 007). */
export function receiptFromRow(r: ExecOrderRow): Receipt {
  return {
    marketId: r.market_id, seq: r.seq, trader: r.trader_pubkey, side: r.side, action: r.action,
    shares: r.shares, priceSats: r.price_sats, costSats: r.cost_sats,
    qYes: r.q_yes, qNo: r.q_no, eYes: r.e_yes, eNo: r.e_no, stateHash: r.state_hash, ts: r.ts ?? 0,
  };
}

/** Canonical commitment to a batch: sha256 over the ordered receipt payloads (seq order). Hex. */
export function computeBatchDigest(receipts: Receipt[]): string {
  return Utils.toHex(Hash.sha256(receipts.map(receiptPayload).join('\n'), 'utf8'));
}

/** The sequencer's settlement claim — binds a specific batch to a specific pool-version advance. */
export interface Attestation {
  marketId: number;
  fromVersion: number;
  toVersion: number;
  batchDigest: string;
  netYesUnits: string; // signed
  netNoUnits: string;
  netCollateralSats: number;
  newStateHash: string;
}

export function attestationPayload(a: Attestation): string {
  return [
    a.marketId, a.fromVersion, a.toVersion, a.batchDigest,
    a.netYesUnits, a.netNoUnits, a.netCollateralSats, a.newStateHash,
  ].join('|');
}

export function signAttestation(signer: ReceiptSigner, a: Attestation): { sig: string; pubkey: string } {
  return { sig: signer.sign(attestationPayload(a)), pubkey: signer.publicKeyHex };
}

export function verifyAttestation(a: Attestation, sig: string, pubkey: string): boolean {
  try {
    return PublicKey.fromString(pubkey).verify(attestationPayload(a), Signature.fromDER(sig, 'hex'), 'utf8');
  } catch {
    return false;
  }
}

export interface AuditViolation {
  check: string;
  detail: string;
}
export interface AuditReport {
  marketId: number;
  batchId: number;
  ok: boolean;
  receiptCount: number;
  violations: AuditViolation[];
  /** CONC-003b: whether this settlement carries an on-chain-verifiable Rabin attestation (slashable on equivocation). */
  rabinAttested: boolean;
}

/** Fold the settled receipts into net unit deltas + net cash — the ground truth the settlement must match. */
function netOf(receipts: Receipt[]): { netYesUnits: bigint; netNoUnits: bigint; netCollateralSats: number } {
  let netYesUnits = 0n;
  let netNoUnits = 0n;
  let netCollateralSats = 0;
  for (const r of receipts) {
    const units = (r.action === 'buy' ? 1n : -1n) * (BigInt(r.shares) / WAD);
    if (r.side === 'yes') netYesUnits += units;
    else netNoUnits += units;
    netCollateralSats += r.action === 'buy' ? r.costSats : -r.costSats;
  }
  return { netYesUnits, netNoUnits, netCollateralSats };
}

/**
 * Audit one settled batch against its receipts + the on-chain pool lineage. Returns every violation found (empty
 * ⇒ the settlement provably matches its signed receipts). Requires the batch to carry its CONC-003a commitment.
 */
export function auditSettlement(db: Db, marketId: number, batchId: number): AuditReport {
  const violations: AuditViolation[] = [];
  const batch = db.prepare('SELECT * FROM exec_batches WHERE id=? AND market_id=?').get(batchId, marketId) as
    | ExecBatchRow
    | undefined;
  if (!batch) return { marketId, batchId, ok: false, receiptCount: 0, violations: [{ check: 'batch', detail: 'no such batch' }], rabinAttested: false };

  const rows = db
    .prepare('SELECT * FROM exec_orders WHERE market_id=? AND batch_id=? ORDER BY seq')
    .all(marketId, batchId) as ExecOrderRow[];
  const receipts = rows.map(receiptFromRow);

  // 1. Every settled receipt must carry a valid sequencer signature.
  for (const r of rows) {
    if (!verifyReceipt(receiptFromRow(r), r.sig, r.signer_pubkey)) {
      violations.push({ check: 'receipt_sig', detail: `receipt seq ${r.seq} signature invalid` });
    }
  }

  // 2. Net derived from the receipts must equal the batch's recorded net.
  const net = netOf(receipts);
  if (net.netYesUnits.toString() !== batch.net_yes_units || net.netNoUnits.toString() !== batch.net_no_units) {
    violations.push({
      check: 'net_units',
      detail: `receipts net (YES ${net.netYesUnits}, NO ${net.netNoUnits}) != recorded (YES ${batch.net_yes_units}, NO ${batch.net_no_units})`,
    });
  }
  if (net.netCollateralSats !== batch.net_collateral_sats) {
    violations.push({
      check: 'net_cash',
      detail: `receipts net cash ${net.netCollateralSats} != recorded ${batch.net_collateral_sats}`,
    });
  }

  // 3. The recorded/on-chain batch digest must equal the digest recomputed from the receipts.
  const digest = computeBatchDigest(receipts);
  if (!batch.batch_digest) {
    violations.push({ check: 'digest', detail: 'batch has no commitment (pre-CONC-003a)' });
  } else if (digest !== batch.batch_digest) {
    violations.push({ check: 'digest', detail: `recomputed digest ${digest.slice(0, 16)}… != recorded ${batch.batch_digest.slice(0, 16)}…` });
  }

  // 4. On-chain tie: the pool's q delta from fromVersion→toVersion must equal the receipts' net (× unit).
  const fromPool = db.prepare('SELECT * FROM pool_utxos WHERE market_id=? AND version=?').get(marketId, batch.from_version) as PoolUtxoRow | undefined;
  const toPool = db.prepare('SELECT * FROM pool_utxos WHERE market_id=? AND version=?').get(marketId, batch.to_version) as PoolUtxoRow | undefined;
  if (!fromPool || !toPool) {
    violations.push({ check: 'onchain_state', detail: 'from/to pool version row missing' });
  } else {
    const dYes = BigInt(toPool.q_yes) - BigInt(fromPool.q_yes);
    const dNo = BigInt(toPool.q_no) - BigInt(fromPool.q_no);
    if (dYes !== net.netYesUnits * WAD || dNo !== net.netNoUnits * WAD) {
      violations.push({
        check: 'onchain_state',
        detail: `on-chain q delta (YES ${dYes}, NO ${dNo}) != receipts net×unit (YES ${net.netYesUnits * WAD}, NO ${net.netNoUnits * WAD})`,
      });
    }
  }

  // 5. The sequencer's attestation must verify over the recomputed settlement claim.
  if (!batch.attestation_sig || !batch.attestation_pubkey) {
    violations.push({ check: 'attestation', detail: 'batch has no attestation (pre-CONC-003a)' });
  } else if (toPool) {
    const att: Attestation = {
      marketId, fromVersion: batch.from_version, toVersion: batch.to_version,
      batchDigest: batch.batch_digest ?? '',
      netYesUnits: batch.net_yes_units, netNoUnits: batch.net_no_units, netCollateralSats: batch.net_collateral_sats,
      newStateHash: stateCommitment(BigInt(toPool.q_yes), BigInt(toPool.q_no), BigInt(toPool.e_yes), BigInt(toPool.e_no)),
    };
    if (!verifyAttestation(att, batch.attestation_sig, batch.attestation_pubkey)) {
      violations.push({ check: 'attestation', detail: 'attestation signature does not verify over the settlement claim' });
    }
  }

  return { marketId, batchId, ok: violations.length === 0, receiptCount: rows.length, violations, rabinAttested: !!batch.rabin_sig };
}
