// DEPLOY-001b — MAINNET operations (gated, real money). Loads the funding WIF from .env at runtime.
//   pnpm --filter @pm/spike mainnet balance            # read-only: show funding balance/UTXOs
//   pnpm --filter @pm/spike mainnet deploy             # DRY: build + report the deploy, no broadcast
//   pnpm --filter @pm/spike mainnet deploy --broadcast # REAL: broadcast the pool deploy tx
// Every state-changing action requires the explicit `--broadcast` flag (ADR-010 / Golden Rule 6).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { WhatsOnChainProvider, LocalSigner, RunarContract } from 'runar-sdk';
import { applyUnitBuy, buyChargeApproxSats } from '@pm/lmsr';
import { compileMarket, marketSetup } from './market.js';
import { BsvSigner } from './bsv-signer.js';
import { fundingWif } from './env.js';

const B_UNITS = 10n; // liquidity for the LMSR math / collateral STATE number (b·ln2 ≈ 693,147)
// The pool UTXO holds only DUST on-chain. The spike contract has no withdraw/redeem path yet (TOKEN-001)
// and doesn't bind collateral↔UTXO-sats, so any real sats locked here would be STUCK. Tx size/fee/throughput
// (unknowns #2/#6) don't depend on the amount, so dust gives a faithful measurement with negligible risk.
const DEPLOY_SATS = 1000;
const FEE_BUFFER = 50_000; // sats reserved for deploy + several buy fees + change
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

async function connect() {
  const provider = new WhatsOnChainProvider('mainnet');
  const signer = new LocalSigner(fundingWif());
  const address = await signer.getAddress();
  return { provider, signer, address };
}
const bsv = (sats: number): string => (sats / 1e8).toFixed(8);

async function balance(): Promise<void> {
  const { provider, address } = await connect();
  const utxos = await provider.getUtxos(address);
  const total = utxos.reduce((s, u) => s + u.satoshis, 0);
  console.log(`funding address: ${address}`);
  console.log(`balance:         ${total} sats = ${bsv(total)} BSV  (${utxos.length} utxo${utxos.length === 1 ? '' : 's'})`);
}

async function deploy(broadcast: boolean): Promise<void> {
  const artifact = compileMarket();
  const { collateral, constructorArgs, state0 } = marketSetup(B_UNITS);
  const need = DEPLOY_SATS + FEE_BUFFER;
  const { provider, signer, address } = await connect();
  const utxos = await provider.getUtxos(address);
  const total = utxos.reduce((s, u) => s + u.satoshis, 0);

  console.log(`deployer:      ${address}`);
  console.log(`balance:       ${total} sats (${bsv(total)} BSV)`);
  console.log(`pool UTXO:     ${DEPLOY_SATS} sats (DUST — real sats not locked; collateral=${collateral} is a state number)`);
  console.log(`need (+fees):  ~${need} sats`);
  if (total < need) {
    console.log(`\nINSUFFICIENT FUNDS. Send ~${bsv(need)} BSV to ${address}, then retry.`);
    return;
  }
  // RunarContract only builds the contract locking script; we assemble + sign the funding tx with @bsv/sdk
  // (runar-sdk's LocalSigner produces an invalid BSV sighash — see notes). @bsv/sdk's P2PKH template signs
  // SIGHASH_ALL|FORKID correctly.
  const contract = new RunarContract(artifact, [...constructorArgs]);
  const lockingScript = contract.getLockingScript();

  const priv = PrivateKey.fromWif(fundingWif());
  const funding = utxos[0]!;
  const srcHex = await provider.getRawTransaction(funding.txid);
  const sourceTransaction = Transaction.fromHex(srcHex);

  const tx = new Transaction();
  tx.addInput({ sourceTransaction, sourceOutputIndex: funding.outputIndex, unlockingScriptTemplate: new P2PKH().unlock(priv) });
  tx.addOutput({ lockingScript: Script.fromHex(lockingScript), satoshis: DEPLOY_SATS });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toAddress()), change: true });
  await tx.fee();
  await tx.sign();

  if (!broadcast) {
    console.log(`\n[DRY] Built the deploy tx: ${tx.toHex().length / 2} bytes, pool UTXO ${DEPLOY_SATS} sats + change.`);
    console.log('Re-run with --broadcast to send it to mainnet.');
    return;
  }
  console.log('\nBroadcasting pool deploy to MAINNET…');
  const txid = await provider.broadcast(tx);
  mkdirSync(DATA_DIR, { recursive: true });
  const rec = {
    txid, outputIndex: 0, satoshis: DEPLOY_SATS, bUnits: B_UNITS.toString(),
    state: Object.fromEntries(Object.entries(state0).map(([k, v]) => [k, String(v)])),
    lockingScript,
  };
  writeFileSync(join(DATA_DIR, 'deployment.json'), JSON.stringify(rec, null, 2));
  console.log(`DEPLOYED. txid: ${txid}`);
  console.log(`Pool UTXO: ${txid}:0 (${DEPLOY_SATS} sats). Saved to apps/spike/data/deployment.json`);
}

