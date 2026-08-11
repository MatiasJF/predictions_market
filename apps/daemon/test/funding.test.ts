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
  it('issues a priced intent with a one-time destination', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    expect(intent.satoshis, 'the intent must be priced').toBeGreaterThan(0);
    expect(intent.locking_script).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(Date.parse(intent.expires_at)).toBeGreaterThan(Date.now());

    // MAINNET-012 changed this deliberately. An IDENTICAL request reuses the destination already
    // issued, because minting a fresh one is what asks a trader to pay twice for one order.
    const same = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    expect(same.intent_id, 'an identical request must reuse its quote').toBe(intent.intent_id);
    expect(same.reused).toBe(true);

    // A DIFFERENT order is a different quote and gets its own one-time destination.
    const other = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'no', action: 'buy', units: 3 }) as any;
    expect(other.locking_script, 'a different order gets its own destination').not.toBe(intent.locking_script);
  });

  it('ACCEPTS a real payment and fills — the whole point of the ticket', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
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
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
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

    const intent = await svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const fields = { marketId: m2.id, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: 3n, nonce: 1 };
    await expect(svc2.submitOrder(m2.id, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signOrder(trader.toWif(), fields), nonce: 1,
      intentId: intent.intent_id, paymentTx: buildPayment(intent.locking_script, intent.satoshis),
    })).rejects.toThrow(/has not reached the network yet/);
    expect((db2.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(0);

    // MAINNET-008: "not visible yet" is NOT "invalid". The intent must survive, because the trader may have
    // already paid it — burning it here strands their money, which is exactly what happened on mainnet with
    // `16bbde85…` (1,002 sat). Retryable failures leave the quote alive; only permanent ones kill it.
    const after = db2.prepare('SELECT status FROM payment_intents WHERE id=?').get(intent.intent_id) as { status: string };
    expect(after.status, 'a propagation race must not consume a paid quote').toBe('pending');
  });

  /**
   * MAINNET-012 — a retry must never be a second payment.
   *
   * The sequence that cost 1,002 sat on mainnet: a trader pays, something fails between paying and
   * filling, they are told to press again — and pressing again minted a NEW intent with a NEW
   * destination, so the wallet paid a second time while the first payment sat at an address that
   * bought nothing. These pin the two halves of the fix: reuse the quote, and when the quote is
   * already funded, say so and hand back the funding transaction instead of asking for money.
   */
  it('does NOT ask for a second payment when the quote is already funded', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const paymentTx = buildPayment(intent.locking_script, intent.satoshis);

    // The chain now reports that destination as funded — which is what it would say after the
    // trader's wallet broadcast and the fill failed for any other reason.
    const funded = new MarketService(
      db, new MockEngine(), new ExecutionEngine(db, makeReceiptSigner()), operatorPayKey,
      { exists: async () => true, fundedAt: async () => ({ txid: 'a'.repeat(64), rawTx: paymentTx }) },
    );

    const retry = await funded.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    expect(retry.intent_id, 'the retry must be the same quote').toBe(intent.intent_id);
    expect(retry.already_paid, 'the client must be told not to pay again').toBe(true);
    expect(retry.payment_tx, 'and handed the payment that already exists').toBe(paymentTx);
  });

  it('reuses an EXPIRED quote that has been paid, rather than stranding the money', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const paymentTx = buildPayment(intent.locking_script, intent.satoshis);
    db.prepare("UPDATE payment_intents SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), intent.intent_id);

    const funded = new MarketService(
      db, new MockEngine(), new ExecutionEngine(db, makeReceiptSigner()), operatorPayKey,
      { exists: async () => true, fundedAt: async () => ({ txid: 'b'.repeat(64), rawTx: paymentTx }) },
    );
    const retry = await funded.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;

    expect(retry.intent_id).toBe(intent.intent_id);
    expect(retry.already_paid).toBe(true);
    // The clock restarts, or `acceptPayment` would reject a quote the trader has already paid — and
    // the ANSWER has to carry the new deadline, not the stale one it was read with.
    expect(Date.parse(retry.expires_at), 'the response must not hand back an expired quote')
      .toBeGreaterThan(Date.now());
    const row = db.prepare('SELECT expires_at e FROM payment_intents WHERE id=?').get(intent.intent_id) as any;
    expect(Date.parse(row.e), 'and the row must agree with it').toBeGreaterThan(Date.now());
  });

  it('does NOT reuse a quote that has already bought something', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    await svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: buildPayment(intent.locking_script, intent.satoshis),
    });
    const next = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    // A settled quote is spent. Reusing it would hand a second order the first order's payment.
    expect(next.intent_id, 'a paid quote must not be reused for a new order').not.toBe(intent.intent_id);
    expect(next.already_paid).toBe(false);
  });

  /**
   * MAINNET-011 — the stake must land somewhere the OPERATOR can spend.
   *
   * This is the test that was missing, and its absence cost 16,440 sat of unusable stakes on
   * mainnet. `@pm/wallet` had thorough tests for both derivations; nothing asserted which one
   * `createPaymentIntent` actually called. `payer.test.ts` even built its fixture stakes the correct
   * way round, so the suite was testing the code I meant to write rather than the code that runs.
   *
   * It asserts against the LOCKING SCRIPT the daemon really hands a trader — the only artefact that
   * matters, since that is what the money is paid into.
   */
  it('derives a stake destination the OPERATOR can spend — not the trader who pays it', async () => {
    const { P2PKH } = await import('@bsv/sdk');
    const { derivePaymentKey } = await import('@pm/wallet');

    const intent = await svc.createPaymentIntent(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 2,
    }) as any;

    const row = db.prepare('SELECT derivation_prefix, derivation_suffix FROM payment_intents WHERE id=?')
      .get(intent.intent_id) as { derivation_prefix: string; derivation_suffix: string };
    const remittance = {
      derivationPrefix: row.derivation_prefix,
      derivationSuffix: row.derivation_suffix,
      senderIdentityKey: traderPub,
    };

    // The operator's own key, derived against the paying trader, must unlock the quoted script.
    const ours = derivePaymentKey(operatorPayKey, remittance);
    expect(
      new P2PKH().lock(ours.toPublicKey().toAddress()).toHex(),
      'the daemon quoted an address the operator cannot spend — the stake would be unrecoverable',
    ).toBe(intent.locking_script);

    // And the trader who pays must NOT hold the key, or they have simply paid themselves.
    const theirs = derivePaymentKey(trader, remittance);
    expect(new P2PKH().lock(theirs.toPublicKey().toAddress()).toHex()).not.toBe(intent.locking_script);
  });

  /**
   * MAINNET-010 — a wallet that signs but does not broadcast.
   *
   * Observed live: a trader's wallet produced three signed payments and put exactly one on the network. The
   * other two existed nowhere, which from here is indistinguishable from trying to get a fill for free. Since
   * we are holding the signed transaction, we send it ourselves rather than refuse.
   */
  it('BROADCASTS the payment itself when the trader\'s wallet did not', async () => {
    const db2 = openDb(':memory:');
    migrate(db2);
    let published: string | undefined;
    const chain = {
      // Nowhere to be seen — until someone puts it there.
      exists: async () => published !== undefined,
      publish: async (raw: string) => { published = raw; return true; },
    };
    const svc2 = new MarketService(
      db2, new MockEngine(), new ExecutionEngine(db2, makeReceiptSigner()), operatorPayKey, chain,
    );
    const m2 = await svc2.createMarket({ question: 'q', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
    await svc2.enqueueDeploy(m2.id);
    const dep = db2.prepare("SELECT id FROM broadcasts WHERE kind='deploy'").get() as { id: number };
    await svc2.authorize(dep.id);

    const intent = await svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const fields = { marketId: m2.id, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: 3n, nonce: 7 };
    const paymentTx = buildPayment(intent.locking_script, intent.satoshis);
    const res = await svc2.submitOrder(m2.id, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signOrder(trader.toWif(), fields), nonce: 7,
      intentId: intent.intent_id, paymentTx,
    });
    expect(res.receipt, 'the fill should go through once we broadcast it ourselves').toBeTruthy();
    expect(published, 'the daemon must have pushed the exact transaction it was given').toBe(paymentTx);
  });

  it('does NOT relay a payment that fails validation — we are not an open broadcast service', async () => {
    const db2 = openDb(':memory:');
    migrate(db2);
    let published = false;
    const svc2 = new MarketService(
      db2, new MockEngine(), new ExecutionEngine(db2, makeReceiptSigner()), operatorPayKey,
      { exists: async () => false, publish: async () => { published = true; return true; } },
    );
    const m2 = await svc2.createMarket({ question: 'q', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
    await svc2.enqueueDeploy(m2.id);
    const dep = db2.prepare("SELECT id FROM broadcasts WHERE kind='deploy'").get() as { id: number };
    await svc2.authorize(dep.id);

    const intent = await svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    const fields = { marketId: m2.id, trader: traderPub, side: 'yes' as const, action: 'buy' as const, units: 3n, nonce: 8 };
    await expect(svc2.submitOrder(m2.id, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signOrder(trader.toWif(), fields), nonce: 8,
      // Pays someone else entirely.
      intentId: intent.intent_id, paymentTx: buildPayment('76a914' + 'cd'.repeat(20) + '88ac', intent.satoshis),
    })).rejects.toThrow(/no output pays the expected destination/);
    expect(published, 'a transaction that does not pay us must never be relayed').toBe(false);
  });

  it('REFUSES a sell intent — a seller is owed money, not charged', async () => {
    await expect(svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'sell', units: 1 }))
      .rejects.toThrow(/only buys are paid for/);
  });

  it('REFUSES a buy with no payment at all, and records no fill', async () => {
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
    })).rejects.toThrow(/must reference a payment intent/);
    expect(fillCount(), 'no fill may exist without payment').toBe(0);
  });

  it('REFUSES a payment that pays someone else', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
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
    const intent = await svc.createPaymentIntent(marketId, { trader: other, side: 'yes', action: 'buy', units: 3 }) as any;
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'yes', action: 'buy', units: 3, sig: signed(3, 1), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/belongs to a different trader/);
    expect(fillCount()).toBe(0);
  });

  it('REFUSES an order that does not match what was quoted', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
    await expect(svc.submitOrder(marketId, {
      trader: traderPub, side: 'no', action: 'buy', units: 3,
      sig: signOrder(trader.toWif(), { ...orderFields(3, 1), side: 'no' }), nonce: 1,
      intentId: intent.intent_id, paymentTx: new Transaction().toHex(),
    })).rejects.toThrow(/does not match the quoted intent/);
    expect(fillCount()).toBe(0);
  });

  it('REFUSES an expired quote — the price moves with every fill', async () => {
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
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
    const intent = await svc.createPaymentIntent(marketId, { trader: traderPub, side: 'yes', action: 'buy', units: 3 }) as any;
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
    await expect(svc2.createPaymentIntent(m2.id, { trader: traderPub, side: 'yes', action: 'buy', units: 1 }))
      .rejects.toThrow(/no payment key/);
  });
});
