// DEPLOY-001a CLI — offline dry-run of deploy + buys, printing tx sizes & fees.
// Run: pnpm --filter @pm/spike dry-run
import { runDryRun } from './measure.js';

const fee = (bytes: number, rate: number): string => (bytes * rate).toFixed(2);

async function main(): Promise<void> {
  const r = await runDryRun(3, 0.05);
  console.log(`\nLMSRMarket offline dry-run (b=1000, fee ${r.feeRate} sat/byte) — no chain, no funds\n`);
  console.log(`deploy   ${String(r.deployBytes).padStart(5)} B   ~${fee(r.deployBytes, r.feeRate).padStart(7)} sat`);
  r.buyBytes.forEach((b, i) =>
    console.log(`buy #${i}   ${String(b).padStart(5)} B   ~${fee(b, r.feeRate).padStart(7)} sat`),
  );
  console.log('\nAll transactions built offline (MockProvider). No mainnet broadcast.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
