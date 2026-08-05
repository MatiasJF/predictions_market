// MockEngine — a ChainEngine for tests. Reuses RunarEngine's REAL offline build* math (LMSR update + Rúnar
// compile, no network), but overrides the chain I/O: fundingAddress/getUtxos return fixtures and
// authorizeAndBroadcast returns a deterministic fake txid instead of touching mainnet. Lets the service's
// full enqueue → authorize → apply-effects → advance-lineage flow be tested with zero broadcasts.
import { WAD } from '@pm/lmsr';
import { RunarEngine } from './runar.js';
import type { BroadcastResult, MarketConfig, PoolRef, SettleBatch, TxEffects, TxPlan, Utxo } from './types.js';

export class MockEngine extends RunarEngine {
  override readonly name: string = 'mock';
  private counter = 0;
  private readonly addr: string;
  private readonly utxos: Utxo[];

  constructor(opts?: { address?: string; utxos?: Utxo[] }) {
    super('mainnet');
    this.addr = opts?.address ?? '1MockFundingAddress0000000000000000';
    this.utxos = opts?.utxos ?? [{ txid: 'ab'.repeat(32), outputIndex: 0, satoshis: 2_000_000, script: '' }];
  }

  override async fundingAddress(): Promise<string> {
    return this.addr;
  }
  override async fundingPublicKey(): Promise<string> {
    return '02' + 'ab'.repeat(32); // fixed mock compressed pubkey (no WIF in tests)
  }
  override async getUtxos(_address: string): Promise<Utxo[]> {
    return this.utxos;
  }
  /** Net-state batch settlement (CONC-002) — mirrors the sCrypt contract's settle() net update, no broadcast. */
  async buildSettleBatch(cfg: MarketConfig, pool: PoolRef, batch: SettleBatch): Promise<TxPlan> {
    const yBuy = batch.netYesUnits >= 0n;
    const nBuy = batch.netNoUnits >= 0n;
    const stepE = (e0: bigint, net: bigint, isBuy: boolean): bigint => {
      const n = net < 0n ? -net : net;
      const m = isBuy ? cfg.mult : cfg.invMult;
      let e = e0;
      for (let i = 0n; i < n; i++) e = (e * m) / WAD;
      return e;
    };
    const eYes = stepE(pool.state.eYes, batch.netYesUnits, yBuy);
    const eNo = stepE(pool.state.eNo, batch.netNoUnits, nBuy);
    const qYes = pool.state.qYes + batch.netYesUnits * WAD; // unit = WAD
    const qNo = pool.state.qNo + batch.netNoUnits * WAD;
    const collateral = pool.state.collateral + BigInt(batch.netCollateralSats);

    const effects: TxEffects = {
      pool: {
        vout: 0, satoshis: pool.satoshis,
        eYes: eYes.toString(), eNo: eNo.toString(), qYes: qYes.toString(), qNo: qNo.toString(),
        collateral: collateral.toString(), resolved: 0, winner: 0, lockingScript: '',
      },
      spendsPrevPool: true,
      settle: {
        orderIds: batch.orderIds,
        netYesUnits: batch.netYesUnits.toString(),
        netNoUnits: batch.netNoUnits.toString(),
        netCollateralSats: batch.netCollateralSats,
        trades: batch.fills.map((f) => ({ side: f.side, action: f.action, shares: f.shares, costSats: f.costSats })),
        batchDigest: batch.batchDigest,
      },
      marketState: 'trading',
    };
    return {
      kind: 'settle',
      summary: `settle ${batch.orderIds.length} off-chain fills (net YES ${batch.netYesUnits}, NO ${batch.netNoUnits})`,
      spendSats: 200,
      build: { kind: 'settle', batchDigest: batch.batchDigest },
      effects,
    };
  }

  /** Deterministic Rabin-attestation stub (no real Rabin key in tests) — exercises the recording path. */
  rabinAttest(marketId: number, toVersion: number, digest: string): { key: string; sig: string; pubkey: string } {
    return { key: `${marketId}:${toVersion}`, sig: `mock-rabin-sig:${digest.slice(0, 8)}`, pubkey: 'mock-seq-rabin' };
  }

  override async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
    this.counter += 1;
    const txid = this.counter.toString(16).padStart(64, '0'); // deterministic, unique per broadcast
    const poolLockingScript = plan.effects.pool.lockingScript || '6a046d6f636b'; // OP_RETURN 'mock'
    return { txid, poolLockingScript };
  }
}
