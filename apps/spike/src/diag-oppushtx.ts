// Diagnostic for BUG-002: compare runar-sdk's OP_PUSH_TX BIP-143 preimage against a from-scratch,
// spec-correct preimage for the contract input, and print which field diverges. Offline, no broadcast.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hash, Utils, PrivateKey, P2PKH, Script, Spend } from '@bsv/sdk';
import { WhatsOnChainProvider, RunarContract } from 'runar-sdk';
import { applyUnitBuy, buyChargeApproxSats } from '@pm/lmsr';
import { compileMarket, marketSetup } from './market.js';
import { BsvSigner } from './bsv-signer.js';
import { fundingWif } from './env.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const le = (n: number, bytes: number): number[] => { const o: number[] = []; for (let i = 0; i < bytes; i++) { o.push(n & 0xff); n = Math.floor(n / 256); } return o; };
const leHexToBytes = (txidBE: string): number[] => Utils.toArray(txidBE, 'hex').reverse();
const varint = (n: number): number[] => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, (n >> 8) & 0xff] : [0xfe, ...le(n, 4)];
const hash256 = (b: number[]): number[] => Hash.hash256(b);
const hex = (b: number[]): string => Utils.toHex(b);

async function main(): Promise<void> {
  const artifact = compileMarket();
  const { p, mult } = marketSetup(10n);
  const rec = JSON.parse(readFileSync(join(DATA_DIR, 'deployment.json'), 'utf8')) as {
    txid: string; outputIndex: number; satoshis: number; lockingScript: string; state: Record<string, string>;
  };
  const cur = { eYes: BigInt(rec.state.eYes!), eNo: BigInt(rec.state.eNo!), qYes: BigInt(rec.state.qYes!), qNo: BigInt(rec.state.qNo!) };
  const next = applyUnitBuy(cur, 'yes', mult, p);
  const charge = buyChargeApproxSats(next, 'yes', p.unit, p);
  const newMutable = { eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral: BigInt(rec.state.collateral!) + charge, resolved: 0n, winner: 0n };

  const provider = new WhatsOnChainProvider('mainnet');
  const contract = RunarContract.fromUtxo(artifact, { txid: rec.txid, outputIndex: rec.outputIndex, satoshis: rec.satoshis, script: rec.lockingScript });
  contract.connect(provider, new BsvSigner(fundingWif()));

  const prepared = await contract.prepareCall('buyYes', [charge, BigInt(rec.satoshis)], { newState: newMutable, satoshis: rec.satoshis });
  const runarPreimage = prepared.preimage;
  const tx = prepared.tx;

  // Contract input is index 0. Build the spec-correct BIP-143 preimage.
  const ls = rec.lockingScript;
  const firstCodeSep = Utils.toArray(ls, 'hex').indexOf(0xab); // OP_CODESEPARATOR for the first (buyYes) branch
  const scriptCode = Utils.toArray(ls.slice((firstCodeSep + 1) * 2), 'hex');

  const inputs = tx.inputs.map((i) => ({ txid: i.sourceTXID as string, vout: i.sourceOutputIndex as number, seq: (i.sequence ?? 0xffffffff) as number }));
  const outputs = tx.outputs.map((o) => ({ sats: o.satoshis as number, script: (o.lockingScript!.toHex() as string) }));

  const hashPrevouts = hash256(inputs.flatMap((i) => [...leHexToBytes(i.txid), ...le(i.vout, 4)]));
  const hashSequence = hash256(inputs.flatMap((i) => le(i.seq, 4)));
  const hashOutputs = hash256(outputs.flatMap((o) => { const sb = Utils.toArray(o.script, 'hex'); return [...le(o.sats, 4), ...le(Math.floor(o.sats / 2 ** 32), 4), ...varint(sb.length), ...sb]; }));

  const c = inputs[0]!;
  const preimage = [
    ...le(tx.version, 4),
    ...hashPrevouts,
    ...hashSequence,
    ...leHexToBytes(c.txid), ...le(c.vout, 4),
    ...varint(scriptCode.length), ...scriptCode,
    ...le(rec.satoshis, 4), ...le(Math.floor(rec.satoshis / 2 ** 32), 4),
    ...le(c.seq, 4),
    ...hashOutputs,
    ...le(tx.lockTime, 4),
    ...le(0x41, 4),
  ];
  const correct = hex(preimage);

  console.log('codeSeparator (0xab) byte index:', firstCodeSep, '| scriptCode bytes:', scriptCode.length);
  console.log('runar preimage len:', runarPreimage.length / 2, '| correct len:', correct.length / 2);
  console.log('MATCH:', runarPreimage.toLowerCase() === correct.toLowerCase());
  if (runarPreimage.toLowerCase() !== correct.toLowerCase()) {
    // find first differing byte
    let i = 0; const a = runarPreimage.toLowerCase(), b = correct.toLowerCase();
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.log('first diff at hex char', i, '(byte', Math.floor(i / 2) + ')');
    console.log('runar  :', a.slice(Math.max(0, i - 8), i + 24));
    console.log('correct:', b.slice(Math.max(0, i - 8), i + 24));
    // annotate section by byte offset
    const off = Math.floor(i / 2);
    const scLen = scriptCode.length; const scStart = 4 + 32 + 32 + 36; const scEnd = scStart + varint(scLen).length + scLen;
    const section = off < 4 ? 'version' : off < 40 ? 'hashPrevouts' : off < 72 ? 'hashSequence' : off < 108 ? 'outpoint'
      : off < scEnd ? 'scriptCode' : off < scEnd + 8 ? 'amount' : off < scEnd + 12 ? 'sequence' : off < scEnd + 44 ? 'hashOutputs' : off < scEnd + 48 ? 'locktime' : 'sighashType';
    console.log('→ diverging section:', section);
  }

  // --- Re-sign funding inputs with @bsv/sdk (as buy() does), then locally validate EACH input via Spend ---
  const priv = PrivateKey.fromWif(fundingWif());
  const fundingLock = new P2PKH().lock(priv.toAddress()); // getUtxos returns empty .script → build it
  const utxos = await provider.getUtxos(priv.toAddress());
  const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.outputIndex}`, u]));
  for (let i = 1; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i]!;
    const u = byOutpoint.get(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
    if (u) inp.unlockingScript = await new P2PKH().unlock(priv, 'all', false, u.satoshis, fundingLock).sign(tx, i);
  }

  const validateInput = (i: number, srcSats: number, lockHex: string): void => {
    const spend = new Spend({
      sourceTXID: tx.inputs[i]!.sourceTXID ?? '', sourceOutputIndex: tx.inputs[i]!.sourceOutputIndex, sourceSatoshis: srcSats,
      lockingScript: Script.fromHex(lockHex), transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_x, j) => j !== i), inputIndex: i,
      unlockingScript: tx.inputs[i]!.unlockingScript!, outputs: tx.outputs,
      inputSequence: tx.inputs[i]!.sequence ?? 0xffffffff, lockTime: tx.lockTime,
    });
    try { console.log(`input ${i}: VALID = ${spend.validate()}`); }
    catch (e) { console.log(`input ${i}: FAILED — ${String(e).slice(0, 260)}`); }
  };

  console.log('\n--- tx inputs ---');
  tx.inputs.forEach((inp, i) => {
    const u = byOutpoint.get(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
    console.log(`input ${i}: ${String(inp.sourceTXID).slice(0, 12)}…:${inp.sourceOutputIndex} funding=${!!u} unlockChunks=${inp.unlockingScript?.chunks.length} unlockLen=${(inp.unlockingScript?.toHex().length ?? 0) / 2}`);
    if (u) console.log(`   funding lockingScript: ${u.script}`);
  });

  console.log('\n--- local Spend validation (offline) ---');
  validateInput(0, rec.satoshis, rec.lockingScript); // contract input
  for (let i = 1; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i]!;
    const u = byOutpoint.get(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
    if (u) validateInput(i, u.satoshis, fundingLock.toHex()); // funding input (built P2PKH lock)
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
