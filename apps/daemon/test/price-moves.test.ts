// CURVE-001 — the displayed price must move when someone trades.
//
// It did not. `getMarket` priced from the on-chain pool, which only advances when a batch SETTLES, so the
// headline price sat frozen through every fill and then jumped at settlement. With `b` hard-coded at 1000 the
// jump was 2 satoshis, so the whole thing read as "this market has a fixed price" — and lowering `b` to 20
// changed nothing, because the display was never looking at the trades in the first place.
//
// The same defect was already found and fixed for payment intents (ADR-040). It survived here because the quote
// path and the display path each computed a price of their own. This test pins the display path.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, signOrder, makeTraderWallet } from '@pm/execution';
import { MarketService } from '../src/service.js';
import { paidBuy } from './helpers/pay.js';
import { OfflineChainCheck } from '@pm/wallet';
import { PrivateKey } from '@bsv/sdk';

const PAYOUT_UNIT = 1000;

async function market(bUnits: number) {
  const db: Db = openDb(':memory:');
  migrate(db);
  const exec = new ExecutionEngine(db, makeReceiptSigner());
  const svc = new MarketService(db, new MockEngine(), exec, PrivateKey.fromRandom(), new OfflineChainCheck());
  const m = await svc.createMarket({ question: 'q', bUnits, payoutUnit: PAYOUT_UNIT });
  await svc.enqueueDeploy(m.id);
  const dep = db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='deploy'").get(m.id) as { id: number };
  await svc.authorize(dep.id);
  return { db, svc, id: m.id };
}

const buy = async (svc: MarketService, id: number, units: number, nonce: number) => {
  const w = makeTraderWallet();
  const fields = { marketId: id, trader: w.pubkey, side: 'yes' as const, action: 'buy' as const, units: BigInt(units), nonce };
  await paidBuy(svc, id, { trader: w.pubkey, side: 'yes', units, sig: signOrder(w.wif, fields), nonce });
};

describe('CURVE-001 — the price moves as people trade', () => {
  let db: Db; let svc: MarketService; let id: number;
  beforeEach(async () => { ({ db, svc, id } = await market(20)); });

  it('starts at an even 50/50', () => {
    const m = svc.getMarket(id) as any;
    expect(m.prices.yes_sats).toBe(PAYOUT_UNIT / 2);
    expect(m.prices.no_sats).toBe(PAYOUT_UNIT / 2);
  });

  it('moves the YES price UP on a buy — BEFORE any settlement', async () => {
    const before = (svc.getMarket(id) as any).prices.yes_sats;
    await buy(svc, id, 5, 1);
    const after = (svc.getMarket(id) as any).prices.yes_sats;
    expect(after, 'the displayed price must react to a fill, not wait for a batch').toBeGreaterThan(before);
    // b=20, 5 buys: the curve says ~562 out of 1000. Anything near 500 means the pool is being read again.
    expect(after).toBeGreaterThan(540);
    // …and the market is still unsettled, which is the whole point.
    expect((svc.getMarket(id) as any).pool.version).toBe(0);
  });

  it('keeps moving with each further buy', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await buy(svc, id, 5, 100 + i);
      seen.push((svc.getMarket(id) as any).prices.yes_sats);
    }
    expect(seen, `prices should climb, got ${seen.join(' → ')}`).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size, 'every fill should move the price').toBe(seen.length);
  });

  it('a flat b barely moves and a steep b moves a lot — the knob does something', async () => {
    const flat = await market(1000);
    await buy(flat.svc, flat.id, 20, 1);
    const flatPrice = (flat.svc.getMarket(flat.id) as any).prices.yes_sats;

    await buy(svc, id, 20, 1);
    const steepPrice = (svc.getMarket(id) as any).prices.yes_sats;

    expect(flatPrice - 500, 'b=1000 is nearly flat, as the operator observed').toBeLessThan(10);
    expect(steepPrice - 500, 'b=20 should move properly').toBeGreaterThan(200);
  });

  it('reports the settled price separately, so the unsettled gap is visible not hidden', async () => {
    await buy(svc, id, 5, 1);
    const m = svc.getMarket(id) as any;
    expect(m.settled_prices.yes_sats, 'the chain has not seen this batch yet').toBe(PAYOUT_UNIT / 2);
    expect(m.prices.yes_sats).toBeGreaterThan(m.settled_prices.yes_sats);
  });

  it('survives a restart — a fresh service resumes the live price from the fill ledger', async () => {
    await buy(svc, id, 5, 1);
    const live = (svc.getMarket(id) as any).prices.yes_sats;
    const reopened = new MarketService(db, new MockEngine(), new ExecutionEngine(db, makeReceiptSigner()), PrivateKey.fromRandom(), new OfflineChainCheck());
    expect((reopened.getMarket(id) as any).prices.yes_sats).toBe(live);
  });
});
