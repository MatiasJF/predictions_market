// FUND-001 — the daemon's payment gate, exercised through the real path.
//
// `packages/execution/test/funding.test.ts` proves the engine refuses an unfunded buy. This file proves the
// DAEMON never lets one get that far: it issues a priced intent, verifies a real payment transaction against
// it, and only then fills. Every check here is a door the free option could come back through, so each is
// tested by attacking it, not by confirming the happy path twice.
import { describe, it, expect, beforeEach } from 'vitest';
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, signOrder } from '@pm/execution';
import { OfflineChainCheck } from '@pm/wallet';
import { MarketService } from '../src/service.js';

const PAYOUT_UNIT = 1000;

let db: Db;
let svc: MarketService;
let marketId: number;
const operatorPayKey = PrivateKey.fromRandom();
const trader = PrivateKey.fromRandom();
const traderPub = trader.toPublicKey().toString();

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  const exec = new ExecutionEngine(db, makeReceiptSigner());
  svc = new MarketService(db, new MockEngine(), exec, operatorPayKey, new OfflineChainCheck());
  const m = await svc.createMarket({ question: 'Will X happen?', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
  marketId = m.id;
  await svc.enqueueDeploy(marketId);
  const dep = db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='deploy'").get(marketId) as { id: number };
  await svc.authorize(dep.id);
});

const orderFields = (units: number, nonce: number) => ({
  marketId, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: BigInt(units), nonce,
});
const signed = (units: number, nonce: number) => signOrder(trader.toWif(), orderFields(units, nonce));
const fillCount = () => (db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c;

/**
 * A transaction paying `sats` to a hex locking script — the shape a real BRC-100 wallet's `createAction`
 * produces. A decoy output goes first on purpose, so output-index discovery is genuinely exercised rather than
 * accidentally passing because the payment is always at index 0.
 */
function buildPayment(scriptHex: string, sats: number): string {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 1 });
  tx.addOutput({ lockingScript: LockingScript.fromHex(scriptHex), satoshis: sats });
  return tx.toHex();
}

