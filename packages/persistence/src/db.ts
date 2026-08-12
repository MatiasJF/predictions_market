import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const REPO_ROOT = join(HERE, '..', '..', '..');

export type Db = Database.Database;

/**
 * Default DB path: `PM_DB_PATH`, else `<repo>/data/spike.db`. Public data only (Golden Rule 6).
 *
 * A RELATIVE `PM_DB_PATH` is resolved against the repository root, not the working directory. `pnpm
 * --filter @pm/daemon dev` runs with its CWD in `apps/daemon`, so `PM_DB_PATH=data/demo.db` quietly created
 * `apps/daemon/data/demo.db` — an empty database. Nothing failed: the daemon came up on the right network
 * with the right keys and reported zero markets, which looks like lost data rather than a path.
 */
export const defaultDbPath = (): string => {
  const configured = process.env.PM_DB_PATH;
  if (!configured) return join(REPO_ROOT, 'data', 'spike.db');
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
};

/** Open (creating if needed) the spike SQLite DB with sane pragmas. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Apply any unapplied `NNN_*.sql` migrations in order. The runner owns `schema_migrations`;
 * migration files contain only domain DDL. Returns the number of migrations applied.
 */
export function migrate(db: Db): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  let count = 0;
  const record = db.prepare('INSERT INTO schema_migrations(version) VALUES (?)');
  for (const file of files) {
    const version = Number(file.split('_', 1)[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(version);
    });
    tx();
    count++;
  }
  return count;
}
