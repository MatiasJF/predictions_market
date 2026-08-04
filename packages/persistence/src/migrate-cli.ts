// Apply all pending migrations to the spike DB. Usage: `pnpm db:migrate` (path via PM_DB_PATH or default).
// The DB stores public data only (pubkeys/refs, outpoints, LMSR state) — never keys (Golden Rule 6).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, migrate, defaultDbPath } from './db.js';

const path = defaultDbPath();
mkdirSync(dirname(path), { recursive: true });
const db = openDb(path);
const n = migrate(db);
const version = db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number };
console.log(`migrated: ${path}\napplied ${n} new migration(s); schema now at version ${version.v}`);
db.close();
