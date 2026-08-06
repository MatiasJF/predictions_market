import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db, type ExecOrderRow } from '@pm/persistence';
import { WAD, type MarketParams } from '@pm/lmsr';
import {
  ExecutionEngine,
  WifReceiptSigner,
  computeBatchDigest,
  receiptFromRow,
  signAttestation,
  signOrder,
  verifyAttestation,
  verifyReceipt,
  type Attestation,
} from '../src/index.js';

const P: MarketParams = { b: 10n * WAD, payoutUnit: 100_000n, unit: WAD };
const MARKET = 1;
const TRADER_PRIV = PrivateKey.fromRandom();
const TRADER = TRADER_PRIV.toPublicKey().toDER('hex') as string;
let nonceSeq = 0;
function order(o: { side: 'yes' | 'no'; action: 'buy' | 'sell'; units: bigint; ts?: number }) {
  const nonce = ++nonceSeq;
  const f = { marketId: MARKET, trader: TRADER, side: o.side, action: o.action, units: o.units, nonce };
  return { ...f, sig: signOrder(TRADER_PRIV.toWif(), f), ...(o.ts !== undefined ? { ts: o.ts } : {}) };
}

function fresh(): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  const eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()));
  eng.openMarket(MARKET, P);
  return { db, eng };
}

async function seedFills(db: Db, eng: ExecutionEngine, n: number): Promise<ExecOrderRow[]> {
  for (let i = 0; i < n; i++) {
    await eng.submit(order({ side: 'yes', action: 'buy', units: 1n, ts: i + 1 }));
  }
  return db.prepare('SELECT * FROM exec_orders WHERE market_id=? ORDER BY seq').all(MARKET) as ExecOrderRow[];
}

describe('CONC-003a — receipts, batch digest, attestations', () => {
  it('persists ts so a stored receipt reconstructs and re-verifies from the DB (and tampering fails)', async () => {
    const { db, eng } = fresh();
    const sr = await eng.submit(order({ side: 'yes', action: 'buy', units: 1n, ts: 42 }));
    const row = db.prepare('SELECT * FROM exec_orders WHERE seq=1').get() as ExecOrderRow;

    const rebuilt = receiptFromRow(row);
    expect(rebuilt.ts).toBe(42);
    expect(verifyReceipt(rebuilt, row.sig, row.signer_pubkey)).toBe(true);
    expect(verifyReceipt(rebuilt, sr.sig, row.signer_pubkey)).toBe(true); // same sig the caller got
    expect(verifyReceipt({ ...rebuilt, costSats: rebuilt.costSats + 1 }, row.sig, row.signer_pubkey)).toBe(false);
  });

  it('computeBatchDigest is deterministic and order-sensitive and tamper-sensitive', async () => {
    const { db, eng } = fresh();
    const rows = await seedFills(db, eng, 3);
    const receipts = rows.map(receiptFromRow);

    expect(computeBatchDigest(receipts)).toBe(computeBatchDigest(receipts)); // deterministic
    expect(computeBatchDigest([receipts[0]!, receipts[1]!])).not.toBe(
      computeBatchDigest([receipts[1]!, receipts[0]!])
    ); // order matters
    const tampered = [...receipts];
    tampered[1] = { ...tampered[1]!, costSats: tampered[1]!.costSats + 1 };
    expect(computeBatchDigest(tampered)).not.toBe(computeBatchDigest(receipts)); // any change moves the digest
  });

  it('attestation signs + verifies over the settlement claim, and any change fails', () => {
    const signer = new WifReceiptSigner(PrivateKey.fromRandom().toWif());
    const att: Attestation = {
      marketId: MARKET, fromVersion: 0, toVersion: 1, batchDigest: 'de'.repeat(32),
      netYesUnits: '3', netNoUnits: '2', netCollateralSats: 250, newStateHash: 'ab'.repeat(32),
    };
    const { sig, pubkey } = signAttestation(signer, att);
    expect(verifyAttestation(att, sig, pubkey)).toBe(true);
    expect(verifyAttestation({ ...att, netCollateralSats: 251 }, sig, pubkey)).toBe(false);
    expect(verifyAttestation({ ...att, batchDigest: 'ff'.repeat(32) }, sig, pubkey)).toBe(false);
  });
});
