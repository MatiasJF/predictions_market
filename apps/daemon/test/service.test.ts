// API-005 — MarketService over a temp DB + MockEngine (no chain). Exercises the full autonomous loop:
// create → quote → deploy → buy → sell → resolve, the sign-off queue (enqueue/authorize/reject, one-pending
// invariant), pool_utxos lineage advance, and the engine-limitation (501) surface for redeem.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine, EngineLimitation } from '@pm/engine';
import { MarketService, ServiceError } from '../src/service.js';

function freshService() {
  const db: Db = openDb(':memory:');
  migrate(db);
  return { db, svc: new MarketService(db, new MockEngine()) };
}

describe('MarketService — market lifecycle + sign-off queue', () => {
  let svc: MarketService;
  beforeEach(() => { svc = freshService().svc; });

  it('creates a market with 50/50 opening prices and pure LMSR quotes', async () => {
    const m = await svc.createMarket({ question: 'Will X happen?', bUnits: 1000 });
    expect(m.id).toBe(1);
    expect(m.state).toBe('imported');
    expect(m.pool).toBeNull();
    expect(m.prices.yes_sats).toBe(50_000); // payoutUnit/2 at the initial symmetric state
    expect(m.prices.no_sats).toBe(50_000);

    const q = svc.quote(m.id, 'yes', 1);
    expect(q.est_buy_charge_sats).toBeGreaterThan(0);
    expect(q.est_sell_proceeds_sats).toBeNull(); // nothing outstanding to sell yet
  });

  it('validates inputs', async () => {
    await expect(svc.createMarket({ question: '', bUnits: 1000 })).rejects.toThrow(ServiceError);
    await expect(svc.createMarket({ question: 'ok', bUnits: 0 })).rejects.toThrow(/positive/);
    const m = await svc.createMarket({ question: 'ok', bUnits: 1000 });
    expect(() => svc.quote(m.id, 'maybe', 1)).toThrow(/side/);
    expect(() => svc.getMarket(999)).toThrow(/not found/);
  });

  it('runs deploy → buy → sell → resolve through the queue, advancing pool lineage', async () => {
    const m = await svc.createMarket({ question: 'lifecycle', bUnits: 1000 });

    // DEPLOY: enqueue parks pending; authorize advances to pool v0 + state 'deployed'.
    const dep = await svc.enqueueDeploy(m.id);
    expect(dep.status).toBe('pending');
    expect(svc.listBroadcasts('pending')).toHaveLength(1);
    // one-pending-per-market invariant
    await expect(svc.enqueueDeploy(m.id)).rejects.toThrow(/pending broadcast already exists/);

    const depOk = await svc.authorize(dep.broadcast_id);
    expect(depOk.status).toBe('broadcast');
    expect(depOk.pool_version).toBe(0);
    let mv = svc.getMarket(m.id);
    expect(mv.state).toBe('deployed');
    expect(mv.pool?.version).toBe(0);
    expect(mv.pool?.qYes).toBe('0');

    // BUY 1 YES: pool advances to v1, qYes = 1 share (WAD), a trade is recorded.
    const buy = await svc.enqueueBuy(m.id, 'yes', 1);
    const buyOk = await svc.authorize(buy.broadcast_id);
    expect(buyOk.pool_version).toBe(1);
    mv = svc.getMarket(m.id);
    expect(mv.pool?.version).toBe(1);
    expect(BigInt(mv.pool!.qYes)).toBe(1_000_000_000_000_000_000n); // WAD
    expect(mv.state).toBe('trading');
    // now a sell quote is available (position outstanding)
    expect(svc.quote(m.id, 'yes', 1).est_sell_proceeds_sats).toBeGreaterThan(0);

    // SELL 1 YES: pool advances to v2, qYes back to 0.
    const sell = await svc.enqueueSell(m.id, 'yes', 1);
    const sellOk = await svc.authorize(sell.broadcast_id);
    expect(sellOk.pool_version).toBe(2);
    expect(svc.getMarket(m.id).pool?.qYes).toBe('0');

    // RESOLVE YES: market resolved, pool.resolved = 1, trading closes.
    const res = await svc.enqueueResolve(m.id, 'yes');
    const resOk = await svc.authorize(res.broadcast_id);
    expect(resOk.pool_version).toBe(3);
    mv = svc.getMarket(m.id);
    expect(mv.state).toBe('resolved');
    expect(mv.resolution).toBe('yes');
    expect(mv.pool?.resolved).toBe(1);
    expect(mv.pool?.winner).toBe(1);

    // trading is closed after resolution
    await expect(svc.enqueueBuy(m.id, 'yes', 1)).rejects.toThrow(/resolved/);
  });

  it('reject drops a pending broadcast and frees the market to enqueue again', async () => {
    const m = await svc.createMarket({ question: 'reject-me', bUnits: 1000 });
    const dep = await svc.enqueueDeploy(m.id);
    const rej = svc.reject(dep.broadcast_id);
    expect(rej.status).toBe('rejected');
    expect(svc.listBroadcasts('pending')).toHaveLength(0);
    // authorizing a non-pending broadcast is a conflict
    await expect(svc.authorize(dep.broadcast_id)).rejects.toThrow(/not pending/);
    // free to enqueue a fresh deploy
    const dep2 = await svc.enqueueDeploy(m.id);
    expect(dep2.status).toBe('pending');
  });

  it('surfaces the engine limitation for redeem (BUG-005 → 501)', async () => {
    const m = await svc.createMarket({ question: 'redeem-blocked', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id);
    await expect(svc.enqueueRedeem(m.id, 'yes', 1)).rejects.toBeInstanceOf(EngineLimitation);
  });

  it('multi-share buy advances the pool by N in one authorized broadcast and books positions', async () => {
    const m = await svc.createMarket({ question: 'multi', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id);

    const buy = await svc.enqueueBuy(m.id, 'yes', 5);
    expect(buy.summary).toMatch(/buy 5 YES/);
    const ok = await svc.authorize(buy.broadcast_id);
    expect(ok.pool_version).toBe(1); // one aggregate version jump; intermediate UTXOs are transient

    const mv = svc.getMarket(m.id);
    expect(BigInt(mv.pool!.qYes)).toBe(5n * 1_000_000_000_000_000_000n); // 5 shares
    expect(mv.positions.yes_net_shares).toBe(5);
    const pos = svc.positions(m.id);
    expect(pos.yes.bought_shares).toBe(5);
    expect(pos.yes.net_cost_sats).toBeGreaterThan(0);

    // sell 2 back → net 3
    await svc.authorize((await svc.enqueueSell(m.id, 'yes', 2)).broadcast_id);
    expect(svc.positions(m.id).yes.net_shares).toBe(3);
    expect(svc.getMarket(m.id).pool?.version).toBe(2);
  });

  it('rejects out-of-range share counts and overselling', async () => {
    const m = await svc.createMarket({ question: 'guards', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id);
    await expect(svc.enqueueBuy(m.id, 'yes', 0)).rejects.toThrow(/1\.\./);
    await expect(svc.enqueueBuy(m.id, 'yes', 101)).rejects.toThrow(/1\.\./);
    await svc.authorize((await svc.enqueueBuy(m.id, 'yes', 1)).broadcast_id);
    await expect(svc.enqueueSell(m.id, 'yes', 5)).rejects.toThrow(/outstanding/);
  });

  it('reports wallet balance from the engine (read-only)', async () => {
    const bal = await svc.walletBalance();
    expect(bal.balance_sats).toBe(2_000_000); // MockEngine default fixture
    expect(bal.address).toMatch(/^1/);
  });
});
