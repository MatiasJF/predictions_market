// ChainingProvider — overlays locally-built, not-yet-confirmed (0-conf) transactions on top of a base
// provider so the SDK can build a CHAIN of pool spends in one authorize. It is a client-side workaround for
// BUG-003: WhatsOnChain still reports the just-spent confirmed funding UTXO as unspent, so without this the
// SDK would re-select it and double-spend. After each step we `register()` the tx: its inputs become spent
// (hidden from getUtxos) and its change output (to the funding address) becomes an available 0-conf UTXO.
//
// Only funding-address queries are overlaid; the pool UTXO is spent via RunarContract.fromUtxo, not getUtxos.
// Broadcasts always go to the real network (the base provider). Delegates everything else to the base.
import type { Transaction } from '@bsv/sdk';
import type { Utxo } from './types.js';

interface BaseProvider {
  getUtxos(address: string): Promise<Utxo[]>;
  getRawTransaction(txid: string): Promise<string>;
  broadcast(tx: Transaction): Promise<string>;
  getTransaction?(txid: string): Promise<unknown>;
}

export class ChainingProvider {
  private readonly spent = new Set<string>();       // "txid:vout" consumed by registered txs
  private readonly created: Utxo[] = [];            // change outputs to the funding address (0-conf)
  private readonly rawTx = new Map<string, string>(); // txid → hex, for registered txs
  private readonly registered = new Set<string>();  // txids already registered (idempotent)

  constructor(
    private readonly base: BaseProvider,
    private readonly fundingAddress: string,
    private readonly fundingLockHex: string,
  ) {
    // Delegate any method/prop we don't override (getFeeRate, getChainInfo, …) to the base provider, so the
    // overlay is a drop-in for the SDK. Overridden methods (getUtxos/getRawTransaction/broadcast/…) win.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        }
        const bv = (base as unknown as Record<string | symbol, unknown>)[prop];
        return typeof bv === 'function' ? (bv as (...a: unknown[]) => unknown).bind(base) : bv;
      },
    });
  }

  has(txid: string): boolean {
    return this.registered.has(txid);
  }

  /** Record a just-built tx (idempotent): hide its inputs, expose its change output, remember its hex. */
  register(tx: Transaction): void {
    const txid = tx.id('hex') as string;
    if (this.registered.has(txid)) return;
    this.registered.add(txid);
    this.rawTx.set(txid, tx.toHex());
    for (const inp of tx.inputs) this.spent.add(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
    tx.outputs.forEach((o, vout) => {
      if (o.lockingScript?.toHex() === this.fundingLockHex) {
        this.created.push({ txid, outputIndex: vout, satoshis: o.satoshis ?? 0, script: this.fundingLockHex });
      }
    });
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const confirmed = (await this.base.getUtxos(address)).filter((u) => !this.spent.has(`${u.txid}:${u.outputIndex}`));
    if (address !== this.fundingAddress) return confirmed;
    const local = this.created.filter((u) => !this.spent.has(`${u.txid}:${u.outputIndex}`));
    // Dedupe by outpoint — once a tx confirms, the base provider also returns its change.
    const byOutpoint = new Map<string, Utxo>();
    for (const u of [...confirmed, ...local]) byOutpoint.set(`${u.txid}:${u.outputIndex}`, u);
    return [...byOutpoint.values()];
  }

  async getRawTransaction(txid: string): Promise<string> {
    return this.rawTx.get(txid) ?? this.base.getRawTransaction(txid);
  }

  async broadcast(tx: Transaction): Promise<string> {
    return this.base.broadcast(tx);
  }

  async getTransaction(txid: string): Promise<unknown> {
    if (this.base.getTransaction) return this.base.getTransaction(txid);
    return this.rawTx.get(txid);
  }
}
