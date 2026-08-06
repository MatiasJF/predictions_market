// @pm/daemon service — HTTP-agnostic orchestration over a Db + a ChainEngine (Golden Rule 5). Read ops
// (markets, quote, wallet balance) answer immediately; state-changing ops build a TxPlan and PARK it in the
// broadcasts sign-off queue. authorize() is the ONLY method that broadcasts — it asks the engine to sign+send
// (the sole WIF use), then applies the plan's DB effects and advances the pool_utxos lineage. Nothing reaches
// mainnet without an explicit authorize() call (ADR-010).
import type { Db } from '@pm/persistence';
import type { BroadcastRow, ExecOrderRow, MarketRow, PoolUtxoRow, TokenRow } from '@pm/persistence';
import {
  WAD, initState, unitMultiplier, unitInverseMultiplier, applyUnitBuy, applyUnitSell,
  buyChargeApproxSats, sellPayoutApproxSats, priceYesSats, priceNoSats,
  type MarketParams, type MarketState,
} from '@pm/lmsr';
import { EngineLimitation, MAX_UNITS, type BroadcastResult, type ChainEngine, type MarketConfig, type PoolRef, type PoolState, type SettleBatch, type Side, type TxPlan } from '@pm/engine';
import { computeBatchDigest, receiptFromRow, stateCommitment, auditSettlement, winningPayouts, computePayoutDigest, payoutTotal, type ExecutionEngine } from '@pm/execution';

const DEPLOY_SATS = 1000; // pool UTXO holds dust — collateral is state, not locked sats (spike scope).
const MAX_QUOTE_SHARES = 10_000;

/** A typed error the HTTP layer maps to a status code. */
export class ServiceError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
const notFound = (m: string) => new ServiceError(404, m, 'not_found');
const badReq = (m: string) => new ServiceError(400, m, 'bad_request');
const conflict = (m: string) => new ServiceError(409, m, 'conflict');

const asSide = (s: string): Side => {
  const v = s.toLowerCase();
  if (v !== 'yes' && v !== 'no') throw badReq(`side must be 'yes' or 'no', got '${s}'`);
  return v;
};
const asAction = (s: string): 'buy' | 'sell' => {
  const v = (s ?? '').toLowerCase();
  if (v !== 'buy' && v !== 'sell') throw badReq(`action must be 'buy' or 'sell', got '${s}'`);
  return v;
};
const intShares = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 1 || n > MAX_UNITS) throw badReq(`shares must be an integer in 1..${MAX_UNITS}`);
  return BigInt(n);
};
/** Run an engine build, keeping EngineLimitation (→501)/ServiceError intact and mapping other errors → 400. */
async function built(fn: () => Promise<TxPlan>): Promise<TxPlan> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EngineLimitation || e instanceof ServiceError) throw e;
    throw new ServiceError(400, e instanceof Error ? e.message : String(e), 'build_failed');
  }
}

export class MarketService {
  constructor(
    private readonly db: Db,
    private readonly engine: ChainEngine,
    private readonly exec?: ExecutionEngine
  ) {}

  /** Which chain engine is behind this daemon (for /health). */
  get engineName(): string { return this.engine.name; }

  private execOrThrow(): ExecutionEngine {
    if (!this.exec) throw new ServiceError(501, 'off-chain execution engine not configured on this daemon', 'no_exec');
    return this.exec;
  }
  /** Open the market on the execution engine, resuming its authoritative state from the exec_orders ledger. */
  private ensureExecOpen(m: MarketRow): void {
    if (!this.exec || this.exec.hasMarket(m.id)) return;
    const p = paramsOf(cfgOf(m));
    const last = this.db
      .prepare('SELECT seq, q_yes, q_no, e_yes, e_no FROM exec_orders WHERE market_id=? ORDER BY seq DESC LIMIT 1')
      .get(m.id) as { seq: number; q_yes: string; q_no: string; e_yes: string; e_no: string } | undefined;
    if (last) {
      this.exec.openMarket(m.id, p, { eYes: BigInt(last.e_yes), eNo: BigInt(last.e_no), qYes: BigInt(last.q_yes), qNo: BigInt(last.q_no) }, last.seq);
    } else {
      const pool = this.currentPool(m.id);
      this.exec.openMarket(m.id, p, pool ? poolStateToMarketState(pool) : initState(p), 0);
    }
  }

