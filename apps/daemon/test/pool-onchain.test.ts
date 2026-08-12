// MAINNET-016 — a pool that was never broadcast cannot be spent, and the daemon says so BEFORE the fee.
//
// What happened: market #6 was seeded — its deploy transaction was built and Script-verified exactly as on
// mainnet and then deliberately not broadcast. The operator console still offered `settle` and `resolve`,
// both were authorized, and the network answered:
//
//   #29 settle  — "unexpected response code 500: Missing inputs"
//   #30 resolve — "unexpected response code 500: 258: txn-mempool-conflict"
//
// Nothing was lost, since a rejected transaction pays no fee. But `poolSpendable` had been standing in for
// "can this be spent", and it only ever answered "can THIS BUILD produce a valid unlocking script" — a
// question about code, not about whether the output exists.
//
// The database already knew: migration 016 records the network each broadcast reached.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner } from '@pm/execution';
import { MarketService, ServiceError } from '../src/service.js';
import { PrivateKey } from '@bsv/sdk';

const operatorKey = PrivateKey.fromRandom();

describe('MAINNET-016 — a pool must exist on chain before it can be spent', () => {
  let db: Db;
  let svc: MarketService;
  let marketId: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    svc = new MarketService(db, new MockEngine(), new ExecutionEngine(db, makeReceiptSigner()), operatorKey);
    const m = await svc.createMarket({ question: 'Never broadcast?', bUnits: 20 });
    marketId = (m as any).id;
    const q = await svc.enqueueDeploy(marketId);
    await svc.authorize((q as any).broadcast_id ?? (q as any).id);
  });

  /** Rewrite the deploy's recorded network, which is what `poolNotOnChain` reads. */
  const setDeployNetwork = (network: string | null) =>
    db.prepare("UPDATE broadcasts SET network=? WHERE kind='deploy'").run(network);

  it('refuses to settle or resolve a pool whose deploy never reached mainnet', async () => {
    process.env.PM_NETWORK = 'mainnet';
    setDeployNetwork(null); // the seeded case: recorded before migration 016, never broadcast

    await expect(svc.enqueueResolve(marketId, 'yes')).rejects.toThrow(/only exists locally|never broadcast/);
    await expect(svc.enqueueSettle(marketId)).rejects.toThrow(/only exists locally|never broadcast/);

    // A conflict, not a crash: the operator gets a sentence, not a stack trace.
    await svc.enqueueResolve(marketId, 'yes').catch((e) => {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).status).toBe(409);
    });
  });

  it('says WHICH kind of stranded it is, so nobody recompiles a contract that was fine', async () => {
    process.env.PM_NETWORK = 'mainnet';
    setDeployNetwork(null);
    const pool = (svc.getMarket(marketId) as any).pool;
    expect(pool.spendable).toBe(false);
    expect(pool.unspendable_reason).toMatch(/never broadcast/);
    expect(pool.unspendable_reason, 'must not blame the contract build').not.toMatch(/earlier build/);
  });

  it('allows it once the deploy really did reach mainnet', async () => {
    process.env.PM_NETWORK = 'mainnet';
    setDeployNetwork('mainnet');
    expect((svc.getMarket(marketId) as any).pool.spendable).toBe(true);
    await expect(svc.enqueueResolve(marketId, 'yes')).resolves.toBeTruthy();
  });

  it('never blocks a local run, where not broadcasting is the entire point', async () => {
    process.env.PM_NETWORK = 'local';
    setDeployNetwork(null);
    expect((svc.getMarket(marketId) as any).pool.spendable).toBe(true);
    await expect(svc.enqueueResolve(marketId, 'yes')).resolves.toBeTruthy();
  });
});
