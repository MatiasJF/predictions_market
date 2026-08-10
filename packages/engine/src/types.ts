// The swap seam. Everything toolchain-specific (compile, tx-building, broadcast) lives behind ChainEngine,
// so the daemon/service/DB/LMSR-math never import runar-* directly. RunarEngine implements it now; a
// ScryptEngine will implement the same interface in Phase 2 with zero API/service changes.
import type { Side } from '@pm/lmsr';

export type { Side };

/** A funding/pool UTXO. `script` is the hex locking script ('' when a provider omits it — see BUG-001). */
export interface Utxo {
  txid: string;
  outputIndex: number;
  satoshis: number;
  script: string;
}

/** Immutable per-market config (from the DB `markets` row). */
export interface MarketConfig {
  marketId: number;    // the DB market id (used by engines that key on-chain state per market)
  bUnits: bigint;      // liquidity parameter, in share-units
  payoutUnit: bigint;  // sats a winning share redeems for
  mult: bigint;        // exp(unit/b)·WAD — precomputed by the service (@pm/lmsr); RunarEngine recomputes its own
  invMult: bigint;     // exp(−unit/b)·WAD
}

/** The 7 mutable state fields of a live LMSRMarket pool (all BigInt). */
export interface PoolState {
  eYes: bigint;
  eNo: bigint;
  qYes: bigint;
  qNo: bigint;
  collateral: bigint;
  resolved: bigint;   // 0 | 1
  winner: bigint;     // 0 = NO, 1 = YES
}

/** A live pool UTXO the engine can spend: outpoint + locking script + current mutable state. */
export interface PoolRef {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
  state: PoolState;
}

export type BroadcastKind = 'deploy' | 'buy' | 'sell' | 'resolve' | 'redeem' | 'settle' | 'payout'
  /**
   * FUND-001 step 7b — paying sellers from the stake pot. Not a covenant spend: an ordinary P2PKH payment the
   * daemon builds and signs itself, which is why `authorize` routes it down its own path.
   */
  | 'proceeds';

/** One winner of a resolved market, derived from the audited receipts (PAYOUT-001). */
export interface WinnerPayoutRef {
  trader: string; // trader public key (DER hex)
  pkh: string;    // hash160 of that key — derived, no registration needed
  shares: string; // WAD-scaled winning shares
  sats: number;   // shares × payoutUnit
}

/**
 * A batch of off-chain fills (CONC-002) folded into the NET effect one settlement tx must apply. `netYesUnits`/
 * `netNoUnits` are SIGNED unit deltas (+ = net buys). The settlement advances the pool by these net units (the
 * multiplicative e-state is path-independent) and by the net cash; `fills`/`orderIds` let the service record the
 * trade rows and link the settled orders.
 */
export interface SettleBatch {
  netYesUnits: bigint;
  netNoUnits: bigint;
  netCollateralSats: number;
  orderIds: number[];
  fills: { trader: string; side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }[];
  /** CONC-003a: hex commitment to the ordered signed receipts; pinned on-chain as an OP_RETURN by settle. */
  batchDigest: string;
}

/** Result of a successful broadcast. `poolLockingScript` is the produced pool output's script (needed to spend it next). */
export interface BroadcastResult {
  txid: string;
  poolLockingScript: string;
  /**
   * What this transaction actually cost. The pool covenant carries the whole compiled contract in every spend,
   * so size — not economic value — dominates the fee, and it is the number that decides whether a sequence of
   * trades fits the ~101 KB unconfirmed-ancestor budget. Optional: engines that don't build real txs omit it.
   */
  sizeBytes?: number;
  feeSats?: number;
}

/**
 * DB effects to apply AFTER a successful broadcast (the service fills in the real txid). Public data only —
 * no key material. BigInt fields are decimal strings so the whole plan JSON-serializes into `broadcasts.plan`.
 */
export interface TxEffects {
  /** New pool UTXO produced by this tx (all kinds emit one) — the full mutable state the service persists. */
  pool: {
    vout: number;
    satoshis: number;
    eYes: string;
    eNo: string;
    qYes: string;
    qNo: string;
    collateral: string;
    resolved: 0 | 1;
    winner: 0 | 1;
    lockingScript: string;
  };
  /** Whether a previous pool version is consumed (true for everything except deploy). */
  spendsPrevPool: boolean;
  /** A trade row to record (buy/sell). */
  trade?: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number };
  /**
   * The position token this tx mints (buy) or burns (redeem) — persisted so the market survives a daemon
   * restart (CONC-005). The engine supplies vout/script/holder/shares/side; the service fills in the txid from
   * the broadcast result, exactly as it does for `pool`.
   */
  token?: { vout: number; satoshis: number; script: string; holderPkh: string; shares: string; side: Side; burned?: boolean };
  /** Batch settlement (CONC-002): N off-chain fills collapsed into this one pool-version advance. */
  settle?: {
    orderIds: number[];
    netYesUnits: string;
    netNoUnits: string;
    netCollateralSats: number;
    trades: { side: Side; action: 'buy' | 'sell'; shares: string; costSats: number }[];
    // CONC-003a commitment (batchDigest from the batch; attestation injected by the service after build):
    batchDigest?: string;
    attestationSig?: string;
    attestationPubkey?: string;
    // CONC-003b: the sequencer's Rabin attestation (on-chain-verifiable → slashable on equivocation):
    rabinKey?: string;
    rabinSig?: string;
    seqRabinPubkey?: string;
  };
  /** Winners paid on-chain by this tx (PAYOUT-001) — the receipt → payout bridge. */
  payouts?: { digest: string; winners: WinnerPayoutRef[] };
  /** Market lifecycle transition to write onto the `markets` row. */
  marketState?: 'deployed' | 'trading' | 'resolved';
  /** Resolution outcome (resolve only). */
  resolution?: Side;
}

