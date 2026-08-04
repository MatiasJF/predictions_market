// pm-daemon entrypoint. Opens the DB, applies migrations, wires the selected engine, and serves on 127.0.0.1.
// Env: PM_DB_PATH (DB file), PM_PORT (default 8787), PM_ENGINE (runar|scrypt, default runar), PM_NETWORK
// (runar: mainnet|testnet; scrypt: mainnet|local, default local). The funding WIF is read only by the engine's
// authorize path — never here.
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, defaultDbPath } from '@pm/persistence';
import { RunarEngine, type ChainEngine } from '@pm/engine';
import { MarketService } from './service.js';
import { startServer } from './http.js';

/** The funding WIF from the repo-root .env — passed to the sCrypt engine's authorize path only. */
function fundingWif(): string {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envPath)) return '';
  const m = readFileSync(envPath, 'utf8').match(/^PM_FUNDING_WIF=(.+)$/m);
  const wif = m?.[1];
  return wif ? wif.trim().replace(/^["']|["']$/g, '') : '';
}

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
const service = new MarketService(db, engine);
const port = Number(process.env.PM_PORT ?? 8787);

startServer(service, port);

console.log(`pm-daemon listening on http://127.0.0.1:${port}`);
console.log(`  db:        ${dbPath} (migrations applied this start: ${applied})`);
console.log(`  engine:    ${label}`);
console.log(`  sign-off:  state-changing ops park in the broadcasts queue; POST /broadcasts/:id/authorize to send`);
engine.fundingAddress()
  .then((a) => console.log(`  funding:   ${a}`))
  .catch((e) => console.log(`  funding:   (unavailable) [${e instanceof Error ? e.message : e}]`));
