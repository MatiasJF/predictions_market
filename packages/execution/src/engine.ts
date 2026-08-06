// ExecutionEngine (CONC-001) — the off-chain execution layer of the app-specific rollup (ADR-019).
// Holds the authoritative in-memory LMSR state per market and fills orders INSTANTLY over @pm/lmsr. Concurrent
// submits for the same market are SERIALIZED (a per-market promise chain) so there is a single total order with
// no UTXO contention — the property a single on-chain pool cannot provide. Each fill is persisted to the
// exec_orders ledger with a signed receipt. On-chain settlement (CONC-002) batches these into one pool-version tx.
import {
  initState,
  unitMultiplier,
  unitInverseMultiplier,
  applyUnitBuy,
  applyUnitSell,
  buyChargeApproxSats,
  sellPayoutApproxSats,
  priceYesSats,
  priceNoSats,
  type MarketParams,
  type MarketState,
  type Side,
} from '@pm/lmsr';
import type { Db } from '@pm/persistence';
import {
  receiptPayload,
  stateCommitment,
  type OrderAction,
  type Receipt,
  type ReceiptSigner,
} from './receipt.js';
import { signAttestation, type Attestation } from './audit.js';

export interface OrderInput {
  marketId: number;
  trader: string; // pubkey DER hex
  side: Side;
  action: OrderAction;
  units: bigint; // number of trade UNITS to fill (each unit = params.unit shares)
  ts?: number; // optional timestamp (ms); pass in tests for determinism
}

export interface SignedReceipt {
  receipt: Receipt;
  sig: string;
  signerPubkey: string;
}

export interface TraderPosition {
  trader: string;
  netYesShares: string; // WAD-scaled bigint, decimal string (buys − sells)
  netNoShares: string;
  netCostSats: number; // net cash paid (buys) minus received (sells)
}

/** The unsettled fills for a market folded into the net effect a single settlement tx must apply (CONC-002). */
export interface Batch {
  marketId: number;
  orderIds: number[];
  netYesUnits: bigint; // signed: + = net buys of YES
  netNoUnits: bigint;
  netCollateralSats: number; // + = pool gains cash
  fills: {
    orderId: number;
    trader: string;
    side: Side;
    action: OrderAction;
    shares: string;
    costSats: number;
  }[];
}

interface MarketRuntime {
  params: MarketParams;
  mult: bigint;
  invMult: bigint;
  state: MarketState;
  seq: number;
  lock: Promise<void>;
}

interface OrderRow {
  id: number;
  trader_pubkey: string;
  side: Side;
  action: OrderAction;
  shares: string;
  cost_sats: number;
}

export class ExecutionEngine {
  private readonly markets = new Map<number, MarketRuntime>();

  constructor(
    private readonly db: Db,
    private readonly signer: ReceiptSigner
  ) {}

  /** Register a market's authoritative state (fresh unless a `seed` state + `seq` is supplied to resume). */
  openMarket(marketId: number, params: MarketParams, seed?: MarketState, seq = 0): void {
    this.markets.set(marketId, {
      params,
      mult: unitMultiplier(params),
      invMult: unitInverseMultiplier(params),
      state: seed ?? initState(params),
      seq,
      lock: Promise.resolve(),
    });
  }

  hasMarket(marketId: number): boolean {
    return this.markets.has(marketId);
  }

  stateOf(marketId: number): MarketState {
    return this.mkt(marketId).state;
  }

  seqOf(marketId: number): number {
    return this.mkt(marketId).seq;
  }

  /** Sign a settlement attestation with the sequencer key (CONC-003a — binds a batch to a settlement). */
  attestSettlement(a: Attestation): { sig: string; pubkey: string } {
    return signAttestation(this.signer, a);
  }

  /**
   * Adopt the on-chain settled state as authoritative (CONC-006). Fills advance the in-memory state one at a
   * time, while the chain advances it net-from-baseline via square-and-multiply — the two agree to within
   * rounding, but the chain is the source of truth, so resync at each settlement boundary. `q` is unaffected
   * (it is exact integer units); only the stored exponentials move, by sub-ppm.
   */
  resyncState(marketId: number, state: MarketState): void {
    const m = this.markets.get(marketId);
    if (!m) return; // market not open in this process — it will seed from the ledger on next open
    m.state = state;
  }

