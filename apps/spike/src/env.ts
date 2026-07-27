// Minimal .env loader (no dotenv dep). Reads the repo-root .env into a plain object.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV)) return out;
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

/** The funding WIF from .env, or throw a helpful error. Never logged. */
export function fundingWif(): string {
  const wif = loadEnv().PM_FUNDING_WIF;
  if (!wif) throw new Error('No PM_FUNDING_WIF in .env — run `pnpm --filter @pm/spike keygen` first.');
  return wif;
}