  // ── markets ───────────────────────────────────────────────────────────────────────────────────────
  async createMarket(input: { question: string; description?: string; bUnits: number | bigint; payoutUnit?: number | bigint; network?: string }) {
    const question = (input.question ?? '').trim();
    if (!question) throw badReq('question is required');
    const bUnits = BigInt(input.bUnits ?? 0);
    if (bUnits <= 0n) throw badReq('bUnits must be a positive integer (LMSR liquidity in share-units)');
    const payoutUnit = BigInt(input.payoutUnit ?? 100_000);
    const network = input.network ?? 'mainnet';

    const platformKeyId = this.keyRefId('platform:' + network, 'platform', await this.engine.fundingPublicKey(), network, 'funding wallet public key');
    const oracleKeyId = this.keyRefId('oracle:mock:' + network, 'oracle', this.engine.oracleId(), network, 'mock Rabin oracle identifier');

    const info = this.db.prepare(
      `INSERT INTO markets(question, description, b, scale, payout_unit, oracle_key_id, platform_key_id, network, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'imported')`,
    ).run(question, input.description ?? null, (bUnits * WAD).toString(), WAD.toString(), Number(payoutUnit), oracleKeyId, platformKeyId, network);
    return this.getMarket(Number(info.lastInsertRowid));
  }

  listMarkets() {
    const rows = this.db.prepare('SELECT id FROM markets ORDER BY id').all() as { id: number }[];
    return rows.map((r) => this.getMarket(r.id));
  }

  getMarket(id: number) {
    const m = this.marketRow(id);
    const cfg = cfgOf(m);
    const p = paramsOf(cfg);
    const pool = this.currentPool(id);
    const state: MarketState = pool ? poolStateToMarketState(pool) : initState(p);
    const pos = this.positions(id);
    return {
      id: m.id,
      question: m.question,
      description: m.description,
      bUnits: Number(cfg.bUnits),
      payoutUnit: Number(cfg.payoutUnit),
      network: m.network,
      state: m.state,
      resolution: m.resolution,
      prices: { yes_sats: Number(priceYesSats(state, p)), no_sats: Number(priceNoSats(state, p)) },
      positions: { yes_net_shares: pos.yes.net_shares, no_net_shares: pos.no.net_shares },
      pool: pool
        ? {
            version: pool.version, txid: pool.txid, vout: pool.vout, sats: pool.sats,
            qYes: pool.q_yes, qNo: pool.q_no, eYes: pool.e_yes, eNo: pool.e_no,
            collateral: pool.collateral, resolved: pool.resolved, winner: pool.winner,
            // Whether THIS build can still spend it. A pool deployed by an earlier build of the contract is
            // stranded — surfaced here so a client can refuse the action instead of failing at authorize time.
            spendable: this.engine.poolSpendable?.(poolRef(pool)) ?? true,
          }
        : null,
    };
  }

