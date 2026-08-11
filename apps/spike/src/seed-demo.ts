// Seed a DEMO database with markets that look lived-in (DEMO-001).
//
// The point is a showcase: markets with real price history behind them, some still open, some
// resolved and paid. Everything here goes through the daemon's real HTTP API — real signed orders,
// real payment intents, real batched settlement, real oracle resolution — so nothing on screen is a
// fabricated row. The only thing that is not real is the network: `PM_NETWORK=local` builds and
// Script-verifies every transaction exactly as mainnet would and then does not broadcast it.
//
// IT WILL NOT TOUCH A MAINNET DATABASE. `data/spike.db` holds the audit trail of real runs and the
// derivation nonces without which real satoshis are unspendable, so this refuses to run against a
// daemon reporting `network: mainnet`, and it refuses to seed a database that already has markets.
//
//   PM_DB_PATH=data/demo.db PM_NETWORK=local PM_ENGINE=scrypt PM_PORT=8799 \
//     PM_OPERATOR_TOKEN=demo pnpm --filter @pm/daemon dev
//   PM_API=http://127.0.0.1:8799 PM_OPERATOR_TOKEN=demo pnpm --filter @pm/spike seed:demo
import { LockingScript, PrivateKey, Transaction } from '@bsv/sdk';
import { signOrder } from '@pm/execution';

const API = process.env.PM_API ?? 'http://127.0.0.1:8799';
const TOKEN = process.env.PM_OPERATOR_TOKEN ?? 'demo';

/** Markets worth looking at: a spread of questions, liquidity and payout sizes. */
const MARKETS = [
  { question: 'Will BSV block height pass 1,000,000 before July?', bUnits: 20, payoutUnit: 1000, buys: 14, finish: 'yes' },
  { question: 'Will this spike ship a native on-chain LMSR market?', bUnits: 15, payoutUnit: 1000, buys: 11, finish: 'yes' },
  { question: 'Will the operator pay every seller before Friday?', bUnits: 25, payoutUnit: 1000, buys: 9, finish: 'no' },
  { question: 'Will a single settlement clear more than 20 fills?', bUnits: 30, payoutUnit: 500, buys: 16, finish: null },
  { question: 'Will fees stay under 0.1 sat/byte for the whole run?', bUnits: 12, payoutUnit: 2000, buys: 8, finish: null },
  { question: 'Will anyone trade this market at all?', bUnits: 40, payoutUnit: 1000, buys: 0, finish: null },
];

const api = async (method: string, path: string, body?: unknown, operator = false) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(operator ? { 'x-pm-operator-token': TOKEN } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as any;
};

/** Queue an operator action and authorize it — the human gate, driven by the script. */
async function act(marketId: number, action: string, body: unknown = {}) {
  const q = await api('POST', `/markets/${marketId}/${action}`, body, true);
  if (!q.broadcast_id) return q;
  return api('POST', `/broadcasts/${q.broadcast_id}/authorize`, {}, true);
}

/** A funded buy: quote an intent, pay it, submit. Exactly what a browser with a wallet does. */
async function buy(marketId: number, w: { key: PrivateKey; pub: string }, side: 'yes' | 'no', units: number, nonce: number) {
  const intent = await api('POST', `/markets/${marketId}/payment-intent`,
    { trader: w.pub, side, action: 'buy', units });

  const tx = new Transaction();
  tx.addOutput({ lockingScript: LockingScript.fromHex(intent.locking_script), satoshis: intent.satoshis });

  return api('POST', `/markets/${marketId}/orders`, {
    trader: w.pub, side, action: 'buy', units, nonce,
    sig: signOrder(w.key.toWif(), {
      marketId, trader: w.pub, side, action: 'buy', units: BigInt(units), nonce,
    }),
    sigScheme: 'ecdsa',
    intentId: intent.intent_id,
    paymentTx: tx.toHex(),
  });
}

async function main() {
  const health = await api('GET', '/health');
  if (health.network === 'mainnet') {
    throw new Error(
      `REFUSING: ${API} is a MAINNET daemon. Seeding would create real markets and spend real money. ` +
      'Point PM_API at a PM_NETWORK=local daemon with its own PM_DB_PATH.',
    );
  }
  const existing = await api('GET', '/markets');
  if (existing.length > 0) {
    throw new Error(
      `REFUSING: this database already has ${existing.length} market(s). Seeding is for a FRESH demo db — ` +
      'point PM_DB_PATH at a new file rather than adding demo data to a database that holds real history.',
    );
  }

  // Several traders, so positions and payouts have more than one name in them.
  const traders = Array.from({ length: 4 }, () => {
    const key = PrivateKey.fromRandom();
    return { key, pub: key.toPublicKey().toString() };
  });

  let nonce = 1;
  for (const spec of MARKETS) {
    process.stdout.write(`\n▸ ${spec.question}\n`);
    const m = await api('POST', '/markets', { question: spec.question, bUnits: spec.bUnits, payoutUnit: spec.payoutUnit }, true);
    await act(m.id, 'deploy');
    process.stdout.write('  deployed');

    // Trades that actually move the curve, so the sparklines have a shape rather than a flat line.
    // Weighted towards YES early and mixed later, which reads like a market forming a view.
    for (let i = 0; i < spec.buys; i++) {
      const w = traders[i % traders.length]!;
      const side: 'yes' | 'no' = i < spec.buys * 0.6 ? (i % 3 === 0 ? 'no' : 'yes') : (i % 2 === 0 ? 'no' : 'yes');
      await buy(m.id, w, side, 1 + (i % 3), nonce++);
    }
    if (spec.buys) process.stdout.write(` · ${spec.buys} fills`);

    if (spec.buys > 0) {
      await act(m.id, 'settle');
      process.stdout.write(' · settled');
    }

    if (spec.finish) {
      await act(m.id, 'resolve', { outcome: spec.finish });
      process.stdout.write(` · resolved ${spec.finish.toUpperCase()}`);
      const preview = await api('GET', `/markets/${m.id}/payout-preview`);
      if (preview.winners?.length) {
        await act(m.id, 'payout');
        process.stdout.write(` · paid ${preview.total_sats} sat to ${preview.winners.length}`);
      }
    }
  }

  const all = await api('GET', '/markets');
  process.stdout.write(`\n\n✔ ${all.length} demo markets seeded at ${API}\n`);
  for (const m of all) {
    const state = m.resolution ? `resolved ${m.resolution.toUpperCase()}` : m.pool ? 'open' : 'not deployed';
    process.stdout.write(`   #${m.id}  YES ${String(m.prices.yes_sats).padStart(5)}  ${state.padEnd(14)}  ${m.question}\n`);
  }
}

main().catch((e) => { process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
