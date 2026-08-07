// FUND-001 — the payment gate. The most important test file in the execution package.
//
// Before this, a trader signed a message and got a fill; `cost_sats` was recorded and nothing collected it.
// Every trader held a free option: unlimited upside, no stake, with the operator carrying the whole downside.
// These tests assert that is now structurally impossible, not merely discouraged.
//
// The subtle one is "a refused buy does not move the price". The funding check sits between computing the cost
// and mutating market state precisely so that a rejected order leaves the market untouched — otherwise anyone
// could shift the price for everyone else, repeatedly, for free, without ever paying.
import { describe, it, expect, beforeEach } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD, type MarketParams } from '@pm/lmsr';
import { ExecutionEngine } from '../src/engine.js';
import { WifReceiptSigner } from '../src/receipt.js';
import { signOrder } from '../src/order.js';

const MARKET = 1;
const params: MarketParams = { b: 1000n * WAD, payoutUnit: 1000n, unit: WAD };

let db: Db;
let eng: ExecutionEngine;
const trader = PrivateKey.fromRandom();
const traderPub = trader.toPublicKey().toString();

/** A signed order; `funding` is supplied per-test so each case controls exactly one variable. */
function order(units: bigint, nonce: number, funding?: { intentId: number; paidSats: number }, action: 'buy' | 'sell' = 'buy') {
  const fields = { marketId: MARKET, trader: traderPub, side: 'yes' as const, action, units, nonce };
  // spread conditionally: `exactOptionalPropertyTypes` forbids passing `funding: undefined` explicitly
  return { ...fields, sig: signOrder(trader.toWif(), fields), sigScheme: 'ecdsa' as const, ...(funding ? { funding } : {}) };
}

const rowCount = () => (db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()));
  eng.openMarket(MARKET, params);
});

describe('the payment gate — a buy is only a fill if it was paid for', () => {
  it('REFUSES a buy with no payment at all, and records nothing', async () => {
    await expect(eng.submit(order(1n, 1))).rejects.toThrow(/must carry proof of payment/);
    expect(rowCount(), 'a refused buy must leave no fill behind').toBe(0);
  });

  it('REFUSES an underfunded buy, naming both numbers', async () => {
    await expect(eng.submit(order(5n, 1, { intentId: 1, paidSats: 1 })))
      .rejects.toThrow(/underfunded buy — paid 1 sat, costs \d+ sat/);
    expect(rowCount()).toBe(0);
  });

  it('ACCEPTS a funded buy and records what was paid alongside the fill', async () => {
    const { receipt } = await eng.submit(order(1n, 1, { intentId: 42, paidSats: 10_000 }));
    expect(receipt.seq).toBe(1);
    const row = db.prepare('SELECT payment_intent_id, paid_sats, cost_sats FROM exec_orders').get() as
      { payment_intent_id: number; paid_sats: number; cost_sats: number };
    expect(row.payment_intent_id, 'the fill must point at the payment that bought it').toBe(42);
    expect(row.paid_sats).toBe(10_000);
    expect(row.paid_sats).toBeGreaterThanOrEqual(row.cost_sats);
  });

  it('accepts payment exactly equal to the cost (the boundary, not just the happy case)', async () => {
    // discover the true cost by letting a generously funded order through on a throwaway engine
    const probe = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()));
    probe.openMarket(2, params);
    const { receipt } = await probe.submit({
      ...order(3n, 1), marketId: 2,
      sig: signOrder(trader.toWif(), { marketId: 2, trader: traderPub, side: 'yes', action: 'buy', units: 3n, nonce: 1 }),
      funding: { intentId: 1, paidSats: 10_000_000 },
    });
    const exact = receipt.costSats;

    await expect(eng.submit(order(3n, 1, { intentId: 2, paidSats: exact - 1 })))
      .rejects.toThrow(/underfunded/);
    const ok = await eng.submit(order(3n, 2, { intentId: 3, paidSats: exact }));
    expect(ok.receipt.costSats).toBe(exact);
  });

  it('a REFUSED buy does not move the market — no free price manipulation', async () => {
    const before = eng.stateOf(MARKET);
    for (let i = 1; i <= 5; i++) {
      await expect(eng.submit(order(10n, i, { intentId: i, paidSats: 1 }))).rejects.toThrow(/underfunded/);
    }
    const after = eng.stateOf(MARKET);
    expect(after.qYes, 'q must be untouched').toBe(before.qYes);
    expect(after.eYes, 'the stored exponential must be untouched').toBe(before.eYes);
    expect(eng.seqOf(MARKET), 'the sequence must not advance').toBe(0);
    expect(rowCount()).toBe(0);
  });

  it('SELLS need no funding — a seller is owed money, not charged', async () => {
    await eng.submit(order(5n, 1, { intentId: 1, paidSats: 10_000 }));       // build a position first
    const sold = await eng.submit(order(2n, 2, undefined, 'sell'));           // no funding supplied
    expect(sold.receipt.action).toBe('sell');
    expect(sold.receipt.costSats, 'sell records proceeds owed').toBeGreaterThan(0);
  });

  it('the gate survives concurrency: only funded buys land, in order', async () => {
    const results = await Promise.allSettled([
      eng.submit(order(1n, 1, { intentId: 1, paidSats: 10_000 })),
      eng.submit(order(1n, 2, { intentId: 2, paidSats: 1 })),          // underfunded
      eng.submit(order(1n, 3, { intentId: 3, paidSats: 10_000 })),
      eng.submit(order(1n, 4)),                                        // unfunded
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect(rowCount(), 'exactly the two funded buys').toBe(2);
    const seqs = (db.prepare('SELECT seq FROM exec_orders ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs, 'seq has no gaps — refusals never consumed one').toEqual([1, 2]);
  });

  it('can be disabled explicitly, and ONLY explicitly (the default is on)', async () => {
    const lax = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()), true, false);
    lax.openMarket(3, params);
    const fields = { marketId: 3, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: 1n, nonce: 1 };
    const r = await lax.submit({ ...fields, sig: signOrder(trader.toWif(), fields), sigScheme: 'ecdsa' });
    expect(r.receipt.seq).toBe(1);
  });
});
