// MAINNET-004 — winners must be payable exactly once.
//
// Found the hard way on mainnet (2026-08-06). `winningPayouts` derives from the receipt ledger, and paying does
// not change that ledger — so a second `payout` call recomputed the same winners and paid them again, chaining
// off the pool output the first payout had just produced. Two real transactions, 3,000 sat delivered twice
// (6dd31acc… then 9a1879b2…), plus ~37,650 sat of extra fee. The `payouts` table already recorded the first
// payment; nothing consulted it.
//
// These tests pin the guard at the service layer. See ADR-034 for the remaining ON-CHAIN gap: the contract
// itself still permits a replay, because `collateral` is spike state large enough to never bind.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, signOrder, makeTraderWallet } from '@pm/execution';
import { MarketService, ServiceError } from '../src/service.js';

const PAYOUT_UNIT = 1000;

async function marketWithAWinner() {
  const db: Db = openDb(':memory:');
  migrate(db);
  // FUND-001: funding is verified by the DAEMON (payment intent → chain check) before it reaches the
  // engine; these tests drive the engine directly, so the engine-level gate is opted out here and the
  // real path is covered by the daemon's own funding tests.
  const exec = new ExecutionEngine(db, makeReceiptSigner(), true, false);
  const svc = new MarketService(db, new MockEngine(), exec);

  const m = await svc.createMarket({ question: 'Will X happen?', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
  await svc.enqueueDeploy(m.id);
  const dep = (db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='deploy'").get(m.id)) as { id: number };
  await svc.authorize(dep.id);

  // one trader buys YES, and YES wins
  const w = makeTraderWallet();
  const fields = { marketId: m.id, trader: w.pubkey, side: 'yes' as const, action: 'buy' as const, units: 3n, nonce: 1 };
  await svc.submitOrder(m.id, { ...fields, units: 3, sig: signOrder(w.wif, fields) } as never);

  db.prepare("UPDATE markets SET resolution='yes', state='resolved' WHERE id=?").run(m.id);
  db.prepare('UPDATE pool_utxos SET resolved=1, winner=1 WHERE market_id=?').run(m.id);
  return { db, svc, marketId: m.id, trader: w.pubkey };
}

describe('MAINNET-004 — winners are paid exactly once', () => {
  let db: Db; let svc: MarketService; let marketId: number; let trader: string;
  beforeEach(async () => { ({ db, svc, marketId, trader } = await marketWithAWinner()); });

  /** Stand in for a completed on-chain payout (what applyEffects records after a real broadcast). */
  const recordPaid = (sats: number, txid: string) =>
    db.prepare(
      `INSERT INTO payouts(market_id, trader_pubkey, pkh, shares, sats, payout_digest, txid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(marketId, trader, 'ff'.repeat(20), (3n * 10n ** 18n).toString(), sats, 'de'.repeat(32), txid);

  it('previews a winner as owed before payment', () => {
    const p = svc.payoutPreview(marketId) as any;
    expect(p.resolved).toBe(true);
    expect(p.winners).toHaveLength(1);
    expect(p.winners[0].sats).toBe(3 * PAYOUT_UNIT);
    expect(p.paid).toHaveLength(0);
  });

  it('REFUSES a second payout once winners are recorded as paid', async () => {
    recordPaid(3000, 'a'.repeat(64));
    await expect(svc.enqueuePayout(marketId)).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.enqueuePayout(marketId)).rejects.toMatchObject({ status: 409 });
    // and it names the tx, so an operator can go look at what already happened
    await expect(svc.enqueuePayout(marketId)).rejects.toThrow(/already paid 3000 sat in tx a{64}/);
  });

  it('moves a paid winner out of `winners` so nothing shows as still owed', () => {
    recordPaid(3000, 'b'.repeat(64));
    const p = svc.payoutPreview(marketId) as any;
    expect(p.winners, 'a paid winner must not still read as owed').toHaveLength(0);
    expect(p.total_sats).toBe(0);
    expect(p.paid).toHaveLength(1);
    expect(p.paid[0]).toMatchObject({ trader, sats: 3000 });
    expect(p.paid_sats).toBe(3000);
  });

  it('queues no second broadcast when refused', async () => {
    recordPaid(3000, 'c'.repeat(64));
    await expect(svc.enqueuePayout(marketId)).rejects.toThrow();
    const pending = db.prepare("SELECT COUNT(*) c FROM broadcasts WHERE kind='payout'").get() as { c: number };
    expect(pending.c).toBe(0);
  });
});
