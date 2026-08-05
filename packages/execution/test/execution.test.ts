import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import {
  WAD,
  initState,
  unitMultiplier,
  applyUnitBuy,
  buyChargeApproxSats,
  type MarketParams,
  type MarketState,
} from '@pm/lmsr';
import { ExecutionEngine, WifReceiptSigner, verifyReceipt } from '../src/index.js';

const P: MarketParams = { b: 10n * WAD, payoutUnit: 100_000n, unit: WAD };
const MARKET = 1;
const TRADER = 'aa'.repeat(33); // placeholder trader pubkey hex

function fresh(): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  const eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()));
  eng.openMarket(MARKET, P);
  return { db, eng };
}

/** Fold N sequential unit buys of a side over @pm/lmsr — the ground truth the engine must reproduce. */
function refAfterYesBuys(n: number): MarketState {
  const mult = unitMultiplier(P);
  let s = initState(P);
  for (let i = 0; i < n; i++) s = applyUnitBuy(s, 'yes', mult, P);
  return s;
}

describe('ExecutionEngine (CONC-001) — instant fills over @pm/lmsr with signed receipts', () => {
  it('a single buy fill matches the @pm/lmsr reference and persists one row', async () => {
    const { db, eng } = fresh();
    const { receipt } = await eng.submit({
      marketId: MARKET, trader: TRADER, side: 'yes', action: 'buy', units: 1n, ts: 1,
    });

    const ref = refAfterYesBuys(1);
    const refCharge = buyChargeApproxSats(ref, 'yes', P.unit, P);
    expect(receipt.seq).toBe(1);
    expect(receipt.eYes).toBe(ref.eYes.toString());
    expect(receipt.qYes).toBe(ref.qYes.toString());
    expect(receipt.costSats).toBe(Number(refCharge));
    expect(receipt.shares).toBe(WAD.toString());

    const count = db.prepare('SELECT COUNT(*) AS c FROM exec_orders WHERE market_id = ?').get(MARKET) as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it('a receipt verifies against the signer, and any tampering fails verification', async () => {
    const { eng } = fresh();
    const sr = await eng.submit({
      marketId: MARKET, trader: TRADER, side: 'yes', action: 'buy', units: 1n, ts: 1,
    });
    expect(verifyReceipt(sr.receipt, sr.sig, sr.signerPubkey)).toBe(true);

    const tampered = { ...sr.receipt, costSats: sr.receipt.costSats + 1 };
    expect(verifyReceipt(tampered, sr.sig, sr.signerPubkey)).toBe(false);
  });

  it('selling with no inventory is rejected (MM-safe) and leaves the ledger untouched', async () => {
    const { db, eng } = fresh();
    await expect(
      eng.submit({ marketId: MARKET, trader: TRADER, side: 'yes', action: 'sell', units: 1n, ts: 1 })
    ).rejects.toThrow();

    const count = db.prepare('SELECT COUNT(*) AS c FROM exec_orders').get() as { c: number };
    expect(count.c).toBe(0);
    // in-memory state is still the fresh pool (the failed fill did not advance it)
    expect(eng.stateOf(MARKET).qYes).toBe(0n);
  });

  it('N concurrent buys serialize deterministically → seq 1..N, final state == N sequential buys', async () => {
    const { db, eng } = fresh();
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        eng.submit({ marketId: MARKET, trader: TRADER, side: 'yes', action: 'buy', units: 1n, ts: i + 1 })
      )
    );

    // Promise.all preserves submission order → the i-th submit got seq i+1 (a single total order, no gaps).
    expect(results.map((r) => r.receipt.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // Authoritative in-memory state equals N unit buys applied sequentially over @pm/lmsr.
    const ref = refAfterYesBuys(N);
    const st = eng.stateOf(MARKET);
    expect(st.qYes.toString()).toBe(ref.qYes.toString());
    expect(st.eYes.toString()).toBe(ref.eYes.toString());

    // The ledger holds exactly N rows with contiguous seq 1..N.
    const rows = db
      .prepare('SELECT seq FROM exec_orders WHERE market_id = ? ORDER BY seq')
      .all(MARKET) as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('pendingBatch folds unsettled fills into net per-side units and net cash', async () => {
    const { eng } = fresh();
    await eng.submit({ marketId: MARKET, trader: TRADER, side: 'yes', action: 'buy', units: 2n, ts: 1 });
    await eng.submit({ marketId: MARKET, trader: TRADER, side: 'no', action: 'buy', units: 1n, ts: 2 });

    const batch = eng.pendingBatch(MARKET);
    expect(batch.netYesUnits).toBe(2n);
    expect(batch.netNoUnits).toBe(1n);
    expect(batch.orderIds.length).toBe(2);
    expect(batch.netCollateralSats).toBeGreaterThan(0); // buys bring cash into the pool

    const positions = eng.positionsOf(MARKET, TRADER);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.netYesShares).toBe((2n * WAD).toString());
    expect(positions[0]!.netNoShares).toBe(WAD.toString());
  });
});
