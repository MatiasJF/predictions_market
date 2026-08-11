// What does a fill actually cost on chain? (ECON-001)
//
// The question that decides whether this is a product or a demo. A single mainnet lifecycle costs
// ~28,601 sat in fees against a 1,038 sat bet, which looks fatal — until you notice WHERE the cost
// is. This measures it from real broadcasts rather than arguing about it.
//
//   pnpm --filter @pm/spike measure:economics
import { openDb } from '@pm/persistence';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;
const FEE_PER_KB = 100; // the miner minimum, measured on mainnet (ADR-038)

interface Row { fills: number; bytes: number; db: string }

const rows: Row[] = [];
for (const f of readdirSync(join(ROOT, 'data')).filter((n) => n.endsWith('.db'))) {
  try {
    const db = openDb(join(ROOT, 'data', f));
    for (const r of db.prepare(`
      SELECT b.order_count AS fills, br.size_bytes AS bytes
        FROM exec_batches b JOIN broadcasts br ON br.txid = b.txid
       WHERE br.size_bytes IS NOT NULL AND b.order_count > 0`).all() as Row[]) {
      rows.push({ ...r, db: f });
    }
    db.close();
  } catch { /* a database without these tables is simply not interesting here */ }
}
if (rows.length < 2) { console.log('not enough settlements measured yet'); process.exit(0); }

rows.sort((a, b) => a.fills - b.fills);
const lo = rows[0]!;
const hi = rows[rows.length - 1]!;

console.log('\nSETTLEMENT SIZE vs FILLS CLEARED (measured, real transactions)\n');
console.log('  fills   size_B   sat @0.1/B   sat per fill');
for (const r of rows) {
  const fee = Math.ceil((r.bytes / 1000) * FEE_PER_KB);
  console.log(`  ${String(r.fills).padStart(5)}   ${String(r.bytes).padStart(6)}   ${String(fee).padStart(10)}   ${(fee / r.fills).toFixed(0).padStart(12)}`);
}

// The load-bearing number: how much does ONE more fill add to the transaction?
const perFill = (hi.bytes - lo.bytes) / (hi.fills - lo.fills);
console.log(`\n  marginal cost of one extra fill: ${perFill.toFixed(2)} bytes ≈ ${(perFill * FEE_PER_KB / 1000).toFixed(5)} sat`);
console.log('  — a settlement is priced by the COVENANT it republishes, not by what it clears.\n');

console.log('WHAT THAT MEANS PER MARKET (deploy + settle + resolve + payout ≈ 28,601 sat)\n');
console.log('  fills in one settlement   fee per fill');
for (const n of [2, 10, 26, 100, 500, 2000]) {
  console.log(`  ${String(n).padStart(23)}   ${(28_601 / n).toFixed(0).padStart(12)} sat`);
}
console.log('\n  A market is a FIXED cost. The only thing that makes it cheap is volume through it.\n');