const POOL_FILE = join(DATA_DIR, 'pool.json');
const strState = (s: Record<string, bigint>): Record<string, string> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.toString()]));

/** Buy one YES unit against the live pool UTXO, chaining state in apps/spike/data/pool.json. */
async function buy(broadcast: boolean): Promise<void> {
  const artifact = compileMarket();
  const { p, mult } = marketSetup(B_UNITS);
  const src = existsSync(POOL_FILE) ? POOL_FILE : join(DATA_DIR, 'deployment.json');
  if (!existsSync(src)) { console.log('No deployment found — run `mainnet deploy --broadcast` first.'); return; }
  const rec = JSON.parse(readFileSync(src, 'utf8')) as {
    txid: string; outputIndex: number; satoshis: number; lockingScript: string; state: Record<string, string>;
  };

  const cur = { eYes: BigInt(rec.state.eYes!), eNo: BigInt(rec.state.eNo!), qYes: BigInt(rec.state.qYes!), qNo: BigInt(rec.state.qNo!) };
  const next = applyUnitBuy(cur, 'yes', mult, p);
  const charge = buyChargeApproxSats(next, 'yes', p.unit, p);
  const newMutable = {
    eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo,
    collateral: BigInt(rec.state.collateral!) + charge, resolved: 0n, winner: 0n,
  };

  console.log(`pool UTXO: ${rec.txid.slice(0, 16)}…:${rec.outputIndex} (${rec.satoshis} sats)`);
  console.log(`buy 1 YES → charge ${charge} sat (state); pool UTXO stays ${rec.satoshis} dust sats`);
  if (!broadcast) { console.log('[DRY] re-run with --broadcast to send the buy to mainnet.'); return; }

  const provider = new WhatsOnChainProvider('mainnet');
  const signer = new BsvSigner(fundingWif());
  const contract = RunarContract.fromUtxo(artifact, {
    txid: rec.txid, outputIndex: rec.outputIndex, satoshis: rec.satoshis, script: rec.lockingScript,
  });
  contract.connect(provider, signer);

  console.log('\nBroadcasting buyYes to MAINNET…');
  const { txid } = await contract.call('buyYes', [charge, BigInt(rec.satoshis)], { newState: newMutable, satoshis: rec.satoshis });
  const utxo = contract.getUtxo();
  writeFileSync(POOL_FILE, JSON.stringify({
    txid, outputIndex: utxo?.outputIndex ?? 0, satoshis: rec.satoshis,
    lockingScript: utxo?.script ?? contract.getLockingScript(), state: strState(newMutable), prevTxid: rec.txid,
  }, null, 2));
  console.log(`BOUGHT 1 YES. txid: ${txid}`);
}

const cmd = process.argv[2];
const broadcast = process.argv.includes('--broadcast');
const run =
  cmd === 'balance' ? balance()
  : cmd === 'deploy' ? deploy(broadcast)
  : cmd === 'buy' ? buy(broadcast)
  : Promise.resolve(console.log('usage: mainnet <balance | deploy [--broadcast] | buy [--broadcast]>'));
run.catch((e) => { console.error(String(e)); process.exit(1); });
