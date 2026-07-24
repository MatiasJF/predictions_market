// DEPLOY-001b — generate a fresh MAINNET funding key. Writes the WIF to the git-ignored .env ONLY and
// prints ONLY the address (never the private key). Run: pnpm --filter @pm/spike keygen
import { PrivateKey } from '@bsv/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

function readEnv(): Map<string, string> {
  const m = new Map<string, string>();
  if (existsSync(ENV)) {
    for (const line of readFileSync(ENV, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) m.set(t.slice(0, i), t.slice(i + 1));
    }
  }
  return m;
}
function writeEnv(m: Map<string, string>): void {
  const header = '# git-ignored — PM_FUNDING_WIF is a PRIVATE KEY. Never commit. Never print.\n';
  const body = [...m].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(ENV, header + body, { mode: 0o600 });
}

const env = readEnv();
const existing = env.get('PM_FUNDING_WIF');
if (existing && existing.length > 0) {
  const priv = PrivateKey.fromWif(existing);
  console.log('A funding key already exists in .env.');
  console.log('address:', String(priv.toAddress()));
  console.log('Delete the PM_FUNDING_WIF line in .env to generate a new one.');
  process.exit(0);
}

const priv = PrivateKey.fromRandom();
env.set('PM_NETWORK', 'mainnet');
env.set('PM_FUNDING_WIF', priv.toWif());
writeEnv(env);

console.log('Generated a fresh MAINNET funding key. WIF written to .env (git-ignored) only — not shown here.');
console.log('address:', String(priv.toAddress()));
console.log('pubkey :', priv.toPublicKey().toString());
console.log('\nFund this address with ~0.01–0.02 BSV, then tell me — I will verify the balance and deploy.');
