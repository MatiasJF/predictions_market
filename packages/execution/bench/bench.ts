// Benchmark the REAL @pm/execution engine: how many concurrent bettors can we actually fill, and how many
// fills collapse into one on-chain settlement? No estimates — measured on the shipped code path.
import { PrivateKey } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD, unitMultiplier, applyUnitBuy, buyChargeApproxSats, initState, type MarketParams } from '@pm/lmsr';
import { ExecutionEngine, WifReceiptSigner, signOrder, makeTraderWallet } from '../src/index.js';

const P: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const WIF = PrivateKey.fromRandom().toWif();

function fresh(markets: number): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  const eng = new ExecutionEngine(db, new WifReceiptSigner(WIF));
  for (let m = 1; m <= markets; m++) eng.openMarket(m, P);
  return { db, eng };
}
const ms = (t: bigint) => Number(t) / 1e6;
// LIVE-001a: real trader wallets — orders are signed client-side and VERIFIED server-side on every fill.
const WALLETS = Array.from({ length: 200 }, () => makeTraderWallet());
const traders = (n: number) => WALLETS.slice(0, Math.max(1, Math.min(n, WALLETS.length))).map((w) => w.pubkey);
let nonceSeq = 0;
/** Pre-sign an order (client work) so the measured submit covers the SERVER cost incl. verification. */
function order(marketId: number, pubkey: string, side: 'yes' | 'no', action: 'buy' | 'sell', units: bigint, ts: number) {
  const w = WALLETS.find((x) => x.pubkey === pubkey)!;
  const nonce = ++nonceSeq;
  const f = { marketId, trader: pubkey, side, action, units, nonce };
  return { ...f, sig: signOrder(w.wif, f), ts };
}

// ── 1. component cost: where does a fill actually spend its time? ────────────────────────────────────
function components(n: number) {
  const signer = new WifReceiptSigner(WIF);
  const mult = unitMultiplier(P);

  let s = initState(P);
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { s = applyUnitBuy(s, 'yes', mult, P); buyChargeApproxSats(s, 'yes', P.unit, P); }
  const lmsr = ms(process.hrtime.bigint() - t0);

  t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) signer.sign(`payload-${i}`);
  const sign = ms(process.hrtime.bigint() - t0);

  const db = openDb(':memory:'); migrate(db);
  const ins = db.prepare(`INSERT INTO exec_orders
    (market_id, seq, trader_pubkey, side, action, shares, price_sats, cost_sats, q_yes, q_no, e_yes, e_no, state_hash, sig, signer_pubkey, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) ins.run(1, i + 1, 'aa', 'yes', 'buy', '1', 1, 1, '1', '1', '1', '1', 'h', 's', 'p', i);
  const persist = ms(process.hrtime.bigint() - t0);

  console.log(`\n=== 1. component cost per fill (n=${n}) ===`);
  const row = (k: string, total: number) => console.log(`  ${k.padEnd(22)} ${(total / n * 1000).toFixed(1).padStart(7)} µs/op   ${Math.round(n / (total / 1000)).toLocaleString().padStart(9)} ops/sec`);
  row('LMSR math', lmsr); row('receipt signing (ECDSA)', sign); row('SQLite insert', persist);
}

// ── 2. end-to-end: N bettors hitting ONE market simultaneously ──────────────────────────────────────
async function oneMarket(n: number) {
  const { eng } = fresh(1);
  const tr = traders(Math.min(n, 500));
  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: n }, (_, i) =>
    eng.submit(order(1, tr[i % tr.length]!, i % 3 === 0 ? 'no' : 'yes', 'buy', 1n, i))
  ));
  const el = ms(process.hrtime.bigint() - t0);
  console.log(`  ${String(n).padStart(5)} simultaneous  ${el.toFixed(0).padStart(6)} ms   ${Math.round(n / (el / 1000)).toLocaleString().padStart(7)} fills/sec   ${(el / n).toFixed(2)} ms latency/fill`);
  return Math.round(n / (el / 1000));
}

// ── 3. many markets in parallel (markets are independent → this is the scale-out axis) ───────────────
async function manyMarkets(markets: number, perMarket: number) {
  const { eng } = fresh(markets);
  const tr = traders(200);
  const jobs: Promise<unknown>[] = [];
  const t0 = process.hrtime.bigint();
  for (let m = 1; m <= markets; m++)
    for (let i = 0; i < perMarket; i++)
      jobs.push(eng.submit(order(m, tr[i % tr.length]!, i % 3 === 0 ? 'no' : 'yes', 'buy', 1n, i)));
  await Promise.all(jobs);
  const el = ms(process.hrtime.bigint() - t0);
  const total = markets * perMarket;
  console.log(`  ${String(markets).padStart(4)} markets × ${perMarket}  = ${String(total).padStart(6)} fills  ${el.toFixed(0).padStart(6)} ms   ${Math.round(total / (el / 1000)).toLocaleString().padStart(7)} fills/sec`);
}

// ── 4. THE settlement question: how many fills collapse into ONE on-chain tx? ────────────────────────
async function batching(n: number, buyBias: number, label: string) {
  const { eng } = fresh(1);
  const tr = traders(200);
  // seed inventory so sells are possible
  for (let i = 0; i < 60; i++) await eng.submit(order(1, tr[0]!, i % 2 ? 'no' : 'yes', 'buy', 1n, i));
  for (let i = 0; i < n; i++) {
    const buy = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1 < buyBias;
    await eng.submit(order(1, tr[i % tr.length]!, i % 2 ? 'no' : 'yes', buy ? 'buy' : 'sell', 1n, 1000 + i));
  }
  const b = eng.pendingBatch(1);
  const netMax = Math.max(Number(b.netYesUnits < 0n ? -b.netYesUnits : b.netYesUnits), Number(b.netNoUnits < 0n ? -b.netNoUnits : b.netNoUnits));
  console.log(`  ${label.padEnd(28)} ${String(b.orderIds.length).padStart(5)} fills → net YES ${String(b.netYesUnits).padStart(5)}, NO ${String(b.netNoUnits).padStart(5)}  | max |net| = ${String(netMax).padStart(4)}  ${netMax <= 4095 ? '✅ ONE settlement (MAX_NET=4095)' : `❌ needs ${Math.ceil(netMax / 4095)} settlements`}`);
}

async function main() {
  components(5000);

  console.log('\n=== 2. simultaneous bettors, ONE market (per-market serialized) ===');
  for (const n of [10, 100, 500, 1000, 5000]) await oneMarket(n);

  console.log('\n=== 3. many markets in parallel (independent pools) ===');
  await manyMarkets(10, 200);
  await manyMarkets(50, 200);
  await manyMarkets(100, 200);

  console.log('\n=== 4. fills per ON-CHAIN settlement (MAX_BATCH bounds NET, not gross) ===');
  await batching(200, 0.50, '200 fills, balanced');
  await batching(1000, 0.50, '1000 fills, balanced');
  await batching(1000, 0.55, '1000 fills, 55% buy skew');
  await batching(1000, 0.70, '1000 fills, 70% buy skew');
  await batching(1000, 1.00, '1000 fills, ALL buys (worst)');
}
main().catch((e) => { console.error(e); process.exit(1); });
