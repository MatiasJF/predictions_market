// LIVE-001c — a REAL market with REAL trader wallets, end to end, driven over HTTP against the actual daemon.
//
// Every prior mainnet proof was a purpose-built runner, and three used synthetic inputs (a fabricated 5-fill
// batch, a hand-built mint tx, a self-dealt slash). This is the honest version: distinct trader wallets sign
// real orders, the execution engine fills them and issues signed receipts, and THAT REAL BATCH is settled
// on-chain and audited against those receipts.
//
//   pnpm --filter @pm/spike live            # local network (offline, free) — the dry run
//   pnpm --filter @pm/spike live -- --mainnet   # the real thing (user-authorized spend)
//
// Sequencing is dictated by the measured ~101 KB unconfirmed-ancestor budget: deploy(~31 KB)+settle(~60 KB) fit
// in one window; resolve and redeem each need a preceding confirmation. So the run has two confirmation waits on
// mainnet. It is RESUMABLE — re-running continues from the persisted state (a live CONC-005 demonstration).
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signOrder } from '@pm/execution';
import { loadTraders, type TraderWallet } from './trader-keygen.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAINNET = process.argv.includes('--mainnet');
const PORT = Number(process.env.PM_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(REPO, 'data', MAINNET ? 'live-mainnet.db' : 'live-local.db');
const B_UNITS = 1000; // liquidity: keeps net/b sane and prices realistic
const PAYOUT_UNIT = 1000; // small payout so mainnet amounts stay tiny

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s = '') => console.log(s);

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Enqueue a spend and authorize it — the human gate the daemon enforces for every broadcast. */
async function enqueueAndAuthorize(path: string, body: unknown, label: string): Promise<string> {
  const q = await api('POST', path, body);
  log(`  ${label}: queued (broadcast #${q.broadcast_id}) — ${q.summary}`);
  const ok = await api('POST', `/broadcasts/${q.broadcast_id}/authorize`);
  log(`  ${label}: BROADCAST ${ok.txid}  (pool v${ok.pool_version})`);
  return ok.txid;
}

