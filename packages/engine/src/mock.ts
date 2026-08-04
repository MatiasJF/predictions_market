// MockEngine — a ChainEngine for tests. Reuses RunarEngine's REAL offline build* math (LMSR update + Rúnar
// compile, no network), but overrides the chain I/O: fundingAddress/getUtxos return fixtures and
// authorizeAndBroadcast returns a deterministic fake txid instead of touching mainnet. Lets the service's
// full enqueue → authorize → apply-effects → advance-lineage flow be tested with zero broadcasts.
import { RunarEngine } from './runar.js';
import type { BroadcastResult, TxPlan, Utxo } from './types.js';

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
  override async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
    this.counter += 1;
    const txid = this.counter.toString(16).padStart(64, '0'); // deterministic, unique per broadcast
    const poolLockingScript = plan.effects.pool.lockingScript || '6a046d6f636b'; // OP_RETURN 'mock'
    return { txid, poolLockingScript };
  }
}
