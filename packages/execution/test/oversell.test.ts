// MAINNET-013 — you may only sell what you hold.
//
// `applyUnitSell` throws on oversell, but that guard is about the POOL: it stops the market's own `q`
// going negative. Nothing checked the TRADER. So a trader with no position could sell into shares
// somebody else had bought, take the proceeds, and — now that sells book a debt the operator pays
// from the stake pot — be owed real money for a position they never held.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD } from '@pm/lmsr';
import { ExecutionEngine, makeReceiptSigner, makeTraderWallet, signOrder } from '../src/index.js';

const P = { b: 1000n * WAD, payoutUnit: 1000n, unit: WAD };
let db: Db;
let exec: ExecutionEngine;
const MARKET = 1;

const alice = makeTraderWallet();
const bob = makeTraderWallet();

const order = (w: typeof alice, action: 'buy' | 'sell', units: number, nonce: number) => ({
  marketId: MARKET, trader: w.pubkey, side: 'yes' as const, action, units: BigInt(units), nonce,
  sig: signOrder(w.wif, {
    marketId: MARKET, trader: w.pubkey, side: 'yes' as const, action, units: BigInt(units), nonce,
  }),
  // Funding is not what this file is about; sells never carry it and buys are waved through here.
  funding: action === 'buy' ? { intentId: nonce, paidSats: 10_000_000 } : undefined,
});

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  exec = new ExecutionEngine(db, makeReceiptSigner());
  exec.openMarket(MARKET, P);
});

describe('selling what you do not hold', () => {
  it('REFUSES a sell from a trader with no position', async () => {
    // Alice buys 5. The market now holds shares — but they are hers.
    await exec.submit(order(alice, 'buy', 5, 1) as any);

    await expect(
      exec.submit(order(bob, 'sell', 3, 2) as any),
      'Bob never bought anything; selling would owe him money for nothing',
    ).rejects.toThrow(/hold|position|oversell/i);

    // And nothing was recorded for him — a refused order must leave no trace.
    const bobs = exec.positionsOf(MARKET, bob.pubkey);
    const bobHolds = bobs.length ? Number(BigInt(bobs[0]!.netYesShares) / WAD) : 0;
    expect(bobHolds, 'a refused sell must not leave Bob short').toBe(0);
  });

  it('REFUSES a sell LARGER than the position held', async () => {
    await exec.submit(order(alice, 'buy', 2, 1) as any);
    await expect(exec.submit(order(alice, 'sell', 5, 2) as any)).rejects.toThrow(/hold|position|oversell/i);
  });

  it('ALLOWS closing exactly what is held', async () => {
    await exec.submit(order(alice, 'buy', 4, 1) as any);
    await exec.submit(order(alice, 'sell', 4, 2) as any);
    const [pos] = exec.positionsOf(MARKET, alice.pubkey);
    expect(Number(BigInt(pos!.netYesShares) / WAD), 'closing a position should leave nothing').toBe(0);
  });

  it('ALLOWS a partial close', async () => {
    await exec.submit(order(alice, 'buy', 5, 1) as any);
    await exec.submit(order(alice, 'sell', 2, 2) as any);
    const [pos] = exec.positionsOf(MARKET, alice.pubkey);
    expect(Number(BigInt(pos!.netYesShares) / WAD)).toBe(3);
  });
});