  // ── quote (pure LMSR — no chain, no queue) ──────────────────────────────────────────────────────────
  quote(id: number, sideStr: string, shares: number) {
    const side = asSide(sideStr);
    if (!Number.isInteger(shares) || shares <= 0) throw badReq('shares must be a positive integer');
    if (shares > MAX_QUOTE_SHARES) throw badReq(`shares capped at ${MAX_QUOTE_SHARES} for a quote`);
    const m = this.marketRow(id);
    const cfg = cfgOf(m);
    const p = paramsOf(cfg);
    const pool = this.currentPool(id);
    const cur: MarketState = pool ? poolStateToMarketState(pool) : initState(p);

    // Buy: sum the per-unit MM-safe charges over `shares` multiplicative unit-buys (what N sequential buys cost).
    let sBuy = cur; let buyCharge = 0n;
    const mult = unitMultiplier(p);
    for (let i = 0; i < shares; i++) { const nx = applyUnitBuy(sBuy, side, mult, p); buyCharge += buyChargeApproxSats(nx, side, p.unit, p); sBuy = nx; }

    // Sell: only if the pool has ≥ shares outstanding on that side; sum per-unit proceeds.
    const held = side === 'yes' ? cur.qYes : cur.qNo;
    let sellProceeds: bigint | null = null;
    if (held >= BigInt(shares) * p.unit) {
      let sSell = cur; let acc = 0n; const inv = unitInverseMultiplier(p);
      for (let i = 0; i < shares; i++) { const nx = applyUnitSell(sSell, side, inv, p); acc += sellPayoutApproxSats(nx, side, p.unit, p); sSell = nx; }
      sellProceeds = acc;
    }
    return {
      market_id: id, side, shares,
      price_yes_sats: Number(priceYesSats(cur, p)),
      price_no_sats: Number(priceNoSats(cur, p)),
      est_buy_charge_sats: Number(buyCharge),
      est_sell_proceeds_sats: sellProceeds === null ? null : Number(sellProceeds),
      avg_buy_price_sats: Number(buyCharge) / shares,
    };
  }

  // ── positions (aggregate the trades ledger into a book) ─────────────────────────────────────────────
  positions(id: number) {
    this.marketRow(id); // 404 if missing
    const rows = this.db.prepare('SELECT side, action, shares, cost_sats FROM trades WHERE market_id=?').all(id) as
      { side: Side; action: 'buy' | 'sell'; shares: string; cost_sats: number }[];
    const acc: Record<Side, { net: bigint; bought: bigint; sold: bigint; cost: number }> = {
      yes: { net: 0n, bought: 0n, sold: 0n, cost: 0 },
      no: { net: 0n, bought: 0n, sold: 0n, cost: 0 },
    };
    for (const r of rows) {
      const sh = BigInt(r.shares);
      const a = acc[r.side];
      if (r.action === 'buy') { a.net += sh; a.bought += sh; a.cost += r.cost_sats; }
      else { a.net -= sh; a.sold += sh; a.cost -= r.cost_sats; }
    }
    const view = (x: { net: bigint; bought: bigint; sold: bigint; cost: number }) => ({
      net_shares: Number(x.net / WAD), bought_shares: Number(x.bought / WAD), sold_shares: Number(x.sold / WAD),
      net_cost_sats: x.cost, // sats paid out to the pool (buys) minus proceeds received (sells)
    });
    return { market_id: id, trades: rows.length, yes: view(acc.yes), no: view(acc.no) };
  }

  // ── enqueue (build a TxPlan, park it pending) ───────────────────────────────────────────────────────
  async enqueueDeploy(id: number) {
    const m = this.marketRow(id);
    if (this.currentPool(id)) throw conflict('market already deployed');
    const plan = await this.engine.buildDeploy(cfgOf(m), DEPLOY_SATS);
    return this.enqueue(id, plan);
  }
  async enqueueBuy(id: number, sideStr: string, shares: number) {
    const side = asSide(sideStr);
    const n = intShares(shares);
    const { m, pool } = this.tradablePool(id);
    return this.enqueue(id, await built(() => this.engine.buildBuy(cfgOf(m), poolRef(pool), side, n)));
  }
  async enqueueSell(id: number, sideStr: string, shares: number) {
    const side = asSide(sideStr);
    const n = intShares(shares);
    const { m, pool } = this.tradablePool(id);
    return this.enqueue(id, await built(() => this.engine.buildSell(cfgOf(m), poolRef(pool), side, n)));
  }
  async enqueueResolve(id: number, outcomeStr: string) {
    const outcome = asSide(outcomeStr);
    const { m, pool } = this.tradablePool(id);
    return this.enqueue(id, await this.engine.buildResolve(cfgOf(m), poolRef(pool), outcome));
  }
  async enqueueRedeem(id: number, sideStr: string, shares: number) {
    const side = asSide(sideStr);
    const m = this.marketRow(id);
    const pool = this.currentPool(id);
    if (!pool) throw conflict('market not deployed');
    // CONC-005: hand the engine the PERSISTED token so a restarted daemon can still redeem.
    const t = this.db
      .prepare('SELECT * FROM tokens WHERE market_id=? AND burned=0 ORDER BY id DESC LIMIT 1')
      .get(id) as TokenRow | undefined;
    const token = t && t.script && t.holder_pkh
      ? { txid: t.txid, vout: t.vout, satoshis: t.sats, script: t.script, holderPkh: t.holder_pkh, shares: t.shares, side: t.side }
      : undefined;
    // Lets the engine surface its EngineLimitation (→ 501) for the redeem path.
    return this.enqueue(id, await this.engine.buildRedeem(cfgOf(m), poolRef(pool), side, BigInt(shares), token));
  }

