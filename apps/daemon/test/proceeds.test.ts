// FUND-001 step 7b — the market pays what it owes.
//
// A sell has always been the market owing a trader money: the fill was recorded, the proceeds were computed and
// shown, and nothing ever sent them. Mainnet market #7 (2026-08-10) closed with **998 sat owed to a real trader
// and no code path able to pay it**. It only looked harmless because the same person held both keys.
//
// These tests cover the whole obligation: the debt appears when the sell fills, it is paid out of actual staked
// satoshis, the seller can spend what arrives, and it cannot be paid twice.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, signOrder } from '@pm/execution';
import { MarketService, ServiceError } from '../src/service.js';
import { paidBuy } from './helpers/pay.js';
import { derivePaymentKey, type ChainCheck } from '@pm/wallet';
import { PrivateKey, Transaction } from '@bsv/sdk';

const PAYOUT_UNIT = 1000;

/**
 * A chain that remembers what it is given. The stake pot spends real UTXOs, so the daemon must be able to fetch
 * the funding transaction of every stake — `rawTx` is what makes that possible, and here it just replays the
 * payment transactions the tests themselves submitted.
 */
class FakeChain implements ChainCheck {
  readonly txs = new Map<string, string>();
  readonly published: string[] = [];
  /** Only what has been sent exists — the same rule the real network follows. */
  async exists(txid: string): Promise<boolean> { return this.txs.has(txid); }
  async publish(raw: string): Promise<boolean> {
    this.published.push(raw);
    this.txs.set(Transaction.fromHex(raw).id('hex'), raw);
    return true;
  }
  async rawTx(txid: string): Promise<string | undefined> { return this.txs.get(txid); }
}

let chain: FakeChain;
let potKey: PrivateKey;
let traderKey: PrivateKey;

