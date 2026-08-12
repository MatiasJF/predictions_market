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
import { WocChainCheck, OfflineChainCheck, ToolboxBeefSource, NoBeefSource, type ChainCheck } from '@pm/wallet';

/** Read a value from the repo-root .env (secrets are used at runtime only — never stored/echoed; Golden Rule 6). */
function envFile(name: string): string {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envPath)) return '';
  const m = readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
  const v = m?.[1];
  return v ? v.trim().replace(/^["']|["']$/g, '') : '';
}
const envWif = envFile;
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

/*
 * SAFE DEFAULTS FOR AN UNCONFIGURED RUN.
 *
 * `PM_NETWORK` defaulted to `mainnet` and `PM_ENGINE` to `runar`. That is the wrong pair to hand someone who
 * has just cloned the repository and typed one command: mainnet means the app reports a real network and
 * reaches for a real explorer, and the Rúnar engine needs a toolchain that is not installed by `pnpm install`.
 *
 * Unset now means the free, offline, working combination. Transactions are still built and Script-verified
 * exactly as they would be on mainnet — they are simply never broadcast, which costs nothing and needs no
 * keys. Going to mainnet stays a deliberate act: set PM_NETWORK=mainnet yourself.
 */
/*
 * Precedence: an explicit variable on the command line, then `.env`, then the safe default.
 *
 * `.env` HAD `PM_NETWORK=mainnet` all along and the daemon never read it — only WIF names were ever pulled
 * from that file, and the network came from a hardcoded `?? 'mainnet'` fallback. Which worked, silently, for
 * exactly as long as the fallback agreed with the file. Changing the fallback to `local` for the benefit of a
 * fresh clone therefore flipped a configured mainnet daemon to local on its next restart, with nothing in
 * `.env` to prevent it. Reading the file is what makes both true at once.
 */
process.env.PM_NETWORK ||= envFile('PM_NETWORK') || 'local';
process.env.PM_ENGINE ||= envFile('PM_ENGINE') || 'scrypt';

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
/*
 * With no key configured, an OFFLINE run gets an ephemeral one.
 *
 * Without this a fresh clone cannot trade at all: `payment-intent` returns 501 `no_payment_key`, so the
 * demo seeder dies on its first buy and the app can be looked at but not used. On `local` that key is
 * pure ceremony — payments are built and Script-verified and never broadcast — so generating one costs
 * nothing and makes the whole flow work with no configuration.
 *
 * NEVER on mainnet. A key that exists only in memory would be handed real stake payments and forget them
 * on the next restart, which is money destroyed rather than money at risk. There, no key stays 501, and
 * the daemon says which key is missing.
 */
const payKey = paymentWif()
  ? PrivateKey.fromWif(paymentWif())
  : (process.env.PM_NETWORK === 'mainnet' ? undefined : PrivateKey.fromRandom());
// Typed as the interface, not the union: `rawTx` is an optional member of ChainCheck that only the online
// implementation has, and the union type hides it entirely.
const chainCheck: ChainCheck = (process.env.PM_NETWORK ?? 'mainnet') === 'mainnet'
  ? new WocChainCheck('main')
  : new OfflineChainCheck();
// A winner's wallet will not accept money on our say-so; it wants the payout transaction, provable. Offline
// there is nothing to prove it against, and `NoBeefSource` says so instead of failing at request time.
//
// `chainCheck.rawTx` is handed over so an UNCONFIRMED payout can still be assembled from its (mined) parents —
// WhatsOnChain serves mempool transactions, which is what makes claiming possible before the block arrives.
const beefSource = (process.env.PM_NETWORK ?? 'mainnet') === 'mainnet'
  ? new ToolboxBeefSource('main', (txid) => chainCheck.rawTx?.(txid) ?? Promise.resolve(undefined))
  : new NoBeefSource();
const service = new MarketService(db, engine, exec, payKey, chainCheck, beefSource);
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