/**
 * A prepared, NOT-yet-broadcast transaction. `build` is an engine-private descriptor sufficient to rebuild +
 * sign the exact tx at authorize time (no key material). The service stores the whole plan in `broadcasts.plan`
 * and never inspects `build`.
 */
export interface TxPlan {
  kind: BroadcastKind;
  summary: string;    // human-readable, shown in the sign-off queue
  spendSats: number;  // fee (+ any real sats moved) the spend will cost — a preview estimate
  build: unknown;     // engine-specific, JSON-serializable
  effects: TxEffects;
}

/**
 * Thrown by a build* method when the current engine cannot transact that operation (e.g. runar-sdk BUG-005
 * blocks token-minting buys and multi-input redeems). The service maps this to HTTP 501. `pointer` names the
 * blocker + the path that unblocks it (Phase 2 / sCrypt).
 */
export class EngineLimitation extends Error {
  constructor(
    public readonly kind: BroadcastKind,
    public readonly pointer: string,
  ) {
    super(`engine '${kind}' unsupported: ${pointer}`);
    this.name = 'EngineLimitation';
  }
}

/** The contract engine behind the API. Two implementations over time: RunarEngine (now), ScryptEngine (Phase 2). */
export interface ChainEngine {
  readonly name: string;

  /** Public funding address (derived from the WIF in-memory; the address is public, the key never leaves). */
  fundingAddress(): Promise<string>;
  /** Public funding key (compressed hex) — for the `markets.platform_key_id` provenance ref. */
  fundingPublicKey(): Promise<string>;
  /** Opaque public oracle identifier (Rúnar: the Rabin modulus hex) — for the `markets.oracle_key_id` ref. */
  oracleId(): string;
  /** Read UTXOs for an address (read-only chain query). */
  getUtxos(address: string): Promise<Utxo[]>;

  // ── build* : compute the LMSR update + a TxPlan. NO chain writes, NO key use. Throw EngineLimitation if unsupported.
  buildDeploy(cfg: MarketConfig, deploySats: number): Promise<TxPlan>;
  buildBuy(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan>;
  buildSell(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan>;
  buildResolve(cfg: MarketConfig, pool: PoolRef, outcome: Side): Promise<TxPlan>;
  /** `token` (optional) is the persisted token identity, so redeem survives a daemon restart (CONC-005). */
  buildRedeem(
    cfg: MarketConfig,
    pool: PoolRef,
    side: Side,
    shares: bigint,
    token?: { txid: string; vout: number; satoshis: number; script: string; holderPkh: string; shares: string; side: Side },
  ): Promise<TxPlan>;

  /** Batch settlement (CONC-002): advance the pool by a whole batch's net state in one tx. Optional — only
   *  engines with a `settle` contract path implement it (ScryptEngine, MockEngine). Throws/absent otherwise. */
  buildSettleBatch?(cfg: MarketConfig, pool: PoolRef, batch: SettleBatch): Promise<TxPlan>;

  /** PAYOUT-001: pay every winner of a resolved market in one tx. Optional — only engines with the `payout`
   *  contract path implement it. The contract enforces resolution, solvency and the collateral decrement. */
  buildPayout?(cfg: MarketConfig, pool: PoolRef, winners: WinnerPayoutRef[], digest: string): Promise<TxPlan>;

  /**
   * Can THIS build still spend that pool? A pool's locking script is the compiled contract, so a pool deployed
   * by an earlier build of `LMSRMarket` cannot be spent by a later one — the script no longer matches the
   * artifact's ASM template. That is not a corner case here: the contract's size has changed six times over the
   * project (45,675 → 21,447 → … → 36,762 B), and the DB outlives any single build. Without this the mismatch
   * only surfaces as an unreadable sCrypt error at authorize time, after a human has already approved a spend.
   * Optional; an engine that doesn't implement it is assumed to be able to spend anything it stored.
   */
  poolSpendable?(pool: PoolRef): boolean;

  /** CONC-003b: Rabin-sign the sequencer's settlement attestation (on-chain-verifiable by a Bond's slash).
   *  Optional — only engines with the Rabin machinery implement it. `sig` is a JSON-serialized RabinSig. */
  rabinAttest?(marketId: number, toVersion: number, digest: string): { key: string; sig: string; pubkey: string };

  /**
   * THE ONLY method that loads the funding key, signs, and broadcasts. Rebuilds the exact tx from `plan.build`,
   * signs the funding input(s), broadcasts to mainnet, returns txid + produced pool script. Called only by the
   * authorize path.
   */
  authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult>;
}
