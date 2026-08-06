// What does a full mainnet journey actually COST, and can it be clicked through in one sitting?
//
// Answer both before spending real money: run this against a daemon on PM_NETWORK=local, where transactions are
// built and Script-verified exactly as on mainnet but never broadcast. The sizes and fees printed here ARE the
// mainnet numbers — the pool covenant carries the whole compiled contract in every spend, so size dominates the
// fee and economic value is irrelevant to it.
//
// It also answers the question that actually bites: BSV allows ~101 KB of unconfirmed ancestors, and pool spends
// are tens of KB each, so a journey does NOT necessarily fit in one block window. Every boundary this prints is
// a 10–60 minute wait for a confirmation in the middle of a live demo.
//
//   PM_NETWORK=local PM_ENGINE=scrypt PM_OPERATOR_TOKEN=m pnpm --filter @pm/daemon dev
//   pnpm --filter @pm/spike measure:journey
import { PrivateKey } from '@bsv/sdk';
import { signOrder } from '@pm/execution';

const API = 'http://127.0.0.1:8787';
const TOKEN = 'm';

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-pm-operator-token': TOKEN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${j.message ?? JSON.stringify(j)}`);
  return j;
}

const MAINNET_FEE_PER_KB = 500; // FeeProvider's forced rate — the local provider's rate is NOT representative
const mainnetFee = (bytes: number) => Math.ceil((bytes / 1000) * MAINNET_FEE_PER_KB);
const rows: { stage: string; size: number; fee: number }[] = [];

async function authorize(stage: string) {
  const pending = (await call('GET', '/broadcasts')).filter((b: any) => b.status === 'pending');
  if (!pending.length) throw new Error(`${stage}: nothing pending`);
  const r = await call('POST', `/broadcasts/${pending[0].id}/authorize`, {});
  const size = r.size_bytes ?? 0;
  rows.push({ stage, size, fee: mainnetFee(size) });
  console.log(
    `  ${stage.padEnd(9)} ${String(size).padStart(7)} B  ${(size / 1024).toFixed(1).padStart(5)} KB   ` +
    `mainnet fee ~${mainnetFee(size).toLocaleString().padStart(7)} sat`,
  );
}

async function main() {
  const m = await call('POST', '/markets', { question: 'Mainnet demo', bUnits: 1000, payoutUnit: 1000 });
  console.log(`market #${m.id} — b=${m.bUnits}, ${m.payoutUnit} sat/share\n`);
  console.log('  stage        size            fee @ 500 sat/KB');
  console.log('  ------------------------------------------------');

  await call('POST', `/markets/${m.id}/deploy`, {});
  await authorize('deploy');

  // three distinct traders, signed orders — exactly what the browser sends. Off-chain: no tx, no fee.
  for (const [i, p] of [{ side: 'yes', units: 3 }, { side: 'yes', units: 2 }, { side: 'no', units: 2 }].entries()) {
    const priv = PrivateKey.fromRandom();
    const f = {
      marketId: m.id, trader: priv.toPublicKey().toString(), side: p.side as 'yes' | 'no',
      action: 'buy' as const, units: p.units, nonce: Date.now() + i,
    };
    // `units` is a bigint in the signed shape but a number on the wire; `orderPayload` stringifies it, so both agree.
    const sig = signOrder(priv.toWif(), { ...f, units: BigInt(f.units) });
    const r = await call('POST', `/markets/${m.id}/orders`, { ...f, sig });
    console.log(`  fill      buy ${p.units} ${p.side.toUpperCase()} @ ${r.receipt.priceSats} sat  (off-chain — no tx, no fee)`);
  }

  await call('POST', `/markets/${m.id}/settle`, {});
  await authorize('settle');
  await call('POST', `/markets/${m.id}/resolve`, { outcome: 'yes' });
  await authorize('resolve');
  await call('POST', `/markets/${m.id}/payout`, {});
  await authorize('payout');

  const audit = await call('GET', `/markets/${m.id}/audit`);
  const pay = await call('GET', `/markets/${m.id}/payout-preview`);
  const totalFee = rows.reduce((a, r) => a + r.fee, 0);
  const totalSize = rows.reduce((a, r) => a + r.size, 0);

  console.log('\n  ------------------------------------------------');
  console.log(`  TOTAL     ${String(totalSize).padStart(7)} B  ${(totalSize / 1024).toFixed(1).padStart(5)} KB   fee ${String(totalFee).padStart(7)} sat`);
  console.log(`\n  audit:  ${audit.ok ? 'ok — settlement matches the signed receipts' : 'MISMATCH'} (${audit.reports[0]?.receiptCount} receipts)`);
  console.log(`  payout: ${pay.winners.length} winner(s), ${pay.total_sats} sat`);

  // Chain shape. Each stage spends the pool output the previous one produced, so the whole journey is one
  // unconfirmed ancestor chain until a block lands.
  //
  // MEASURED, not assumed: on 2026-08-06 deploy+settle+resolve (183.5 KB, 3 deep) all confirmed in block
  // 961149. The ~101 KB unconfirmed-ancestor figure this tool used to warn about did NOT bind. It is miner
  // policy, not consensus, so treat the number below as information rather than a limit — and if a stage does
  // stall unconfirmed, waiting for a block before the next one is the remedy.
  const depth = rows.length;
  console.log('\n  unconfirmed ancestor chain (each stage spends the previous pool output):');
  let cum = 0;
  for (const r of rows) {
    cum += r.size;
    console.log(`    ${r.stage.padEnd(9)} depth ${rows.indexOf(r) + 1}, cumulative ${(cum / 1024).toFixed(1)} KB`);
  }
  console.log(`\n  → ${depth} deep, ${(cum / 1024).toFixed(1)} KB total if none confirm in between.`);
  console.log('    Observed 2026-08-06: a 3-deep 183.5 KB chain confirmed in ONE block (961149).');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