async function marketWithASell(sellUnits = 2) {
  chain = new FakeChain();
  potKey = PrivateKey.fromRandom();
  traderKey = PrivateKey.fromRandom();
  const trader = traderKey.toPublicKey().toString();

  const db: Db = openDb(':memory:');
  migrate(db);
  const exec = new ExecutionEngine(db, makeReceiptSigner());
  const svc = new MarketService(db, new MockEngine(), exec, potKey, chain);

  const m = await svc.createMarket({ question: 'Will X happen?', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
  await svc.enqueueDeploy(m.id);
  const dep = db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='deploy'").get(m.id) as { id: number };
  await svc.authorize(dep.id);

  // Buy enough to sell back. The payment transaction has to be visible to the chain afterwards, because the
  // proceeds payment will spend the very output it created — that is the whole design.
  const buy = { marketId: m.id, trader, side: 'yes' as const, action: 'buy' as const, units: 6n, nonce: 1 };
  await paidBuy(svc, m.id, { trader, side: 'yes', units: 6, sig: signOrder(traderKey.toWif(), buy), nonce: 1 });
  const stakeTx = db.prepare("SELECT txid FROM payment_intents WHERE status='paid'").get() as { txid: string };
  return { db, svc, marketId: m.id, trader, stakeTxid: stakeTx.txid, sellUnits };
}

async function sell(db: Db, svc: MarketService, marketId: number, trader: string, units: number, nonce: number) {
  const fields = { marketId, trader, side: 'yes' as const, action: 'sell' as const, units: BigInt(units), nonce };
  return svc.submitOrder(marketId, {
    trader, side: 'yes', action: 'sell', units, nonce, sig: signOrder(traderKey.toWif(), fields),
  });
}

describe('FUND-001 step 7b — a seller actually gets paid', () => {
  let db: Db; let svc: MarketService; let marketId: number; let trader: string;
  beforeEach(async () => { ({ db, svc, marketId, trader } = await marketWithASell()); });

  it('books the debt the moment a sell fills — the obligation is created by the trade', async () => {
    const before = svc.sellDebts(marketId);
    expect(before.owed, 'nothing is owed before anyone sells').toHaveLength(0);

    const r = await sell(db, svc, marketId, trader, 2, 10);
    const after = svc.sellDebts(marketId);
    expect(after.owed).toHaveLength(1);
    expect(after.owed[0]).toMatchObject({ trader, order_seq: r.receipt.seq });
    expect(after.owed_sats).toBe(Number(r.receipt.costSats));
    expect(after.owed_sats, 'a sell of real shares must owe real satoshis').toBeGreaterThan(0);
  });

  it('REFUSES to build a payment when nothing is owed', async () => {
    await expect(svc.enqueueProceeds(marketId)).rejects.toThrow(/owes sellers nothing/);
  });

  it('pays the seller out of staked satoshis, and the seller can spend what arrives', async () => {
    await sell(db, svc, marketId, trader, 2, 10);
    // The stake is a real UTXO; the fake chain must be able to serve its funding transaction.
    const intent = db.prepare("SELECT txid FROM payment_intents WHERE status='paid'").get() as { txid: string };
    expect(chain.txs.has(intent.txid), 'the stake transaction must be fetchable to be spent').toBe(true);

    const owedSats = svc.sellDebts(marketId).owed_sats;
    const q = await svc.enqueueProceeds(marketId);
    expect(q.kind).toBe('proceeds');

    const res = await svc.authorize(q.broadcast_id) as any;
    expect(res.status).toBe('broadcast');
    // Two publishes by now: the trader's own stake payment (the daemon relays those since MAINNET-010), then
    // this one. The last is the payment that clears the debt.
    const sentRaw = chain.published.at(-1)!;
    expect(Transaction.fromHex(sentRaw).id('hex'), 'the payment must actually be sent').toBe(res.txid);

    const debts = svc.sellDebts(marketId);
    expect(debts.owed, 'the debt is settled').toHaveLength(0);
    expect(debts.paid[0]).toMatchObject({ trader, sats: owedSats, txid: res.txid });

    // THE POINT: the seller derives the key from what was recorded and it unlocks the output they were paid.
    const row = db.prepare('SELECT * FROM sell_proceeds WHERE market_id=?').get(marketId) as any;
    const key = derivePaymentKey(traderKey, {
      derivationPrefix: row.derivation_prefix,
      derivationSuffix: row.derivation_suffix,
      senderIdentityKey: row.sender_identity_key,
    });
    expect(key.toPublicKey().toHash('hex')).toBe(row.pkh);

    const tx = Transaction.fromHex(sentRaw);
    expect(tx.outputs[row.output_index]?.lockingScript.toHex()).toBe(`76a914${row.pkh}88ac`);
    expect(tx.outputs[row.output_index]?.satoshis).toBe(owedSats);
  });

  it('marks the stake spent, so the next payment cannot double-spend the same input', async () => {
    await sell(db, svc, marketId, trader, 2, 10);
    const q = await svc.enqueueProceeds(marketId);
    await svc.authorize(q.broadcast_id);
    const stake = db.prepare("SELECT spent FROM payment_intents WHERE status='paid'").get() as { spent: number };
    expect(stake.spent).toBe(1);
  });

  it('will not pay the same sell twice — real money twice is the defect that started all this', async () => {
    await sell(db, svc, marketId, trader, 2, 10);
    const q = await svc.enqueueProceeds(marketId);
    await svc.authorize(q.broadcast_id);
    await expect(svc.enqueueProceeds(marketId)).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.enqueueProceeds(marketId)).rejects.toThrow(/owes sellers nothing/);
  });

  it('pays several sells in one transaction, each to its own address', async () => {
    const a = await sell(db, svc, marketId, trader, 1, 10);
    const b = await sell(db, svc, marketId, trader, 1, 11);
    expect(svc.sellDebts(marketId).owed).toHaveLength(2);

    const q = await svc.enqueueProceeds(marketId);
    await svc.authorize(q.broadcast_id);

    const rows = db.prepare('SELECT * FROM sell_proceeds WHERE market_id=? ORDER BY order_seq').all(marketId) as any[];
    expect(rows.map((r) => r.status)).toEqual(['paid', 'paid']);
    expect(rows.map((r) => r.order_seq)).toEqual([a.receipt.seq, b.receipt.seq]);
    // Same trader, same transaction — but never the same address twice.
    expect(rows[0].pkh).not.toBe(rows[1].pkh);
    expect(new Set(rows.map((r) => r.txid)).size, 'one payment clears the whole book').toBe(1);
  });

  it('REFUSES when the pot cannot cover the debt, instead of paying some sellers and not others', async () => {
    await sell(db, svc, marketId, trader, 2, 10);
    // Take the stake away: solvent ledger, empty pot.
    db.prepare("UPDATE payment_intents SET spent=1 WHERE status='paid'").run();
    await expect(svc.enqueueProceeds(marketId)).rejects.toThrow(/cannot cover its own book|holds 0 sat/);
    expect(svc.sellDebts(marketId).owed, 'a refused payment must leave the debt standing').toHaveLength(1);
  });
  /**
   * MAINNET-015 — a seller must be able to COLLECT, not just be paid.
   *
   * Sale proceeds are sent to a one-time BRC-29 destination exactly like winnings, but the claim path
   * read only the `payouts` table — so a seller's money landed somewhere they could see and could not
   * collect. That is the defect ADR-041 fixed for winners and left standing for sellers, and it would
   * have been discovered live, on mainnet, in front of an audience.
   */
    it('lists sale proceeds alongside winnings, tagged by kind', async () => {
      await sell(db, svc, marketId, trader, 2, 10);
      const q = await svc.enqueueProceeds(marketId);
      await svc.authorize(q.broadcast_id);

      const { claims } = await svc.payoutClaims(marketId, trader) as any;
      const sale = claims.find((c: any) => c.kind === 'proceeds');
      expect(sale, 'a paid sale must appear as something claimable').toBeTruthy();
      expect(sale.sats).toBeGreaterThan(0);
      expect(sale.remittance, 'without this the money cannot be internalized').toBeTruthy();
    });

    it("THE POINT: the seller's own key unlocks the proceeds they were paid", async () => {
      await sell(db, svc, marketId, trader, 2, 10);
      const q = await svc.enqueueProceeds(marketId);
      await svc.authorize(q.broadcast_id);

      const { claims } = await svc.payoutClaims(marketId, trader) as any;
      const sale = claims.find((c: any) => c.kind === 'proceeds');
      const key = derivePaymentKey(traderKey, sale.remittance);
      expect(key.toPublicKey().toHash('hex'), 'the seller must hold the key to their own proceeds').toBe(sale.pkh);
    });

    it('does not offer an unpaid debt as a claim', async () => {
      await sell(db, svc, marketId, trader, 2, 10);
      const { claims } = await svc.payoutClaims(marketId, trader) as any;
      // Owed is not paid. Listing it would invite a claim against money that has not moved.
      expect(claims.filter((c: any) => c.kind === 'proceeds')).toHaveLength(0);
    });
});