async function confirmations(txid: string): Promise<number> {
  if (!MAINNET) return 1;
  try {
    const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`);
    const j: any = await r.json();
    return j?.confirmations ?? 0;
  } catch {
    return 0;
  }
}

async function waitForConfirmation(txid: string, label: string): Promise<void> {
  if (!MAINNET) return;
  log(`\n  ⏳ waiting for ${label} to confirm (BSV block timing — this can take 10–60 min)…`);
  for (let i = 1; i <= 60; i++) {
    const c = await confirmations(txid);
    if (c >= 1) {
      log(`  ✅ ${label} confirmed (${c} conf)`);
      return;
    }
    if (i % 5 === 0) log(`     …still unconfirmed after ${i * 2} min`);
    await sleep(120_000);
  }
  throw new Error(`${label} did not confirm in 2h — re-run to resume`);
}

function startDaemon(): ChildProcess {
  const child = spawn('npx', ['tsx', join(REPO, 'apps', 'daemon', 'src', 'server.ts')], {
    cwd: REPO,
    env: {
      ...process.env,
      PM_ENGINE: 'scrypt',
      PM_NETWORK: MAINNET ? 'mainnet' : 'local',
      PM_DB_PATH: DB,
      PM_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => process.env.DAEMON_LOG && process.stdout.write(`[daemon] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  return child;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const h = await api('GET', '/health');
      if (h.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('daemon did not become healthy');
}

/** A realistic two-sided order flow across the trader wallets (mixed sides + some selling back). */
function orderFlow(traders: TraderWallet[]): { t: TraderWallet; side: 'yes' | 'no'; action: 'buy' | 'sell' }[] {
  const flow: { t: TraderWallet; side: 'yes' | 'no'; action: 'buy' | 'sell' }[] = [];
  // opening interest: everyone takes a position
  for (let round = 0; round < 4; round++) {
    traders.forEach((t, i) => {
      flow.push({ t, side: (i + round) % 2 === 0 ? 'yes' : 'no', action: 'buy' });
    });
  }
  // some traders close part of their position (proves sells + net-vs-gross batching)
  traders.slice(0, 2).forEach((t, i) => {
    flow.push({ t, side: i % 2 === 0 ? 'yes' : 'no', action: 'sell' });
  });
  // late momentum toward YES (directional flow — the case that used to break the batch cap)
  for (let round = 0; round < 2; round++) {
    traders.forEach((t) => flow.push({ t, side: 'yes', action: 'buy' }));
  }
  return flow;
}

async function main(): Promise<void> {
  const traders = loadTraders();
  if (traders.length === 0) {
    throw new Error('no trader wallets — run: pnpm --filter @pm/spike keygen:traders 4');
  }

  log('═'.repeat(78));
  log(`  LIVE MARKET — ${MAINNET ? '🔴 BSV MAINNET (real spends)' : '🟢 local (offline, free)'}`);
  log(`  ${traders.length} trader wallets · db ${DB.replace(REPO + '/', '')}`);
  log('═'.repeat(78));

  const daemon = startDaemon();
  const stop = () => { try { daemon.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(1); });

  try {
    await waitForHealth();
    log('\n▸ daemon up');

    // ── 1. market + pool ────────────────────────────────────────────────────────────────────────────
    const existing = (await api('GET', '/markets')) as any[];
    let market = existing.find((m) => m.question?.startsWith('LIVE:'));
    if (!market) {
      market = await api('POST', '/markets', {
        question: `LIVE: multi-wallet market ${new Date().toISOString().slice(0, 16)}`,
        bUnits: B_UNITS, payoutUnit: PAYOUT_UNIT,
      });
      log(`\n▸ market #${market.id} created — "${market.question}"`);
    } else {
      log(`\n▸ resuming market #${market.id} (state: ${market.state})`);
    }
    const id = market.id;

    let deployTxid = market.pool?.txid as string | undefined;
    if (!market.pool) {
      log('\n▸ DEPLOY the pool on-chain');
      deployTxid = await enqueueAndAuthorize(`/markets/${id}/deploy`, undefined, 'deploy');
    }

    // ── 2. REAL signed orders from REAL wallets ─────────────────────────────────────────────────────
    const before = await api('GET', `/markets/${id}/receipts`);
    if (before.count === 0) {
      log('\n▸ TRADING — each order is signed by the trader wallet and verified before filling');
      const flow = orderFlow(traders);
      let nonce = Date.now() % 1_000_000;
      let filled = 0;
      for (const f of flow) {
        const fields = { marketId: id, trader: f.t.pubkey, side: f.side, action: f.action, units: 1n, nonce: ++nonce };
        try {
          const r = await api('POST', `/markets/${id}/orders`, {
            trader: f.t.pubkey, side: f.side, action: f.action, units: 1,
            nonce: fields.nonce, sig: signOrder(f.t.wif, fields),
          });
          filled++;
          if (filled % 6 === 0 || filled === 1) {
            log(`    ${String(filled).padStart(2)} fills · ${f.t.name} ${f.action} ${f.side.toUpperCase()} @ ${r.receipt.priceSats} sat`);
          }
        } catch (e) {
          log(`    ${f.t.name} ${f.action} ${f.side} skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
        }
      }
      log(`  → ${filled} REAL fills, each with a signed receipt`);
    } else {
      log(`\n▸ resuming: ${before.count} fills already recorded`);
    }

    const positions = await api('GET', `/markets/${id}/exec-positions`);
    log('\n▸ per-trader book (off-chain, instant):');
    for (const p of positions.positions) {
      const name = traders.find((t) => t.pubkey === p.trader)?.name ?? p.trader.slice(0, 12);
      log(`    ${name.padEnd(10)} YES ${String(BigInt(p.netYesShares) / 10n ** 18n).padStart(3)}  NO ${String(BigInt(p.netNoShares) / 10n ** 18n).padStart(3)}  net cost ${p.netCostSats} sat`);
    }

    // ── 3. settle the REAL batch on-chain ───────────────────────────────────────────────────────────
    let settleTxid: string | undefined;
    const mv1 = await api('GET', `/markets/${id}`);
    if (mv1.pool?.version === 0) {
      log('\n▸ SETTLE the real batch on-chain (N fills → ONE transaction)');
      settleTxid = await enqueueAndAuthorize(`/markets/${id}/settle`, undefined, 'settle');
    } else {
      log(`\n▸ already settled (pool v${mv1.pool?.version})`);
    }

    // ── 4. audit: does the on-chain settlement match the signed receipts? ───────────────────────────
    const audit = await api('GET', `/markets/${id}/audit`);
    log(`\n▸ AUDIT: ok=${audit.ok} over ${audit.batches} batch(es)`);
    for (const r of audit.reports) {
      log(`    batch #${r.batchId}: ${r.receiptCount} receipts · violations ${r.violations.length} · rabin-attested ${r.rabinAttested}`);
      for (const v of r.violations) log(`      ❌ ${v.check}: ${v.detail}`);
    }
    if (!audit.ok) throw new Error('AUDIT FAILED — the settlement does not match the receipts');

    // ── 5. resolve (needs the settle confirmed: ancestor budget) ────────────────────────────────────
    const mv2 = await api('GET', `/markets/${id}`);
    let resolveTxid: string | undefined;
    if (mv2.pool?.resolved !== 1) {
      if (settleTxid) await waitForConfirmation(settleTxid, 'settle');
      log('\n▸ RESOLVE via the oracle');
      resolveTxid = await enqueueAndAuthorize(`/markets/${id}/resolve`, { outcome: 'yes' }, 'resolve');
    } else {
      log('\n▸ already resolved');
    }

    // ── 6. payout: the honest gap ───────────────────────────────────────────────────────────────────
    // In the batched-settlement design a trader's position IS the signed receipt — off-chain fills do not mint
    // per-participant on-chain tokens (CONC-002 settled NET state; per-participant minting was deferred). The
    // `redeem` path requires a token minted by an ON-CHAIN buy, so it does not apply to this flow. Converting an
    // audited winning receipt into an on-chain payout is the one piece of the user journey still missing.
    log('\n▸ PAYOUT — not attempted, and this is the honest gap:');
    log('    Traders hold signed receipts (audited above), not per-participant on-chain tokens.');
    log('    `redeem` needs a token minted by an on-chain buy, so it does not apply to settled off-chain');
    log('    positions. Receipt → on-chain payout is the remaining work (CONC-003 validity / per-participant');
    log('    minting). The redeem MECHANISM itself is separately proven on mainnet (tx c6d8900f…).');
    const redeemTxid: string | undefined = undefined;

    // ── report ──────────────────────────────────────────────────────────────────────────────────────
    const final = await api('GET', `/markets/${id}`);
    const receipts = await api('GET', `/markets/${id}/receipts`);
    log('\n' + '═'.repeat(78));
    log('  RESULT');
    log('═'.repeat(78));
    log(`  market            #${id} · state ${final.state} · resolution ${final.resolution ?? '—'}`);
    log(`  traders           ${traders.length} real wallets, orders signed + verified`);
    log(`  real fills        ${receipts.count} (each with a signed receipt)`);
    log(`  pool version      v${final.pool?.version}  qYes ${BigInt(final.pool?.qYes ?? '0') / 10n ** 18n}  qNo ${BigInt(final.pool?.qNo ?? '0') / 10n ** 18n}`);
    log(`  audit             ${audit.ok ? '✅ settlement matches the signed receipts' : '❌ FAILED'}`);
    if (deployTxid) log(`  deploy            ${deployTxid}`);
    if (settleTxid) log(`  settle            ${settleTxid}   ← ${receipts.count} fills in ONE tx`);
    if (resolveTxid) log(`  resolve           ${resolveTxid}`);
    if (redeemTxid) log(`  redeem            ${redeemTxid}`);
    log('\n  proven here:  real wallets → signed orders → verified fills → ONE on-chain settlement → audit ok');
    log('  still owed:   receipt → on-chain payout for settled positions (per-participant minting / validity)');
    if (MAINNET) log('\n  verify: https://whatsonchain.com/tx/<txid>');
    log('');
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
