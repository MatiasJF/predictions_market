// Row shapes mirror packages/persistence/migrations/001_init.sql. Keep in sync (Golden Rule 1).
// LMSR-scaled columns are TEXT decimal strings (ADR-006); parse to BigInt at the boundary with the
// helpers below. Plain sat amounts are stored/read as JS numbers (they fit int64 and stay < 2^53 here).

export type Network = 'testnet' | 'mainnet';
export type KeyRole = 'platform' | 'oracle' | 'user';
export type Side = 'yes' | 'no';
export type TradeAction = 'buy' | 'sell';
export type BroadcastKind = 'deploy' | 'buy' | 'sell' | 'resolve' | 'redeem';
export type BroadcastStatus = 'pending' | 'broadcast' | 'rejected' | 'failed';
export type MarketState =
  | 'imported' | 'reviewed' | 'deployed' | 'trading' | 'closed'
  | 'awaiting_result' | 'resolved' | 'settled' | 'voided' | 'refunded';

export interface KeyRefRow {
  id: number;
  label: string;
  role: KeyRole;
  pubkey: string;
  network: Network;
  note: string | null;
  created_at: string;
}

export interface MarketRow {
  id: number;
  question: string;
  description: string | null;
  b: string;          // BigInt as decimal string
  scale: string;      // BigInt as decimal string
  payout_unit: number;
  fee_bps: number;
  oracle_key_id: number;
  platform_key_id: number;
  network: Network;
  state: MarketState;
  resolution: Side | null;
  close_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface PoolUtxoRow {
  id: number;
  market_id: number;
  version: number;
  txid: string;
  vout: number;
  sats: number;
  q_yes: string;      // BigInt as decimal string
  q_no: string;
  e_yes: string;
  e_no: string;
  spent: 0 | 1;
  created_at: string;
  // Added in 003_pool_state — the rest of the LMSRMarket mutable state + the continuation script:
  collateral: string;          // BigInt as decimal string
  resolved: 0 | 1;
  winner: 0 | 1;               // 0 = NO, 1 = YES
  locking_script: string | null;
}

export interface TradeRow {
  id: number;
  market_id: number;
  from_version: number;
  to_version: number;
  side: Side;
  action: TradeAction;
  shares: string;     // BigInt as decimal string
  cost_sats: number;
  fee_sats: number;
  buyer_key_id: number | null;
  txid: string | null;
  created_at: string;
}

export interface TokenRow {
  id: number;
  market_id: number;
  side: Side;
  shares: string;     // BigInt as decimal string
  txid: string;
  vout: number;
  owner_key_id: number | null;
  burned: 0 | 1;
  created_at: string;
}

export interface BroadcastRow {
  id: number;
  market_id: number | null;
  kind: BroadcastKind;
  summary: string;
  spend_sats: number;
  plan: string;       // JSON TxPlan (see @pm/engine) — contains NO key material
  status: BroadcastStatus;
  txid: string | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
}

/** One filled off-chain order + its signed receipt (004_execution / CONC-001). Public data only. */
export interface ExecOrderRow {
  id: number;
  market_id: number;
  seq: number;
  trader_pubkey: string;
  side: Side;
  action: TradeAction;
  shares: string;        // BigInt as decimal string (total shares filled)
  price_sats: number;
  cost_sats: number;
  q_yes: string;         // resulting state (BigInts as decimal strings)
  q_no: string;
  e_yes: string;
  e_no: string;
  state_hash: string;    // sha256 commitment (hex)
  sig: string;           // receipt signature (DER hex)
  signer_pubkey: string; // sequencer pubkey (DER hex)
  batch_id: number | null; // set at settlement (CONC-002); NULL = unsettled
  created_at: string;
  ts: number | null;     // receipt's signed timestamp (007); NULL for pre-007 rows
}

/** One on-chain batch settlement (005_settlement / CONC-002): N fills collapsed into one pool-version advance. */
export interface ExecBatchRow {
  id: number;
  market_id: number;
  from_version: number;
  to_version: number;
  order_count: number;
  net_yes_units: string;       // signed BigInt as decimal string
  net_no_units: string;
  net_collateral_sats: number; // signed
  txid: string | null;
  status: 'settled';
  created_at: string;
  // Added in 007_settlement_commitment (CONC-003a); NULL for pre-007 rows:
  batch_digest: string | null;       // hex sha256 commitment to the ordered receipts (also pinned on-chain)
  attestation_sig: string | null;    // sequencer signature over the settlement claim (DER hex)
  attestation_pubkey: string | null; // sequencer pubkey (DER hex)
}

/** BigInt <-> DB TEXT boundary helpers. */
export const toText = (v: bigint): string => v.toString();
export const fromText = (s: string): bigint => BigInt(s);
