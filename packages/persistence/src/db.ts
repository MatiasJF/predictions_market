import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const REPO_ROOT = join(HERE, '..', '..', '..');

export type Db = Database.Database;

/** Default spike DB path: PM_DB_PATH env, else <repo>/data/spike.db. Public data only (Golden Rule 6). */
export const defaultDbPath = (): string => process.env.PM_DB_PATH ?? join(REPO_ROOT, 'data', 'spike.db');

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
