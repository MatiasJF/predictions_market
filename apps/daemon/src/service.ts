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
import { computeBatchDigest, receiptFromRow, stateCommitment, auditSettlement, winningPayouts, computePayoutDigest, payoutTotal, pkhOf, type ExecutionEngine, type PayoutDestination } from '@pm/execution';
import { deriveDestination, deriveOwnDestination, scopedNonces, verifyPayment, assertIdentityKey, outputPayingPkh, buildProceedsPayment, TransientPaymentError, type BeefSource, type ChainCheck, type DerivedDestination, type StakeUtxo } from '@pm/wallet';
import type { PrivateKey } from '@bsv/sdk';
import type { PaymentIntentRow, SellProceedRow } from '@pm/persistence';

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
    private readonly exec?: ExecutionEngine,
    /**
     * FUND-001. The key trader stakes are paid TO — BRC-29 destinations are derived from it, and it is the only
     * thing that can later spend them. Supplied separately from the covenant funding key so stakes and fee
     * money are not commingled, and so market solvency is measurable.
     */
    private readonly paymentKey?: PrivateKey,
    /** Confirms a trader's payment reached the network. Offline for `local`, WhatsOnChain for mainnet. */
    private readonly chainCheck?: ChainCheck,
    /** Proof a winner's wallet will accept for the transaction that paid them. Absent offline. */
    private readonly beefSource?: BeefSource
  ) {}

  /** How long a quoted price is honoured. Short: the LMSR price moves with every other fill. */
  private static readonly INTENT_TTL_MS = 120_000;

  private payKey(): PrivateKey {
    if (!this.paymentKey) {
      throw new ServiceError(501, 'this daemon has no payment key — trader funding is unavailable', 'no_payment_key');
    }
    return this.paymentKey;
  }

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
    const settled: MarketState = pool ? poolStateToMarketState(pool) : initState(p);

    /**
     * Price from the EXECUTION engine's live state, not the pool's.
     *
     * The pool only advances when a batch settles, so pricing the display from it means the headline price does
     * not move when someone trades — it jumps at settlement instead. That made the market look like it had a
     * fixed price no matter what `b` was set to, which is exactly how CURVE-001 was first mis-diagnosed as "the
     * bonding curve is not working".
     *
     * This is the same defect ADR-040 already fixed for payment intents. It was fixed there and not here,
     * because the quote path and the display path each computed a price of their own.
     */
    let state = settled;
    if (this.exec) {
      this.ensureExecOpen(m);
      state = this.exec.stateOf(id);
    }
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
      /** What you would trade at right now — moves with every fill. */
      prices: { yes_sats: Number(priceYesSats(state, p)), no_sats: Number(priceNoSats(state, p)) },
      /**
       * What the chain last agreed to. Between settlements these two diverge, and that gap IS the unsettled
       * batch — worth exposing rather than hiding, since it is the difference between what the market thinks
       * and what it has proved.
       */
      settled_prices: { yes_sats: Number(priceYesSats(settled, p)), no_sats: Number(priceNoSats(settled, p)) },
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
  // ── FUND-001: trader funding ────────────────────────────────────────────────────────────────────────

  /**
   * Quote a buy and issue a one-time destination to pay it to.
   *
   * The price is pinned here and honoured for a short window. It has to be short: the LMSR price moves with
   * every other fill, so a long-lived quote is a free option on the market's direction — the exact defect this
   * whole ticket exists to remove, reintroduced through the back door.
   */
  async createPaymentIntent(id: number, input: { trader: string; side: string; action: string; units?: number }) {
    this.execOrThrow();
    const m = this.marketRow(id);
    const pool = this.currentPool(id);
    if (!pool) throw conflict('market not deployed — deploy the pool before trading');
    if (pool.resolved === 1) throw conflict('market is resolved — trading is closed');

    const side = asSide(input.side);
    const action = asAction(input.action);
    if (action !== 'buy') throw badReq('only buys are paid for; a sell is owed proceeds, not charged');
    const trader = assertIdentityKey((input.trader ?? '').trim());
    const units = input.units ?? 1;
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) {
      throw badReq(`units must be an integer in 1..${MAX_UNITS}`);
    }

    // Price against the EXECUTION engine's live state, not the pool's.
    //
    // Fills are off-chain and settle only periodically, so the on-chain pool lags behind by a whole batch.
    // Quoting from the pool therefore under-prices every buy after the first one in a batch, and the fill then
    // fails as underfunded — caught by the settlement tests, which buy five times in a row.
    this.ensureExecOpen(m);
    const p = paramsOf(cfgOf(m));
    const live = this.execOrThrow().stateOf(id);
    const mult = unitMultiplier(p);
    let sBuy = live;
    let charge = 0n;
    for (let i = 0; i < units; i++) {
      sBuy = applyUnitBuy(sBuy, side, mult, p);
      charge += buyChargeApproxSats(sBuy, side, p.unit, p);
    }
    const quoted = Number(charge);

    // MAINNET-012 — REUSE before minting.
    //
    // A trader who pays and then hits any failure before the fill lands used to be asked to pay
    // again: the client requested a fresh quote, got a fresh one-time destination, and the wallet
    // sent a second payment while the first sat at an address that bought nothing. That is exactly
    // how 1,002 sat was lost on 2026-08-10 — and the advice given at the time, "press it again", is
    // what triggers it.
    //
    // So an identical request reuses the intent it already issued. If that destination is ALREADY
    // funded on chain, the answer carries the funding transaction and says `already_paid`, and the
    // client submits the order without paying a second time.
    const reusable = this.db.prepare(
      `SELECT * FROM payment_intents
        WHERE market_id=? AND trader_pubkey=? AND side=? AND action=? AND units=? AND status='pending'
        ORDER BY id DESC LIMIT 1`,
    ).get(id, trader, side, action, units) as PaymentIntentRow | undefined;

    if (reusable) {
      const funded = await this.chainCheck?.fundedAt?.(reusable.address, reusable.quoted_cost_sats);
      const fresh = Date.parse(reusable.expires_at) > Date.now();
      // An expired-but-PAID quote is still reused, and its clock restarted. The money is already at
      // that address; refusing it would strand the payment to protect a deadline that only exists to
      // stop a stale price being honoured. If the price has since moved past what was paid, the
      // execution engine's funding gate refuses the fill anyway — which is the correct place for
      // that judgement, and leaves the trader no worse off than a double charge would.
      if (fresh || funded) {
        let expiresAt = reusable.expires_at;
        if (funded && !fresh) {
          // Extend BOTH the row and the answer. Returning the stale timestamp handed the client a
          // quote that was already expired the moment it arrived — caught by the test below, which
          // is the only reason this is not a silent "your quote expired" loop on every retry.
          expiresAt = new Date(Date.now() + MarketService.INTENT_TTL_MS).toISOString();
          this.db.prepare('UPDATE payment_intents SET expires_at=? WHERE id=?').run(expiresAt, reusable.id);
        }
        return {
          intent_id: reusable.id,
          market_id: id, side, action, units,
          satoshis: reusable.quoted_cost_sats,
          locking_script: reusable.locking_script,
          address: reusable.address,
          expires_at: expiresAt,
          network: m.network,
          reused: true as const,
          /** The client MUST NOT pay again when this is set. */
          already_paid: Boolean(funded),
          payment_tx: funded?.rawTx,
        };
      }
    }

    // MAINNET-011: the destination must be one WE can spend — the trader is paying INTO it.
    // This used `deriveDestination`, which derives the COUNTERPARTY's key: correct for paying a
    // winner, exactly backwards for taking a stake. Every stake accepted before this fix went to an
    // address only the paying trader could unlock; the gate verified each payment correctly and the
    // operator received none of it. `derivePaymentKey` — which `potStakes()` already used — inverts
    // THIS derivation, which is why the first sell-proceeds payment was rejected as unsigned.
    const dest = deriveOwnDestination(this.payKey(), trader);
    const expiresAt = new Date(Date.now() + MarketService.INTENT_TTL_MS).toISOString();

    const info = this.db.prepare(
      `INSERT INTO payment_intents
       (market_id, trader_pubkey, side, action, units, quoted_cost_sats,
        derivation_prefix, derivation_suffix, locking_script, address, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, trader, side, action, units, quoted,
      dest.remittance.derivationPrefix, dest.remittance.derivationSuffix,
      dest.lockingScript, dest.address, expiresAt,
    );

    return {
      intent_id: Number(info.lastInsertRowid),
      market_id: id, side, action, units,
      /** Pay AT LEAST this. The true cost is recomputed at fill time; the surplus is yours back. */
      satoshis: quoted,
      locking_script: dest.lockingScript,
      address: dest.address,
      expires_at: expiresAt,
      network: m.network,
      reused: false as const,
      already_paid: false,
      payment_tx: undefined as string | undefined,
    };
  }

  private intentRow(intentId: number): PaymentIntentRow {
    const row = this.db.prepare('SELECT * FROM payment_intents WHERE id=?').get(intentId) as PaymentIntentRow | undefined;
    if (!row) throw notFound(`payment intent ${intentId} not found`);
    return row;
  }

  /**
   * Turn a submitted payment into funding proof, or refuse.
   *
   * Everything here is a way for the free option to come back, so each is checked explicitly rather than
   * assumed: an intent belonging to someone else, an expired quote, an intent already spent on another fill, a
   * transaction that pays a different script, one that pays too little, and — the subtle one — a perfectly
   * valid transaction that was never broadcast.
   */
  private async acceptPayment(
    intent: PaymentIntentRow,
    order: { trader: string; side: Side; action: 'buy' | 'sell'; units: number },
    rawTxHex: string,
  ): Promise<{ intentId: number; paidSats: number; txid: string }> {
    if (intent.status !== 'pending') {
      throw conflict(`payment intent ${intent.id} is already '${intent.status}'`);
    }
    if (intent.trader_pubkey !== order.trader) throw badReq('payment intent belongs to a different trader');
    if (intent.side !== order.side || intent.action !== order.action || intent.units !== order.units) {
      throw badReq('order does not match the quoted intent (side/action/units)');
    }
    if (Date.parse(intent.expires_at) < Date.now()) {
      this.db.prepare("UPDATE payment_intents SET status='expired', decided_at=datetime('now') WHERE id=?").run(intent.id);
      throw conflict('quote expired — request a new one; the price moves with every fill');
    }

    let paid: { txid: string; outputIndex: number; satoshis: number };
    try {
      paid = await verifyPayment(rawTxHex, intent.locking_script, intent.quoted_cost_sats, this.chainCheck ?? { exists: async () => true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A payment that is merely not visible YET must not burn the intent. Rejecting on a propagation race
      // permanently consumes a quote the trader has already paid for — which is exactly what happened on
      // mainnet (2026-08-10, `16bbde85…`, 1,002 sat): the money was on the network moments later, and the only
      // record of what it bought had already been marked dead. Leave it pending so a retry can still use it.
      if (e instanceof TransientPaymentError) {
        this.db.prepare('UPDATE payment_intents SET error=? WHERE id=?').run(msg, intent.id);
        throw new ServiceError(503, `${msg} — press again in a moment; your quote is still valid`, 'payment_pending');
      }
      this.db.prepare("UPDATE payment_intents SET status='rejected', error=?, decided_at=datetime('now') WHERE id=?")
        .run(msg, intent.id);
      throw badReq(msg);
    }

    // The unique index on (txid, output_index) is the real guard against one payment funding two fills; this
    // update is where it fires, before any fill exists.
    try {
      this.db.prepare("UPDATE payment_intents SET status='paid', paid_sats=?, txid=?, output_index=?, decided_at=datetime('now') WHERE id=?")
        .run(paid.satoshis, paid.txid, paid.outputIndex, intent.id);
    } catch {
      throw conflict('that payment output has already funded another order');
    }
    return { intentId: intent.id, paidSats: paid.satoshis, txid: paid.txid };
  }

  async submitOrder(id: number, input: { trader: string; side: string; action: string; units?: number; sig?: string; nonce?: number; sigScheme?: 'ecdsa' | 'brc100';
    /** FUND-001: the intent this order pays, and the trader's payment transaction (raw hex). */
    intentId?: number; paymentTx?: string }) {
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

    // FUND-001 — collect the money BEFORE the fill exists. A buy without an accepted payment must not reach the
    // execution engine at all; the engine has its own gate as a backstop, but the authority is here, where the
    // payment can actually be verified against the chain.
    let funding: { intentId: number; paidSats: number } | undefined;
    if (action === 'buy') {
      if (input.intentId === undefined || !input.paymentTx) {
        throw badReq('a buy must reference a payment intent and include the payment transaction');
      }
      const accepted = await this.acceptPayment(this.intentRow(input.intentId), { trader, side, action, units }, input.paymentTx);
      funding = { intentId: accepted.intentId, paidSats: accepted.paidSats };
    }

    try {
      const sr = await exec.submit({
        marketId: id, trader, side, action, units: BigInt(units),
        ...(input.sig !== undefined ? { sig: input.sig } : {}),
        ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
        ...(input.sigScheme !== undefined ? { sigScheme: input.sigScheme } : {}),
        ...(funding !== undefined ? { funding } : {}),
      });
      // FUND-001 step 7b — a sell is the market OWING money, so book the debt the moment the fill exists.
      // Recording it at fill time rather than at payment time is the point: the obligation is created by the
      // trade, and until this existed a sell's proceeds were computed, shown to the trader, and never owed to
      // anyone by anything. Mainnet market #7 left 998 sat in exactly that state.
      if (action === 'sell') {
        this.db.prepare(
          `INSERT OR IGNORE INTO sell_proceeds(market_id, order_seq, trader_pubkey, sats) VALUES (?,?,?,?)`,
        ).run(id, sr.receipt.seq, trader, Number(sr.receipt.costSats));
      }
      return { market_id: id, receipt: sr.receipt, sig: sr.sig, signer_pubkey: sr.signerPubkey };
    } catch (e) {
      // The payment was accepted but the fill failed (bad signature, oversell, price moved past what was paid).
      // Mark the intent so the money is visibly owed back rather than quietly kept — refunding it is the
      // operator's job and is tracked by `refund_txid`.
      if (funding) {
        this.db.prepare("UPDATE payment_intents SET status='rejected', error=?, decided_at=datetime('now') WHERE id=?")
          .run(`fill failed after payment: ${e instanceof Error ? e.message : String(e)}`, funding.intentId);
      }
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
    // Paying twice is REAL money twice. `winningPayouts` derives from the receipt ledger, which paying does not
    // change — so without this guard a second call happily pays every winner again, chaining off the pool output
    // the first payout produced. Observed on mainnet 2026-08-06: 6dd31acc… then 9a1879b2…, 3,000 sat paid twice.
    // Checked BEFORE engine capability: "already paid" is the stronger fact, and cheaper to establish.
    const paid = this.paidRows(id);
    const first = paid[0];
    if (first) {
      throw conflict(
        `winners of market ${id} were already paid ${paid.reduce((s, p) => s + p.sats, 0)} sat in tx ${first.txid}`,
      );
    }
    if (!this.engine.buildPayout) {
      throw new EngineLimitation('payout', 'this engine has no payout path — run PM_ENGINE=scrypt');
    }
    const cfg = cfgOf(m);
    const winners = winningPayouts(this.db, id, m.resolution, cfg.payoutUnit, this.payoutDestination(id));
    if (winners.length === 0) throw badReq('no winning positions to pay out');
    const digest = computePayoutDigest(winners);
    const buildPayout = this.engine.buildPayout.bind(this.engine);
    return this.enqueue(id, await built(() => buildPayout(cfg, poolRef(pool), winners, digest)));
  }

  /**
   * FUND-001, the return leg — where this market's winnings are paid.
   *
   * Winners used to be paid at `hash160(their identity key)`. The satoshis were genuinely theirs, but no wallet
   * watches that address, so the money was invisible and unspendable in practice: exactly the "I never see
   * anything in my wallet" complaint that started this ticket. Each winner now gets a one-time BRC-29
   * destination derived for them, and the remittance that lets their wallet internalize it as real balance.
   *
   * Scoped nonces (see `scopedNonces`) rather than random ones: the same market and trader must derive the same
   * address in the preview, in the built transaction, and after a restart — the payout digest commits to it.
   *
   * Falls back to the legacy derivation when this daemon has no payment key, so an unfunded local daemon still
   * runs the whole journey. That is a degraded mode, not a supported one.
   */
  private payoutDestination(marketId: number): PayoutDestination {
    if (!this.paymentKey) return pkhOf;
    return (trader) => this.payoutRemittance(marketId, trader).pkh;
  }

  private payoutRemittance(marketId: number, trader: string): DerivedDestination {
    return deriveDestination(this.payKey(), trader, scopedNonces(`pm-payout:${marketId}:${trader}`));
  }

  /**
   * What a winner needs to claim their payout into their own wallet: the transaction that paid them, which
   * output it is, and the derivation nonces. Served to the trader, not the operator — it is their money, and
   * without this they cannot derive the key that spends it.
   */
  /**
   * Has this transaction made it into a block, and which one?
   *
   * Cached hard, because `/payouts` sits behind a polling UI. Once mined the answer can never change, so it is
   * kept for ever; while unmined it is re-asked at most every 15 seconds. Without this a claim card open in a
   * browser would ask WhatsOnChain the same question every 2.5 seconds for as long as it stayed open.
   */
  private readonly minedCache = new Map<string, { height?: number; askedAt: number }>();
  private async minedHeight(txid: string): Promise<number | undefined> {
    const hit = this.minedCache.get(txid);
    if (hit?.height !== undefined) return hit.height;
    if (hit && Date.now() - hit.askedAt < 15_000) return undefined;
    const height = await this.chainCheck?.minedAt?.(txid);
    this.minedCache.set(txid, { ...(height !== undefined ? { height } : {}), askedAt: Date.now() });
    return height;
  }

  async payoutClaims(id: number, trader?: string) {
    this.marketRow(id);
    const rows = this.db
      .prepare(
        `SELECT trader_pubkey, pkh, shares, sats, txid, derivation_prefix, derivation_suffix, sender_identity_key
           FROM payouts WHERE market_id=?${trader ? ' AND trader_pubkey=?' : ''} ORDER BY id`,
      )
      .all(...(trader ? [id, trader] : [id])) as {
        trader_pubkey: string; pkh: string; shares: string; sats: number; txid: string;
        derivation_prefix: string | null; derivation_suffix: string | null; sender_identity_key: string | null;
      }[];
    const heights = new Map<string, number | undefined>();
    for (const txid of new Set(rows.map((r) => r.txid))) heights.set(txid, await this.minedHeight(txid));
    return {
      market_id: id,
      claims: rows.map((r) => ({
        trader: r.trader_pubkey,
        sats: r.sats,
        shares: r.shares,
        txid: r.txid,
        pkh: r.pkh,
        /** Claiming is impossible before this is a number — a wallet needs the merkle proof of a mined tx. */
        mined_at: heights.get(r.txid) ?? null,
        // Pre-FUND-001 payouts have no remittance: they were paid to a bare identity hash and there is nothing
        // to internalize. Say so plainly rather than emitting a half-filled object a wallet would choke on.
        remittance: r.derivation_prefix && r.derivation_suffix && r.sender_identity_key
          ? {
              derivationPrefix: r.derivation_prefix,
              derivationSuffix: r.derivation_suffix,
              senderIdentityKey: r.sender_identity_key,
            }
          : null,
      })),
    };
  }

  /**
   * Everything a winner's wallet needs to take custody of a payout — the `internalizeAction` call, prepared.
   *
   * Split from `payoutClaims` on purpose. That one is cheap and polled; this one fetches tens of kilobytes of
   * merkle-proved transaction from the network, so it happens when a winner actually asks to claim.
   *
   * The honest failure mode is `ready: false`. A payout is only claimable once it is **mined**, because the
   * proof a wallet accepts is the transaction's merkle path (see `BeefSource` for why its ancestry is not an
   * option here). Until then the money is theirs and nothing is lost — it just cannot be internalized yet.
   */
  async payoutClaim(id: number, traderInput: string) {
    const trader = assertIdentityKey((traderInput ?? '').trim());
    const { claims } = await this.payoutClaims(id, trader);
    const claim = claims[0];
    if (!claim) throw notFound(`no payout to ${trader.slice(0, 16)}… in market ${id}`);
    if (!claim.remittance) {
      throw conflict(
        'this payout predates one-time addresses — it was paid to your identity key\'s own hash and there is ' +
        'nothing for a wallet to internalize; that key has to be swept directly',
      );
    }
    if (!this.beefSource) {
      return { ready: false as const, reason: 'this daemon is offline — there is no chain to prove a payment against', ...claim };
    }

    const tx = await this.beefSource.atomicBeef(claim.txid);
    if (!tx) {
      return {
        ready: false as const,
        reason: 'the payout transaction is not mined yet — a wallet needs its merkle proof before it will accept the money',
        ...claim,
      };
    }
    // Read the output index off the transaction itself rather than trusting a stored one.
    const { outputIndex, satoshis } = outputPayingPkh(tx, claim.pkh);
    return {
      ready: true as const,
      ...claim,
      satoshis,
      /** Pass straight to `wallet.internalizeAction`. */
      internalize: {
        tx,
        outputIndex,
        protocol: 'wallet payment' as const,
        paymentRemittance: claim.remittance,
        description: `prediction market #${id} winnings`,
      },
    };
  }

  // ── the stake pot, and paying what the market owes (FUND-001 step 7b) ───────────────────────────────────

  /**
   * What this market owes sellers, and whether it has been paid.
   *
   * Worth showing even when it is all settled: an operator should be able to see the market's liabilities
   * without reading the database, because "we owe people money" is exactly the fact a system is most tempted to
   * keep quiet about.
   */
  sellDebts(id: number) {
    this.marketRow(id);
    const rows = this.db
      .prepare('SELECT * FROM sell_proceeds WHERE market_id=? ORDER BY order_seq')
      .all(id) as SellProceedRow[];
    const owed = rows.filter((r) => r.status === 'owed');
    return {
      market_id: id,
      owed: owed.map((r) => ({ order_seq: r.order_seq, trader: r.trader_pubkey, sats: r.sats })),
      owed_sats: owed.reduce((s, r) => s + r.sats, 0),
      paid: rows.filter((r) => r.status === 'paid').map((r) => ({
        order_seq: r.order_seq, trader: r.trader_pubkey, sats: r.sats, txid: r.txid,
      })),
    };
  }

  /**
   * The stake pot: every trader payment we accepted and have not yet spent.
   *
   * These are not wallet UTXOs — each one sits at a one-time BRC-29 address whose key exists only by
   * re-derivation. That is precisely why the pot is real: the satoshis one trader staked are the satoshis
   * another is paid with, and the balance below is a fact about the chain rather than an accounting entry.
   */
  private async potStakes(): Promise<StakeUtxo[]> {
    const rows = this.db
      .prepare("SELECT * FROM payment_intents WHERE status='paid' AND spent=0 AND txid IS NOT NULL ORDER BY id")
      .all() as PaymentIntentRow[];
    const stakes: StakeUtxo[] = [];
    for (const r of rows) {
      const raw = await this.chainCheck?.rawTx?.(r.txid!);
      // A stake we cannot fetch the funding transaction for cannot be signed against. Skip it rather than fail
      // the whole payment: the others are still spendable, and this one is not lost, only unavailable now.
      if (!raw) continue;
      stakes.push({
        txid: r.txid!, vout: r.output_index!, satoshis: r.paid_sats!,
        remittance: {
          derivationPrefix: r.derivation_prefix,
          derivationSuffix: r.derivation_suffix,
          senderIdentityKey: r.trader_pubkey, // the TRADER paid us, so they are the sender
        },
        sourceRawTx: raw,
      });
    }
    return stakes;
  }

  /** What the pot holds, for the operator console. */
  async potBalance() {
    const rows = this.db
      .prepare("SELECT COALESCE(SUM(paid_sats),0) AS sats, COUNT(*) AS n FROM payment_intents WHERE status='paid' AND spent=0")
      .get() as { sats: number; n: number };
    return { balance_sats: rows.sats, stakes: rows.n, address: this.paymentKey?.toPublicKey().toAddress() ?? null };
  }

  /**
   * Build the payment that clears this market's sell debts and PARK it in the sign-off queue.
   *
   * It goes through the same human gate as every covenant spend, because it is the same kind of event: real
   * satoshis leaving. The transaction is built and signed here but deliberately not broadcast — a signed
   * transaction nobody has sent is inert.
   */
  async enqueueProceeds(id: number) {
    this.marketRow(id);
    const { owed, owed_sats } = this.sellDebts(id);
    if (owed.length === 0) throw badReq('this market owes sellers nothing');

    const stakes = await this.potStakes();
    const payment = await buildProceedsPayment(
      this.payKey(),
      stakes,
      owed.map((o) => ({ trader: o.trader, satoshis: o.sats, scope: `pm-proceeds:${id}:${o.order_seq}` })),
    );

    const plan: TxPlan = {
      kind: 'proceeds',
      summary: `pay ${owed.length} seller(s) ${owed_sats} sat from the stake pot`,
      spendSats: owed_sats + payment.feeSats,
      build: { kind: 'proceeds', marketId: id, rawTx: payment.rawTx, orderSeqs: owed.map((o) => o.order_seq) },
      // The stakes this spends are recorded with the plan, so authorizing marks exactly those consumed — the
      // payment used every one of them as an input.
      effects: { proceeds: { payment, spent: stakes.map((s) => ({ txid: s.txid, vout: s.vout })) } },
    } as unknown as TxPlan;
    return this.enqueue(id, plan);
  }

  /**
   * Broadcast a proceeds payment and record it. Kept apart from the covenant path in `authorize` because it is
   * genuinely a different animal: an ordinary P2PKH spend the daemon built, not a contract call the engine
   * rebuilds and re-signs.
   */
  private async authorizeProceeds(row: BroadcastRow, plan: any) {
    const payment = plan.effects.proceeds.payment as Awaited<ReturnType<typeof buildProceedsPayment>>;
    const seqs = plan.build.orderSeqs as number[];
    const marketId = row.market_id!;

    const sent = await this.chainCheck?.publish?.(payment.rawTx);
    if (!sent) {
      this.db.prepare("UPDATE broadcasts SET status='failed', error=?, decided_at=datetime('now') WHERE id=?")
        .run('the network did not accept the proceeds payment', row.id);
      throw new ServiceError(502, 'broadcast failed: the network did not accept the proceeds payment', 'broadcast_failed');
    }

    return this.db.transaction(() => {
      const stamp = this.db.prepare(
        `UPDATE sell_proceeds SET status='paid', pkh=?, derivation_prefix=?, derivation_suffix=?,
           sender_identity_key=?, txid=?, output_index=?, paid_at=datetime('now')
         WHERE market_id=? AND order_seq=? AND status='owed'`,
      );
      payment.paid.forEach((p, i) => {
        const seq = seqs[i]!;
        const done = stamp.run(
          p.pkh, p.remittance.derivationPrefix, p.remittance.derivationSuffix, p.remittance.senderIdentityKey,
          payment.txid, p.outputIndex, marketId, seq,
        );
        // If a debt was already settled we have just sent money for it twice. Fail the transaction so the whole
        // thing rolls back and it is loud, rather than silently recording a second payment as if it were fine.
        if (done.changes !== 1) {
          throw new ServiceError(500, `sell ${seq} of market ${marketId} was not owed — refusing to record a double payment`);
        }
      });
      // Spending a stake consumes it; without this the next proceeds payment would try the same inputs again.
      const spend = this.db.prepare('UPDATE payment_intents SET spent=1 WHERE txid=? AND output_index=?');
      for (const s of plan.effects.proceeds.spent ?? []) spend.run(s.txid, s.vout);
      this.db.prepare(
        "UPDATE broadcasts SET status='broadcast', txid=?, size_bytes=?, fee_sats=?, decided_at=datetime('now') WHERE id=?",
      ).run(payment.txid, payment.sizeBytes, payment.feeSats, row.id);
      return {
        id: row.id, status: 'broadcast' as const, txid: payment.txid, market_id: marketId,
        // Paying sellers moves money without touching the covenant, so there is no new pool version. Reported
        // as null rather than omitted, so one broadcast-result shape covers every kind.
        pool_version: null as number | null,
        explorer: explorerTxUrl(payment.txid),
        size_bytes: payment.sizeBytes as number | undefined,
        fee_sats: payment.feeSats as number | undefined,
      };
    })();
  }

  /** Rows recording winners actually paid on-chain for a market (migration 011). */
  private paidRows(id: number) {
    return this.db
      .prepare('SELECT trader_pubkey, pkh, shares, sats, payout_digest, txid FROM payouts WHERE market_id=?')
      .all(id) as { trader_pubkey: string; pkh: string; shares: string; sats: number; payout_digest: string; txid: string }[];
  }

  /**
   * Who is owed what, before paying (read-only view for a client/UI).
   *
   * `winners` is what remains OUTSTANDING — anyone already paid on-chain is moved to `paid`. Reporting a settled
   * debt as still owed is what invites a second payout, so the two are kept apart here rather than in the client.
   */
  payoutPreview(id: number) {
    this.execOrThrow();
    const m = this.marketRow(id);
    if (!m.resolution) return { market_id: id, resolved: false, winners: [], paid: [], total_sats: 0 };
    const all = winningPayouts(this.db, id, m.resolution, cfgOf(m).payoutUnit, this.payoutDestination(id));
    const paid = this.paidRows(id);
    const paidBy = new Set(paid.map((p) => p.trader_pubkey));
    const winners = all.filter((w) => !paidBy.has(w.trader));
    return {
      market_id: id, resolved: true, resolution: m.resolution,
      winners, total_sats: payoutTotal(winners), digest: computePayoutDigest(all),
      paid: paid.map((p) => ({ trader: p.trader_pubkey, sats: p.sats, txid: p.txid })),
      paid_sats: paid.reduce((s, p) => s + p.sats, 0),
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

    // Paying sellers is an ordinary P2PKH spend the daemon built and signed, not a covenant call the engine
    // rebuilds — so it takes its own path rather than being forced through a shape that does not fit it.
    if (plan.kind === 'proceeds') return this.authorizeProceeds(row, plan);

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
      //
      // FUND-001 adds the remittance. It is re-derived here rather than threaded through the engine, which is
      // safe precisely because the nonces are scoped: the same market and trader always derive the same
      // destination, and the assert below refuses to write a row if that ever stops being true — a mismatch
      // would mean recording a claim for an address the money did not go to.
      const ins = this.db.prepare(
        `INSERT INTO payouts(market_id, trader_pubkey, pkh, shares, sats, payout_digest, txid,
                             derivation_prefix, derivation_suffix, sender_identity_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of eff.payouts.winners) {
        const dest = this.paymentKey ? this.payoutRemittance(marketId, w.trader) : undefined;
        if (dest && dest.pkh !== w.pkh) {
          throw new ServiceError(500, `payout destination for ${w.trader.slice(0, 16)}… does not re-derive`);
        }
        ins.run(
          marketId, w.trader, w.pkh, w.shares, w.sats, eff.payouts.digest, result.txid,
          dest?.remittance.derivationPrefix ?? null,
          dest?.remittance.derivationSuffix ?? null,
          dest?.remittance.senderIdentityKey ?? null,
        );
      }
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
    this.db
      .prepare("UPDATE broadcasts SET status='broadcast', txid=?, size_bytes=?, fee_sats=?, decided_at=datetime('now') WHERE id=?")
      .run(result.txid, result.sizeBytes ?? null, result.feeSats ?? null, row.id);

    // Print the FULL txid and an explorer URL. A truncated id in a UI cannot be pasted into a block explorer,
    // which is the one thing anyone wants to do after spending real money.
    const kb = result.sizeBytes ? `${(result.sizeBytes / 1024).toFixed(1)} KB` : '—';
    const fee = result.feeSats ? `${result.feeSats.toLocaleString()} sat` : '—';
    console.log(
      `\n  ✔ ${row.kind} broadcast — ${kb}, fee ${fee}\n` +
      `    txid ${result.txid}\n` +
      `    ${explorerTxUrl(result.txid)}\n`,
    );

    // size/fee are what this actually cost on chain — the number that matters on mainnet, and the one that
    // decides whether the next tx still fits the ~101 KB unconfirmed-ancestor budget.
    return {
      id: row.id, status: 'broadcast' as const, txid: result.txid, market_id: marketId,
      pool_version: toVersion as number | null,
      explorer: explorerTxUrl(result.txid),
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
/**
 * WhatsOnChain URL for a txid. Only mainnet transactions exist on an explorer — a `local` run builds and
 * Script-verifies the identical transaction but never broadcasts it, so linking one would send the user to a
 * 404 and quietly imply it went to chain.
 */
export const explorerTxUrl = (txid: string): string =>
  (process.env.PM_NETWORK ?? 'mainnet') === 'mainnet'
    ? `https://whatsonchain.com/tx/${txid}`
    : `(local — not broadcast; no explorer entry)`;

const broadcastView = (r: BroadcastRow) => ({ id: r.id, market_id: r.market_id, kind: r.kind, summary: r.summary, spend_sats: r.spend_sats, status: r.status, txid: r.txid, error: r.error, size_bytes: r.size_bytes, fee_sats: r.fee_sats, created_at: r.created_at, decided_at: r.decided_at });
const execOrderView = (r: ExecOrderRow) => ({
  seq: r.seq, trader: r.trader_pubkey, side: r.side, action: r.action, shares: r.shares,
  price_sats: r.price_sats, cost_sats: r.cost_sats, state_hash: r.state_hash,
  sig: r.sig, signer_pubkey: r.signer_pubkey, settled: r.batch_id !== null, batch_id: r.batch_id,
  created_at: r.created_at,
});

export { EngineLimitation };