describe('FUND-001 — the daemon collects the money before it fills', () => {
  it('issues a priced intent with a one-time destination', () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    expect(intent.satoshis, 'the intent must be priced').toBeGreaterThan(0);
    expect(intent.locking_script).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(Date.parse(intent.expires_at)).toBeGreaterThan(Date.now());

    const second = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    expect(second.locking_script, 'each intent gets its OWN destination').not.toBe(intent.locking_script);
  });

  it('ACCEPTS a real payment and fills — the whole point of the ticket', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const res = await svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: buildPayment(intent.locking_script, intent.satoshis),
    }) as any;

    expect(res.receipt.seq).toBe(1);
    expect(fillCount()).toBe(1);

    const paid = db.prepare('SELECT status, paid_sats, txid, output_index FROM payment_intents WHERE id=?')
      .get(intent.intent_id) as { status: string; paid_sats: number; txid: string; output_index: number };
    expect(paid.status).toBe('paid');
    expect(paid.paid_sats).toBe(intent.satoshis);
    expect(paid.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(paid.output_index, 'the decoy output is index 0, so the payment must be found at 1').toBe(1);

    const fill = db.prepare('SELECT payment_intent_id, paid_sats, cost_sats FROM exec_orders').get() as
      { payment_intent_id: number; paid_sats: number; cost_sats: number };
    expect(fill.payment_intent_id, 'the fill points at the payment that bought it').toBe(intent.intent_id);
    expect(fill.paid_sats).toBeGreaterThanOrEqual(fill.cost_sats);
  });

  it('REFUSES underpayment, and does not keep the intent open for a retry', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: buildPayment(intent.locking_script, intent.satoshis - 1),
    })).rejects.toThrow(/underpaid/);
    expect(fillCount()).toBe(0);
    const row = db.prepare('SELECT status, error FROM payment_intents WHERE id=?').get(intent.intent_id) as
      { status: string; error: string };
    expect(row.status).toBe('rejected');
    expect(row.error).toMatch(/underpaid/);
  });

  it('REFUSES a payment that was never broadcast — the side door back to a free option', async () => {
    // Same as the happy path, but the chain says the transaction does not exist.
    const db2 = openDb(':memory:');
    migrate(db2);
    const svc2 = new MarketService(
      db2, new MockEngine(), new ExecutionEngine(db2, makeReceiptSigner()),
      operatorPayKey, { exists: async () => false },
    );
    const m2 = await svc2.createMarket({ question: 'q', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
    await svc2.enqueueDeploy(m2.id);
    const dep = db2.prepare("SELECT id FROM broadcasts WHERE kind='deploy'").get() as { id: number };
    await svc2.authorize(dep.id);

    const intent = svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const fields = { marketId: m2.id, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: 3n, nonce: 1 };
    await expect(svc2.submitOrder(m2.id, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signOrder(trader.toWif(), fields), nonce: 1,
      intentId: intent.intent_id, paymentTx: buildPayment(intent.locking_script, intent.satoshis),
    })).rejects.toThrow(/is not on the network — was it broadcast/);
    expect((db2.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(0);
  });

  it('REFUSES a sell intent — a seller is owed money, not charged', () => {
    expect(() => svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'sell', units: 1 }))
      .toThrow(/only buys are paid for/);
  });

  it('REFUSES a buy with no payment at all, and records no fill', async () => {
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
    })).rejects.toThrow(/must reference a payment intent/);
    expect(fillCount(), 'no fill may exist without payment').toBe(0);
  });

  it('REFUSES a payment that pays someone else', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const elsewhere = new Transaction();
    elsewhere.addOutput({
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()),
      satoshis: intent.satoshis * 10,
    });
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: elsewhere.toHex(),
    })).rejects.toThrow(/no output pays the expected destination/);
    expect(fillCount()).toBe(0);
  });

  it('REFUSES an intent that belongs to a different trader', async () => {
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    const intent = svc.createPaymentIntent(marketId, { trader: other, side: 'yes', action: 'buy', units: 3 }) as any;
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/belongs to a different trader/);
    expect(fillCount()).toBe(0);
  });

  it('REFUSES an order that does not match what was quoted', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'no', action: 'buy', units: 3,
      sig: signOrder(trader.toWif(), { ...orderFields(3, 1), side: 'no' }), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/does not match the quoted intent/);
    expect(fillCount()).toBe(0);
  });

  it('REFUSES an expired quote — the price moves with every fill', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    db.prepare("UPDATE payment_intents SET expires_at=datetime('now','-1 minute') WHERE id=?").run(intent.intent_id);
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/quote expired/);
    const row = db.prepare('SELECT status FROM payment_intents WHERE id=?').get(intent.intent_id) as { status: string };
    expect(row.status).toBe('expired');
    expect(fillCount()).toBe(0);
  });

  it('a payment intent is single-use — the same one cannot buy twice', async () => {
    const intent = svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    db.prepare("UPDATE payment_intents SET status='paid' WHERE id=?").run(intent.intent_id);
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/already 'paid'/);
    expect(fillCount()).toBe(0);
  });

  it('an unknown intent id is a 404, not a silent pass', async () => {
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: 99999, paymentTx: new Transaction().toHex(),
    })).rejects.toMatchObject({ status: 404 });
    expect(fillCount()).toBe(0);
  });

  it('a daemon with NO payment key refuses to quote rather than trading for free', async () => {
    const db2 = openDb(':memory:');
    migrate(db2);
    const svc2 = new MarketService(db2, new MockEngine(), new ExecutionEngine(db2, makeReceiptSigner()));
    const m2 = await svc2.createMarket({ question: 'q', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
    await svc2.enqueueDeploy(m2.id);
    const dep = db2.prepare("SELECT id FROM broadcasts WHERE kind='deploy'").get() as { id: number };
    await svc2.authorize(dep.id);
    expect(() => svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 1 }))
      .toThrow(/no payment key/);
  });
});
