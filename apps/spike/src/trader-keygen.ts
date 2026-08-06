// LIVE-001b — generate the demo's TRADER wallets (distinct clients of the market).
//
// Traders are real wallets: each signs its own orders, and the engine verifies that signature before filling,
// so the operator cannot fabricate a trade in a user's name (LIVE-001a). Note traders need NO BSV — they only
// sign off-chain; the operator pays every on-chain fee. That's a real product property: zero-friction onboarding.
//
// WIFs are written to the git-ignored data/traders.json ONLY and never printed (Golden Rule 6). Idempotent:
// re-running keeps existing identities. Run: pnpm --filter @pm/spike keygen:traders [count]
import { makeTraderWallet } from '@pm/execution';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TraderWallet { name: string; wif: string; pubkey: string }

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TRADERS_PATH = join(REPO, 'data', 'traders.json');

export function loadTraders(): TraderWallet[] {
  if (!existsSync(TRADERS_PATH)) return [];
  return JSON.parse(readFileSync(TRADERS_PATH, 'utf8')) as TraderWallet[];
}

function main(): void {
  const want = Number(process.argv[2] ?? 4);
  const existing = loadTraders();
  const traders = [...existing];
  for (let i = existing.length; i < want; i++) {
    traders.push({ name: `trader-${i + 1}`, ...makeTraderWallet() });
  }
  mkdirSync(dirname(TRADERS_PATH), { recursive: true });
  writeFileSync(TRADERS_PATH, JSON.stringify(traders, null, 2), { mode: 0o600 });

  console.log(`${existing.length ? 'Kept' : 'Generated'} ${existing.length} + new ${traders.length - existing.length} = ${traders.length} trader wallets.`);
  console.log('WIFs written to data/traders.json (git-ignored) only — not shown here.\n');
  for (const t of traders) console.log(`  ${t.name.padEnd(10)} pubkey ${t.pubkey}`);
  console.log('\nTraders hold no BSV — they only sign orders. The operator pays all on-chain fees.');
}

if (process.argv[1] && process.argv[1].endsWith('trader-keygen.ts')) main();
