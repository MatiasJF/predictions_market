// API-005 — MarketService over a temp DB + MockEngine (no chain). Exercises the full autonomous loop:
// create → quote → deploy → buy → sell → resolve, the sign-off queue (enqueue/authorize/reject, one-pending
// invariant), pool_utxos lineage advance, and the engine-limitation (501) surface for redeem.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine, EngineLimitation } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, verifyReceipt, signOrder, makeTraderWallet } from '@pm/execution';
import { WAD } from '@pm/lmsr';
import { MarketService, ServiceError } from '../src/service.js';

function freshService() {
  const db: Db = openDb(':memory:');
  migrate(db);
  return { db, svc: new MarketService(db, new MockEngine()) };
}

function freshExecService() {
  const db: Db = openDb(':memory:');
  migrate(db);
  // FUND-001: funding is verified by the DAEMON (payment intent → chain check) before it reaches the
  // engine; these tests drive the engine directly, so the engine-level gate is opted out here and the
  // real path is covered by the daemon's own funding tests.
  const exec = new ExecutionEngine(db, makeReceiptSigner(), true, false);
  return { db, svc: new MarketService(db, new MockEngine(), exec) };
}

describe('MarketService — market lifecycle + sign-off queue', () => {
  let svc: MarketService;
  let db: Db;
  beforeEach(() => { const f = freshService(); svc = f.svc; db = f.db; });

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

    // CONC-005: the minted position token is PERSISTED, so a restarted daemon can still redeem it.
    const tok = db.prepare('SELECT * FROM tokens WHERE market_id=? AND burned=0').get(m.id) as
      { side: string; script: string | null; holder_pkh: string | null; sats: number; txid: string } | undefined;
    expect(tok, 'token row written on buy').toBeTruthy();
    expect(tok!.side).toBe('yes');
    expect(tok!.script).toBeTruthy();
    expect(tok!.holder_pkh).toBeTruthy();
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

  it('surfaces 501 when no execution engine is configured', async () => {
    const m = await svc.createMarket({ question: 'no-exec', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id);
    await expect(
      svc.submitOrder(m.id, { trader: 'ab'.repeat(33), side: 'yes', action: 'buy' })
    ).rejects.toThrow(/execution engine not configured/);
  });
});

describe('MarketService — off-chain execution + batch settlement (CONC-001/002)', () => {
  // LIVE-001a: real trader wallet — the engine verifies the signature before filling.
  const TRADER_WALLET = makeTraderWallet();
  const TRADER = TRADER_WALLET.pubkey;
  let nonceSeq = 0;
  const order = (id: number, side: 'yes' | 'no', action: 'buy' | 'sell', units = 1) => {
    const nonce = ++nonceSeq;
    const f = { marketId: id, trader: TRADER, side, action, units: BigInt(units), nonce };
    return { trader: TRADER, side, action, units, nonce, sig: signOrder(TRADER_WALLET.wif, f) };
  };

  it('fills orders off-chain instantly, then settles the whole batch in ONE authorized pool-version advance', async () => {
    const { db, svc } = freshExecService();
    const m = await svc.createMarket({ question: 'concurrency', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id); // pool v0

    // Five INSTANT off-chain fills (3 YES buys, 2 NO buys) — no broadcasts, signed receipts returned.
    const r1 = await svc.submitOrder(m.id, order(m.id, 'yes', 'buy', 1));
    expect(r1.receipt.seq).toBe(1);
    expect(verifyReceipt(r1.receipt, r1.sig, r1.signer_pubkey)).toBe(true);
    await svc.submitOrder(m.id, order(m.id, 'yes', 'buy', 1));
    await svc.submitOrder(m.id, order(m.id, 'yes', 'buy', 1));
    await svc.submitOrder(m.id, order(m.id, 'no', 'buy', 1));
    await svc.submitOrder(m.id, order(m.id, 'no', 'buy', 1));

    // Fills are off-chain: the pool is still at v0 and no NEW broadcast was queued by the fills
    // (the only broadcast so far is the already-authorized deploy; nothing is pending).
    expect(svc.getMarket(m.id).pool?.version).toBe(0);
    expect(svc.listBroadcasts('pending')).toHaveLength(0);
    expect(svc.listReceipts(m.id).count).toBe(5);

    const pos = svc.execPositions(m.id, TRADER).positions;
    expect(pos).toHaveLength(1);
    expect(pos[0]!.netYesShares).toBe((3n * WAD).toString());
    expect(pos[0]!.netNoShares).toBe((2n * WAD).toString());

    // SETTLE: one broadcast collapses all five fills into a single pool-version advance.
    const settle = await svc.enqueueSettle(m.id);
    expect(settle.kind).toBe('settle');
    const ok = await svc.authorize(settle.broadcast_id);
    expect(ok.pool_version).toBe(1); // ONE version jump for the whole batch

    const mv = svc.getMarket(m.id);
    expect(BigInt(mv.pool!.qYes)).toBe(3n * WAD); // pool advanced by the NET: 3 YES, 2 NO
    expect(BigInt(mv.pool!.qNo)).toBe(2n * WAD);
    expect(mv.state).toBe('trading');

    // Ledger: 5 trade rows, one settlement row, every order stamped settled.
    const trades = db.prepare('SELECT COUNT(*) AS c FROM trades WHERE market_id=?').get(m.id) as { c: number };
    expect(trades.c).toBe(5);
    const batches = db.prepare('SELECT order_count FROM exec_batches WHERE market_id=?').all(m.id) as { order_count: number }[];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.order_count).toBe(5);
    const unsettled = db.prepare('SELECT COUNT(*) AS c FROM exec_orders WHERE market_id=? AND batch_id IS NULL').get(m.id) as { c: number };
    expect(unsettled.c).toBe(0);

    // Nothing left to settle → 400.
    await expect(svc.enqueueSettle(m.id)).rejects.toThrow(/no unsettled/);
  });

  it('audits a settlement against its receipts (ok), and CATCHES a tampered receipt (CONC-003a)', async () => {
    const { db, svc } = freshExecService();
    const m = await svc.createMarket({ question: 'audit', bUnits: 1000 });
    await svc.authorize((await svc.enqueueDeploy(m.id)).broadcast_id);
    for (let i = 0; i < 3; i++) await svc.submitOrder(m.id, order(m.id, 'yes', 'buy', 1));
    await svc.submitOrder(m.id, order(m.id, 'no', 'buy', 1));
    await svc.authorize((await svc.enqueueSettle(m.id)).broadcast_id);

    // An honest settlement audits clean.
    const good = svc.auditMarket(m.id);
    expect(good.ok).toBe(true);
    expect(good.batches).toBe(1);
    expect(good.reports[0]!.violations).toHaveLength(0);
    expect(good.reports[0]!.receiptCount).toBe(4);
    expect(good.reports[0]!.rabinAttested).toBe(true); // CONC-003b: recorded a slashable Rabin attestation

    // Tamper a settled receipt in the DB → the auditor proves the mismatch (sig + net cash + digest).
    db.prepare('UPDATE exec_orders SET cost_sats = cost_sats + 1 WHERE market_id=? AND seq=1').run(m.id);
    const bad = svc.auditMarket(m.id);
    expect(bad.ok).toBe(false);
    const checks = bad.reports[0]!.violations.map((v) => v.check);
    expect(checks).toContain('receipt_sig');
    expect(checks).toContain('net_cash');
    expect(checks).toContain('digest');
  });
});
