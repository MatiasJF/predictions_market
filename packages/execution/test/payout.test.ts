import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD, type MarketParams } from '@pm/lmsr';
import {
  ExecutionEngine, WifReceiptSigner, signOrder, makeTraderWallet,
  winningPayouts, computePayoutDigest, payoutTotal, pkhOf,
} from '../src/index.js';

// PAYOUT-001 — who is owed what, derived from the fill ledger. The security-relevant properties: losers get
// nothing, sells reduce the claim, and the digest changes if the list changes.
const P: MarketParams = { b: 1000n * WAD, payoutUnit: 100n, unit: WAD };
const MARKET = 1;
const alice = makeTraderWallet();
const bob = makeTraderWallet();
const carol = makeTraderWallet();

function fresh(): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  // FUND-001: these predate the money leg and exercise LMSR/receipt/settlement mechanics, not funding.
  // Funding is proven in `funding.test.ts`; opting out explicitly here keeps each test about one thing.
  const eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()), true, false);
  eng.openMarket(MARKET, P);
  return { db, eng };
}
let nonce = 0;
async function fill(eng: ExecutionEngine, w: { wif: string; pubkey: string }, side: 'yes' | 'no', action: 'buy' | 'sell', units = 1n) {
  const f = { marketId: MARKET, trader: w.pubkey, side, action, units, nonce: ++nonce };
  return eng.submit({ ...f, sig: signOrder(w.wif, f), ts: nonce });
}

describe('winningPayouts (PAYOUT-001)', () => {
  it('pays net-long winners, and pays losers NOTHING', async () => {
    const { db, eng } = fresh();
    await fill(eng, alice, 'yes', 'buy', 3n); // winner: 3 YES
    await fill(eng, bob, 'no', 'buy', 5n);    // loser: only NO
    await fill(eng, carol, 'yes', 'buy', 1n); // winner: 1 YES

    const list = winningPayouts(db, MARKET, 'yes', P.payoutUnit);
    expect(list).toHaveLength(2); // bob excluded entirely
    expect(list.some((p) => p.trader === bob.pubkey), 'loser must not be paid').toBe(false);

    const a = list.find((p) => p.trader === alice.pubkey)!;
    expect(a.shares).toBe((3n * WAD).toString());
    expect(a.sats).toBe(300); // 3 shares × payoutUnit 100
    expect(a.pkh).toBe(pkhOf(alice.pubkey));
    expect(a.pkh).toHaveLength(40);

    expect(payoutTotal(list)).toBe(400); // 300 + 100
  });

  it('nets sells against buys, and drops anyone who closed out', async () => {
    const { db, eng } = fresh();
    await fill(eng, alice, 'yes', 'buy', 4n);
    await fill(eng, bob, 'yes', 'buy', 2n);
    await fill(eng, alice, 'yes', 'sell', 1n); // alice now net 3
    await fill(eng, bob, 'yes', 'sell', 2n);   // bob flat → no claim

    const list = winningPayouts(db, MARKET, 'yes', P.payoutUnit);
    expect(list).toHaveLength(1);
    expect(list[0]!.trader).toBe(alice.pubkey);
    expect(list[0]!.sats).toBe(300);
  });

  it('resolves the OTHER way and pays the other side', async () => {
    const { db, eng } = fresh();
    await fill(eng, alice, 'yes', 'buy', 3n);
    await fill(eng, bob, 'no', 'buy', 2n);

    const noWins = winningPayouts(db, MARKET, 'no', P.payoutUnit);
    expect(noWins).toHaveLength(1);
    expect(noWins[0]!.trader).toBe(bob.pubkey);
    expect(noWins[0]!.sats).toBe(200);
  });

  it('digest is deterministic, order-stable, and changes when the list changes', async () => {
    const { db, eng } = fresh();
    await fill(eng, alice, 'yes', 'buy', 2n);
    await fill(eng, carol, 'yes', 'buy', 1n);

    const list = winningPayouts(db, MARKET, 'yes', P.payoutUnit);
    expect(computePayoutDigest(list)).toBe(computePayoutDigest(list));
    // the list is sorted by trader pubkey, so it does not depend on fill order
    expect(computePayoutDigest([...list].reverse().sort((a, b) => (a.trader < b.trader ? -1 : 1))))
      .toBe(computePayoutDigest(list));
    const tampered = list.map((p, i) => (i === 0 ? { ...p, sats: p.sats + 1 } : p));
    expect(computePayoutDigest(tampered)).not.toBe(computePayoutDigest(list));
  });
});