  private mkt(marketId: number): MarketRuntime {
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`execution: market ${marketId} not open`);
    return m;
  }

  /**
   * Submit one order. Concurrent submits for the SAME market are serialized in arrival order (total order, no
   * contention) by chaining onto the market's lock. Resolves with the signed receipt for the fill.
   */
  async submit(o: OrderInput): Promise<SignedReceipt> {
    const m = this.mkt(o.marketId);
    const run = m.lock.then(() => this.fill(m, o));
    // keep the chain alive whether this fill succeeds or throws, so later orders still serialize behind it
    m.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private fill(m: MarketRuntime, o: OrderInput): SignedReceipt {
    if (o.units <= 0n) throw new Error('execution: units must be > 0');
    const p = m.params;
    let state = m.state;
    let costSats = 0n;
    for (let i = 0n; i < o.units; i++) {
      if (o.action === 'buy') {
        state = applyUnitBuy(state, o.side, m.mult, p);
        costSats += buyChargeApproxSats(state, o.side, p.unit, p);
      } else {
        state = applyUnitSell(state, o.side, m.invMult, p); // throws on oversell (MM-safe)
        costSats += sellPayoutApproxSats(state, o.side, p.unit, p);
      }
    }
    m.state = state;
    m.seq += 1;

    const price = o.side === 'yes' ? priceYesSats(state, p) : priceNoSats(state, p);
    const receipt: Receipt = {
      marketId: o.marketId,
      seq: m.seq,
      trader: o.trader,
      side: o.side,
      action: o.action,
      shares: (o.units * p.unit).toString(),
      priceSats: Number(price),
      costSats: Number(costSats),
      qYes: state.qYes.toString(),
      qNo: state.qNo.toString(),
      eYes: state.eYes.toString(),
      eNo: state.eNo.toString(),
      stateHash: stateCommitment(state.qYes, state.qNo, state.eYes, state.eNo),
      ts: o.ts ?? Date.now(),
    };
    const sig = this.signer.sign(receiptPayload(receipt));
    this.persist(receipt, sig);
    return { receipt, sig, signerPubkey: this.signer.publicKeyHex };
  }

  private persist(r: Receipt, sig: string): void {
    this.db
      .prepare(
        `INSERT INTO exec_orders
         (market_id, seq, trader_pubkey, side, action, shares, price_sats, cost_sats,
          q_yes, q_no, e_yes, e_no, state_hash, sig, signer_pubkey, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.marketId, r.seq, r.trader, r.side, r.action, r.shares, r.priceSats, r.costSats,
        r.qYes, r.qNo, r.eYes, r.eNo, r.stateHash, sig, this.signer.publicKeyHex, r.ts
      );
  }

  /** Net YES/NO positions per trader (or one trader) from the fill ledger. */
  positionsOf(marketId: number, trader?: string): TraderPosition[] {
    const rows = (
      trader
        ? this.db
            .prepare(
              `SELECT trader_pubkey, side, action, shares, cost_sats
               FROM exec_orders WHERE market_id = ? AND trader_pubkey = ?`
            )
            .all(marketId, trader)
        : this.db
            .prepare(
              `SELECT trader_pubkey, side, action, shares, cost_sats
               FROM exec_orders WHERE market_id = ?`
            )
            .all(marketId)
    ) as Omit<OrderRow, 'id'>[];

    const acc = new Map<string, { yes: bigint; no: bigint; cost: number }>();
    for (const r of rows) {
      const a = acc.get(r.trader_pubkey) ?? { yes: 0n, no: 0n, cost: 0 };
      const signedShares = (r.action === 'buy' ? 1n : -1n) * BigInt(r.shares);
      if (r.side === 'yes') a.yes += signedShares;
      else a.no += signedShares;
      a.cost += r.action === 'buy' ? r.cost_sats : -r.cost_sats;
      acc.set(r.trader_pubkey, a);
    }
    return [...acc.entries()].map(([t, v]) => ({
      trader: t,
      netYesShares: v.yes.toString(),
      netNoShares: v.no.toString(),
      netCostSats: v.cost,
    }));
  }

  /** Fold the market's unsettled fills into the net effect one settlement tx must apply (CONC-002). */
  pendingBatch(marketId: number): Batch {
    const unit = this.mkt(marketId).params.unit;
    const rows = this.db
      .prepare(
        `SELECT id, trader_pubkey, side, action, shares, cost_sats
         FROM exec_orders WHERE market_id = ? AND batch_id IS NULL ORDER BY seq`
      )
      .all(marketId) as OrderRow[];

    let netYesUnits = 0n;
    let netNoUnits = 0n;
    let netCollateralSats = 0;
    const fills = rows.map((r) => {
      const units = BigInt(r.shares) / unit;
      const signedUnits = (r.action === 'buy' ? 1n : -1n) * units;
      if (r.side === 'yes') netYesUnits += signedUnits;
      else netNoUnits += signedUnits;
      netCollateralSats += r.action === 'buy' ? r.cost_sats : -r.cost_sats;
      return {
        orderId: r.id,
        trader: r.trader_pubkey,
        side: r.side,
        action: r.action,
        shares: r.shares,
        costSats: r.cost_sats,
      };
    });
    return { marketId, orderIds: rows.map((r) => r.id), netYesUnits, netNoUnits, netCollateralSats, fills };
  }
}
