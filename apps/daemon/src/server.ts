// pm-daemon entrypoint. Opens the DB, applies migrations, wires the selected engine, and serves on 127.0.0.1.
// Env: PM_DB_PATH (DB file), PM_PORT (default 8787), PM_ENGINE (runar|scrypt, default runar), PM_NETWORK
// (runar: mainnet|testnet; scrypt: mainnet|local, default local). The funding WIF is read only by the engine's
// authorize path — never here.
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, defaultDbPath } from '@pm/persistence';
import { RunarEngine, type ChainEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner } from '@pm/execution';
import { MarketService } from './service.js';
import { startServer } from './http.js';
import { PrivateKey } from '@bsv/sdk';
import { WocChainCheck, OfflineChainCheck } from '@pm/wallet';

/** Read a WIF from the repo-root .env (used at runtime only — never stored/echoed; Golden Rule 6). */
function envWif(name: string): string {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envPath)) return '';
  const m = readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
  const wif = m?.[1];
  return wif ? wif.trim().replace(/^["']|["']$/g, '') : '';
}
/** Funding WIF — passed to the sCrypt engine's authorize path only. */
const fundingWif = (): string => envWif('PM_FUNDING_WIF');
/** Sequencer WIF for signing off-chain receipts — falls back to the funding key, then a random dev key. */
const sequencerWif = (): string => envWif('PM_SEQUENCER_WIF') || fundingWif();
/**
 * FUND-001. The key trader STAKES are paid to. Separate from the covenant funding key by default so stake
 * money and fee money are not commingled and a market's solvency is measurable — but it falls back, because a
 * daemon with no payment key cannot accept trades at all.
 */
const paymentWif = (): string => envWif('PM_PAYMENT_WIF') || fundingWif();

async function makeEngine(): Promise<{ engine: ChainEngine; label: string }> {
  const kind = process.env.PM_ENGINE ?? 'runar';
  if (kind === 'scrypt') {
    const net = process.env.PM_NETWORK === 'mainnet' ? 'mainnet' : 'local';
    // contracts-scrypt is an npm-isolated CJS build (outside the pnpm workspace) — import the compiled engine.
    const url = new URL('../../../packages/contracts-scrypt/dist/src/scryptEngine.js', import.meta.url).href;
    const mod: any = await import(url);
    const ScryptEngine = mod.ScryptEngine ?? mod.default?.ScryptEngine;
    return { engine: new ScryptEngine(net, fundingWif) as unknown as ChainEngine, label: `scrypt (${net})` };
  }
  const network = (process.env.PM_NETWORK ?? 'mainnet') as 'mainnet' | 'testnet';
  const engine = new RunarEngine(network);
  return { engine, label: `${engine.name} (${network})` };
}

const dbPath = defaultDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const applied = migrate(db);

const { engine, label } = await makeEngine();
// FUND-001: the payment gate is ON. A buy is only a fill if the trader actually paid for it.
const exec = new ExecutionEngine(db, makeReceiptSigner(sequencerWif()));
// Trader payments: derive destinations from the payment key, and confirm the payment actually reached the
// network. `local` accepts anything (there is no chain to ask); mainnet asks WhatsOnChain, which is what stops
// a trader submitting a valid-but-never-broadcast payment and getting a fill for free.
const payKey = paymentWif() ? PrivateKey.fromWif(paymentWif()) : undefined;
const chainCheck = (process.env.PM_NETWORK ?? 'mainnet') === 'mainnet'
  ? new WocChainCheck('main')
  : new OfflineChainCheck();
const service = new MarketService(db, engine, exec, payKey, chainCheck);
const port = Number(process.env.PM_PORT ?? 8787);

startServer(service, port);

console.log(`pm-daemon listening on http://127.0.0.1:${port}`);
console.log(`  db:        ${dbPath} (migrations applied this start: ${applied})`);
console.log(`  engine:    ${label}, fee ${process.env.PM_FEE_PER_KB ?? 100} sat/KB`);
console.log(`  exec:      off-chain fills (POST /markets/:id/orders) → settle (POST /markets/:id/settle) into the sign-off queue`);
console.log(`  sign-off:  state-changing ops park in the broadcasts queue; POST /broadcasts/:id/authorize to send`);
engine.fundingAddress()
  .then((a) => console.log(`  funding:   ${a}`))
  .catch((e) => console.log(`  funding:   (unavailable) [${e instanceof Error ? e.message : e}]`));
