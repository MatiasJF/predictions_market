// pm-daemon entrypoint. Opens the DB, applies migrations, wires a RunarEngine, and serves on 127.0.0.1.
// Env: PM_DB_PATH (DB file), PM_PORT (default 8787), PM_NETWORK (default mainnet). The funding WIF is read
// only by the engine's authorize path — never here.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, migrate, defaultDbPath } from '@pm/persistence';
import { RunarEngine } from '@pm/engine';
import { MarketService } from './service.js';
import { startServer } from './http.js';

const dbPath = defaultDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const applied = migrate(db);

const network = (process.env.PM_NETWORK ?? 'mainnet') as 'mainnet' | 'testnet';
const engine = new RunarEngine(network);
const service = new MarketService(db, engine);
const port = Number(process.env.PM_PORT ?? 8787);

startServer(service, port);

console.log(`pm-daemon listening on http://127.0.0.1:${port}`);
console.log(`  db:        ${dbPath} (migrations applied this start: ${applied})`);
console.log(`  engine:    ${engine.name} (${network})`);
console.log(`  sign-off:  state-changing ops park in the broadcasts queue; POST /broadcasts/:id/authorize to send`);
engine.fundingAddress()
  .then((a) => console.log(`  funding:   ${a}`))
  .catch((e) => console.log(`  funding:   (no .env WIF yet — read ops work; authorize needs PM_FUNDING_WIF) [${e instanceof Error ? e.message : e}]`));