  // ── off-chain execution (CONC-001/002) — instant fills; settlement enqueues into the same sign-off queue ──
  /** Fill one order off-chain INSTANTLY over @pm/lmsr (no broadcast). Returns the signed receipt. */
  async submitOrder(id: number, input: { trader: string; side: string; action: string; units?: number; sig?: string; nonce?: number; sigScheme?: 'ecdsa' | 'brc100' }) {
    const exec = this.execOrThrow();
    const m = this.marketRow(id);
    const pool = this.currentPool(id);
    if (!pool) throw conflict('market not deployed — deploy the pool before off-chain trading');
    if (pool.resolved === 1) throw conflict('market is resolved — trading is closed');
    const side = asSide(input.side);
    const action = asAction(input.action);
    const trader = (input.trader ?? '').trim();
    if (!trader) throw badReq('trader public key is required');
    const units = input.units ?? 1;
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) throw badReq(`units must be an integer in 1..${MAX_UNITS}`);
    this.ensureExecOpen(m);
    try {
      const sr = await exec.submit({
        marketId: id, trader, side, action, units: BigInt(units),
        ...(input.sig !== undefined ? { sig: input.sig } : {}),
        ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
        ...(input.sigScheme !== undefined ? { sigScheme: input.sigScheme } : {}),
      });
      return { market_id: id, receipt: sr.receipt, sig: sr.sig, signer_pubkey: sr.signerPubkey };
    } catch (e) {
      throw badReq(e instanceof Error ? e.message : String(e));
    }
  }

  listReceipts(id: number, trader?: string) {
    this.execOrThrow();
    this.marketRow(id);
    const rows = (trader
      ? this.db.prepare('SELECT * FROM exec_orders WHERE market_id=? AND trader_pubkey=? ORDER BY seq').all(id, trader)
      : this.db.prepare('SELECT * FROM exec_orders WHERE market_id=? ORDER BY seq').all(id)) as ExecOrderRow[];
    return { market_id: id, count: rows.length, receipts: rows.map(execOrderView) };
  }

  execPositions(id: number, trader?: string) {
    const exec = this.execOrThrow();
    this.marketRow(id);
    return { market_id: id, positions: exec.positionsOf(id, trader) };
  }

  /** Build a settlement of all unsettled off-chain fills and PARK it in the sign-off queue (human authorizes). */
  async enqueueSettle(id: number) {
    const exec = this.execOrThrow();
    const { m, pool } = this.tradablePool(id);
    this.ensureExecOpen(m);
    const batch = exec.pendingBatch(id);
    if (batch.orderIds.length === 0) throw badReq('no unsettled off-chain fills to settle');
    if (!this.engine.buildSettleBatch) {
      throw new EngineLimitation('settle', 'this engine has no batch-settlement path — run PM_ENGINE=scrypt');
    }

    // CONC-003a: commit to the exact ordered receipts this batch clears (the settle tx pins this digest on-chain).
    const rows = this.receiptsFor(id, batch.orderIds);
    const batchDigest = computeBatchDigest(rows.map(receiptFromRow));

    const sb: SettleBatch = {
      netYesUnits: batch.netYesUnits, netNoUnits: batch.netNoUnits, netCollateralSats: batch.netCollateralSats,
      orderIds: batch.orderIds,
      fills: batch.fills.map((f) => ({ trader: f.trader, side: f.side, action: f.action, shares: f.shares, costSats: f.costSats })),
      batchDigest,
    };
    const buildSettle = this.engine.buildSettleBatch.bind(this.engine);
    const plan = await built(() => buildSettle(cfgOf(m), poolRef(pool), sb));

    // Sequencer attestation binding this batch to this settlement (from→to version + resulting state).
    const fromVersion = pool.version;
    const toVersion = fromVersion + 1;
    const newStateHash = stateCommitment(
      BigInt(plan.effects.pool.qYes), BigInt(plan.effects.pool.qNo),
      BigInt(plan.effects.pool.eYes), BigInt(plan.effects.pool.eNo)
    );
    const att = exec.attestSettlement({
      marketId: id, fromVersion, toVersion, batchDigest,
      netYesUnits: batch.netYesUnits.toString(), netNoUnits: batch.netNoUnits.toString(),
      netCollateralSats: batch.netCollateralSats, newStateHash,
    });
    if (plan.effects.settle) {
      plan.effects.settle.batchDigest = batchDigest;
      plan.effects.settle.attestationSig = att.sig;
      plan.effects.settle.attestationPubkey = att.pubkey;
      // CONC-003b: also record the on-chain-verifiable Rabin attestation (makes equivocation slashable).
      if (this.engine.rabinAttest) {
        const r = this.engine.rabinAttest(id, toVersion, batchDigest);
        plan.effects.settle.rabinKey = r.key;
        plan.effects.settle.rabinSig = r.sig;
        plan.effects.settle.seqRabinPubkey = r.pubkey;
      }
    }
    return this.enqueue(id, plan);
  }

  /**
   * PAYOUT-001 — pay every winner of a resolved market on-chain, from the audited receipts. This is the bridge
   * that lets a trader actually collect: settled positions are signed receipts, not tokens, so `redeem` cannot
   * pay them. The contract enforces resolution + solvency + the collateral decrement.
   */
  async enqueuePayout(id: number) {
    this.execOrThrow();
    const m = this.marketRow(id);
    const pool = this.currentPool(id);
    if (!pool) throw conflict('market not deployed');
    if (pool.resolved !== 1) throw conflict('market not resolved — nothing to pay out yet');
    if (!m.resolution) throw conflict('market has no recorded resolution');
    if (!this.engine.buildPayout) {
      throw new EngineLimitation('payout', 'this engine has no payout path — run PM_ENGINE=scrypt');
    }
    const cfg = cfgOf(m);
    const winners = winningPayouts(this.db, id, m.resolution, cfg.payoutUnit);
    if (winners.length === 0) throw badReq('no winning positions to pay out');
    const digest = computePayoutDigest(winners);
    const buildPayout = this.engine.buildPayout.bind(this.engine);
    return this.enqueue(id, await built(() => buildPayout(cfg, poolRef(pool), winners, digest)));
  }

  /** Who is owed what, before paying (read-only view for a client/UI). */
  payoutPreview(id: number) {
    this.execOrThrow();
    const m = this.marketRow(id);
    if (!m.resolution) return { market_id: id, resolved: false, winners: [], total_sats: 0 };
    const winners = winningPayouts(this.db, id, m.resolution, cfgOf(m).payoutUnit);
    return {
      market_id: id, resolved: true, resolution: m.resolution,
      winners, total_sats: payoutTotal(winners), digest: computePayoutDigest(winners),
    };
  }

  /** Audit every settled batch of a market against its signed receipts + on-chain lineage (CONC-003a). */
  auditMarket(id: number) {
    this.execOrThrow();
    this.marketRow(id);
    const batches = this.db.prepare('SELECT id FROM exec_batches WHERE market_id=? ORDER BY id DESC').all(id) as { id: number }[];
    const reports = batches.map((b) => auditSettlement(this.db, id, b.id));
    return { market_id: id, batches: reports.length, ok: reports.every((r) => r.ok), reports };
  }

  private receiptsFor(marketId: number, orderIds: number[]) {
    if (orderIds.length === 0) return [];
    const placeholders = orderIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM exec_orders WHERE market_id=? AND id IN (${placeholders}) ORDER BY seq`)
      .all(marketId, ...orderIds) as ExecOrderRow[];
  }

  // ── sign-off queue ──────────────────────────────────────────────────────────────────────────────────
  listBroadcasts(status?: string) {
    const rows = (status
      ? this.db.prepare('SELECT * FROM broadcasts WHERE status = ? ORDER BY id DESC').all(status)
      : this.db.prepare('SELECT * FROM broadcasts ORDER BY id DESC').all()) as BroadcastRow[];
    return rows.map(broadcastView);
  }
  getBroadcast(bid: number) {
    return broadcastView(this.broadcastRow(bid));
  }

  /** THE HUMAN GATE. Rebuild+sign+broadcast via the engine (only WIF use), then apply effects atomically. */
  async authorize(bid: number) {
    const row = this.broadcastRow(bid);
    if (row.status !== 'pending') throw conflict(`broadcast ${bid} is '${row.status}', not pending`);
    const plan = JSON.parse(row.plan) as TxPlan;

    let result: BroadcastResult;
    try {
      result = await this.engine.authorizeAndBroadcast(plan);
    } catch (e) {
      this.db.prepare("UPDATE broadcasts SET status='failed', error=?, decided_at=datetime('now') WHERE id=?")
        .run(String(e instanceof Error ? e.message : e), bid);
      throw new ServiceError(502, `broadcast failed: ${e instanceof Error ? e.message : e}`, 'broadcast_failed');
    }

    const applied = this.db.transaction(() => this.applyEffects(row, plan, result));
    return applied();
  }

  reject(bid: number) {
    const row = this.broadcastRow(bid);
    if (row.status !== 'pending') throw conflict(`broadcast ${bid} is '${row.status}', not pending`);
    this.db.prepare("UPDATE broadcasts SET status='rejected', decided_at=datetime('now') WHERE id=?").run(bid);
    return { id: bid, status: 'rejected' as const };
  }

  // ── wallet (read-only) ──────────────────────────────────────────────────────────────────────────────
  async walletBalance() {
    const address = await this.engine.fundingAddress();
    const utxos = await this.engine.getUtxos(address);
    return { address, balance_sats: utxos.reduce((s, u) => s + u.satoshis, 0), utxos: utxos.length };
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────
  private applyEffects(row: BroadcastRow, plan: TxPlan, result: BroadcastResult) {
    const marketId = row.market_id!;
    const eff = plan.effects;
    let fromVersion = -1;
    if (eff.spendsPrevPool) {
      const prev = this.currentPool(marketId);
      if (!prev) throw new ServiceError(500, 'pool vanished before effects applied');
      fromVersion = prev.version;
      this.db.prepare('UPDATE pool_utxos SET spent=1 WHERE id=?').run(prev.id);
    }
    const toVersion = fromVersion + 1;
    this.db.prepare(
      `INSERT INTO pool_utxos(market_id, version, txid, vout, sats, q_yes, q_no, e_yes, e_no, collateral, resolved, winner, locking_script, spent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(marketId, toVersion, result.txid, eff.pool.vout, eff.pool.satoshis, eff.pool.qYes, eff.pool.qNo, eff.pool.eYes, eff.pool.eNo, eff.pool.collateral, eff.pool.resolved, eff.pool.winner, result.poolLockingScript);

    if (eff.trade) {
      this.db.prepare(
        `INSERT INTO trades(market_id, from_version, to_version, side, action, shares, cost_sats, txid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(marketId, fromVersion, toVersion, eff.trade.side, eff.trade.action, eff.trade.shares, eff.trade.costSats, result.txid);
    }
    if (eff.token) {
      // CONC-005: persist the minted token (or burn it on redeem) so a restarted daemon can still redeem.
      if (eff.token.burned) {
        this.db.prepare('UPDATE tokens SET burned=1 WHERE market_id=? AND burned=0').run(marketId);
      } else {
        this.db.prepare(
          `INSERT INTO tokens(market_id, side, shares, txid, vout, script, holder_pkh, sats, burned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(marketId, eff.token.side, eff.token.shares, result.txid, eff.token.vout, eff.token.script, eff.token.holderPkh, eff.token.satoshis);
      }
    }
    if (eff.payouts) {
      // PAYOUT-001: record who was actually paid on-chain (the audit trail for the payout tx).
      const ins = this.db.prepare(
        `INSERT INTO payouts(market_id, trader_pubkey, pkh, shares, sats, payout_digest, txid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of eff.payouts.winners) ins.run(marketId, w.trader, w.pkh, w.shares, w.sats, eff.payouts.digest, result.txid);
    }
    if (eff.settle) {
      // One settlement row for the whole batch, plus a trade row per fill, plus stamp the settled orders.
      const b = this.db.prepare(
        `INSERT INTO exec_batches(market_id, from_version, to_version, order_count, net_yes_units, net_no_units, net_collateral_sats, txid, status, batch_digest, attestation_sig, attestation_pubkey, rabin_key, rabin_sig, seq_rabin_pubkey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?, ?)`,
      ).run(marketId, fromVersion, toVersion, eff.settle.orderIds.length, eff.settle.netYesUnits, eff.settle.netNoUnits, eff.settle.netCollateralSats, result.txid, eff.settle.batchDigest ?? null, eff.settle.attestationSig ?? null, eff.settle.attestationPubkey ?? null, eff.settle.rabinKey ?? null, eff.settle.rabinSig ?? null, eff.settle.seqRabinPubkey ?? null);
      const batchId = Number(b.lastInsertRowid);
      const stamp = this.db.prepare('UPDATE exec_orders SET batch_id=? WHERE id=? AND batch_id IS NULL');
      for (const oid of eff.settle.orderIds) stamp.run(batchId, oid);
      const insTrade = this.db.prepare(
        `INSERT INTO trades(market_id, from_version, to_version, side, action, shares, cost_sats, txid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of eff.settle.trades) insTrade.run(marketId, fromVersion, toVersion, t.side, t.action, t.shares, t.costSats, result.txid);
      // CONC-006: the chain is authoritative at settlement boundaries — adopt the settled exponentials so the
      // off-chain engine can't drift from the pool it settles into.
      this.exec?.resyncState(marketId, {
        eYes: BigInt(eff.pool.eYes), eNo: BigInt(eff.pool.eNo),
        qYes: BigInt(eff.pool.qYes), qNo: BigInt(eff.pool.qNo),
      });
    }
    if (eff.marketState) {
      if (eff.resolution) {
        this.db.prepare("UPDATE markets SET state=?, resolution=?, resolved_at=datetime('now') WHERE id=?").run(eff.marketState, eff.resolution, marketId);
      } else {
        this.db.prepare('UPDATE markets SET state=? WHERE id=?').run(eff.marketState, marketId);
      }
    }
    this.db.prepare("UPDATE broadcasts SET status='broadcast', txid=?, decided_at=datetime('now') WHERE id=?").run(result.txid, row.id);
    // size/fee are what this actually cost on chain — the number that matters on mainnet, and the one that
    // decides whether the next tx still fits the ~101 KB unconfirmed-ancestor budget.
    return {
      id: row.id, status: 'broadcast' as const, txid: result.txid, market_id: marketId, pool_version: toVersion,
      size_bytes: result.sizeBytes, fee_sats: result.feeSats,
    };
  }

  private enqueue(marketId: number, plan: TxPlan) {
    const pending = this.db.prepare("SELECT COUNT(*) c FROM broadcasts WHERE market_id=? AND status='pending'").get(marketId) as { c: number };
    if (pending.c > 0) throw conflict('a pending broadcast already exists for this market — authorize or reject it first');
    const info = this.db.prepare(
      'INSERT INTO broadcasts(market_id, kind, summary, spend_sats, plan) VALUES (?, ?, ?, ?, ?)',
    ).run(marketId, plan.kind, plan.summary, plan.spendSats, JSON.stringify(plan));
    return { broadcast_id: Number(info.lastInsertRowid), status: 'pending' as const, kind: plan.kind, summary: plan.summary, spend_sats: plan.spendSats };
  }

  private tradablePool(id: number): { m: MarketRow; pool: PoolUtxoRow } {
    const m = this.marketRow(id);
    const pool = this.currentPool(id);
    if (!pool) throw conflict('market not deployed — deploy it first');
    if (pool.resolved === 1) throw conflict('market is resolved — trading is closed');
    return { m, pool };
  }

  private currentPool(marketId: number): PoolUtxoRow | undefined {
    return this.db.prepare('SELECT * FROM pool_utxos WHERE market_id=? AND spent=0 ORDER BY version DESC LIMIT 1').get(marketId) as PoolUtxoRow | undefined;
  }
  private marketRow(id: number): MarketRow {
    const m = this.db.prepare('SELECT * FROM markets WHERE id=?').get(id) as MarketRow | undefined;
    if (!m) throw notFound(`market ${id} not found`);
    return m;
  }
  private broadcastRow(bid: number): BroadcastRow {
    const r = this.db.prepare('SELECT * FROM broadcasts WHERE id=?').get(bid) as BroadcastRow | undefined;
    if (!r) throw notFound(`broadcast ${bid} not found`);
    return r;
  }
  private keyRefId(label: string, role: string, pubkey: string, network: string, note: string): number {
    this.db.prepare('INSERT OR IGNORE INTO key_refs(label, role, pubkey, network, note) VALUES (?, ?, ?, ?, ?)').run(label, role, pubkey, network, note);
    return (this.db.prepare('SELECT id FROM key_refs WHERE label=?').get(label) as { id: number }).id;
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────
const cfgOf = (m: MarketRow): MarketConfig => {
  const bUnits = BigInt(m.b) / BigInt(m.scale);
  const payoutUnit = BigInt(m.payout_unit);
  const p: MarketParams = { b: bUnits * WAD, payoutUnit, unit: WAD };
  return { marketId: m.id, bUnits, payoutUnit, mult: unitMultiplier(p), invMult: unitInverseMultiplier(p) };
};
const paramsOf = (cfg: MarketConfig): MarketParams => ({ b: cfg.bUnits * WAD, payoutUnit: cfg.payoutUnit, unit: WAD });
const poolStateToMarketState = (r: PoolUtxoRow): MarketState => ({ eYes: BigInt(r.e_yes), eNo: BigInt(r.e_no), qYes: BigInt(r.q_yes), qNo: BigInt(r.q_no) });
const poolFullState = (r: PoolUtxoRow): PoolState => ({ eYes: BigInt(r.e_yes), eNo: BigInt(r.e_no), qYes: BigInt(r.q_yes), qNo: BigInt(r.q_no), collateral: BigInt(r.collateral), resolved: BigInt(r.resolved), winner: BigInt(r.winner) });
const poolRef = (r: PoolUtxoRow): PoolRef => ({ txid: r.txid, vout: r.vout, satoshis: r.sats, lockingScript: r.locking_script ?? '', state: poolFullState(r) });
const broadcastView = (r: BroadcastRow) => ({ id: r.id, market_id: r.market_id, kind: r.kind, summary: r.summary, spend_sats: r.spend_sats, status: r.status, txid: r.txid, error: r.error, created_at: r.created_at, decided_at: r.decided_at });
const execOrderView = (r: ExecOrderRow) => ({
  seq: r.seq, trader: r.trader_pubkey, side: r.side, action: r.action, shares: r.shares,
  price_sats: r.price_sats, cost_sats: r.cost_sats, state_hash: r.state_hash,
  sig: r.sig, signer_pubkey: r.signer_pubkey, settled: r.batch_id !== null, batch_id: r.batch_id,
  created_at: r.created_at,
});

export { EngineLimitation };
