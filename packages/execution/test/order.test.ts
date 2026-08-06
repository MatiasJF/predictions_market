import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD, type MarketParams } from '@pm/lmsr';
import { ExecutionEngine, WifReceiptSigner, signOrder, verifyOrder, type SignedOrderFields } from '../src/index.js';

// LIVE-001a — orders must be authenticated by the trader. Before this the engine accepted any trader pubkey as
// a plain string, so the OPERATOR could fabricate fills in a user's name. These tests are the security
// properties, not happy-path coverage.
const P: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const MARKET = 1;

const alice = PrivateKey.fromRandom();
const bob = PrivateKey.fromRandom();
const alicePub = alice.toPublicKey().toDER('hex') as string;
const bobPub = bob.toPublicKey().toDER('hex') as string;

function fresh(): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  const eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()));
  eng.openMarket(MARKET, P);
  return { db, eng };
}
const fields = (trader: string, nonce: number): SignedOrderFields => ({
  marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce,
});

describe('trader-authenticated orders (LIVE-001a)', () => {
  it('fills an order the trader actually signed', async () => {
    const { db, eng } = fresh();
    const f = fields(alicePub, 1);
    const sr = await eng.submit({ ...f, sig: signOrder(alice.toWif(), f), ts: 1 });
    expect(sr.receipt.trader).toBe(alicePub);

    const row = db.prepare('SELECT order_sig, nonce FROM exec_orders WHERE seq=1').get() as
      { order_sig: string | null; nonce: number | null };
    expect(row.order_sig, "the trader's authorization is persisted").toBeTruthy();
    expect(row.nonce).toBe(1);
  });

  it('REJECTS an unsigned order (the operator cannot fabricate a fill)', async () => {
    const { db, eng } = fresh();
    await expect(
      eng.submit({ ...fields(alicePub, 1), ts: 1 })
    ).rejects.toThrow(/signature and nonce/);
    expect((db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(0);
  });

  it('REJECTS a forged signature', async () => {
    const { eng } = fresh();
    const f = fields(alicePub, 1);
    const forged = signOrder(bob.toWif(), f); // bob signs alice's order
    await expect(eng.submit({ ...f, sig: forged, ts: 1 })).rejects.toThrow(/bad trader signature/);
  });

  it('REJECTS impersonation: a valid signature from A submitted under B', async () => {
    const { eng } = fresh();
    const aliceOrder = fields(alicePub, 1);
    const aliceSig = signOrder(alice.toWif(), aliceOrder);
    // same signature, but the order now claims to be bob's
    await expect(
      eng.submit({ ...fields(bobPub, 1), sig: aliceSig, ts: 1 })
    ).rejects.toThrow(/bad trader signature/);
  });

  it('REJECTS a replayed order (same nonce twice)', async () => {
    const { db, eng } = fresh();
    const f = fields(alicePub, 7);
    const sig = signOrder(alice.toWif(), f);
    await eng.submit({ ...f, sig, ts: 1 });
    await expect(eng.submit({ ...f, sig, ts: 2 })).rejects.toThrow(); // UNIQUE(market,trader,nonce)
    expect((db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(1);
  });

  it('detects any tampering with the signed order fields', () => {
    const f = fields(alicePub, 3);
    const sig = signOrder(alice.toWif(), f);
    expect(verifyOrder(f, sig)).toBe(true);
    expect(verifyOrder({ ...f, units: 100n }, sig), 'size tampered').toBe(false);
    expect(verifyOrder({ ...f, side: 'no' }, sig), 'side tampered').toBe(false);
    expect(verifyOrder({ ...f, action: 'sell' }, sig), 'action tampered').toBe(false);
    expect(verifyOrder({ ...f, nonce: 4 }, sig), 'nonce tampered').toBe(false);
  });
});
