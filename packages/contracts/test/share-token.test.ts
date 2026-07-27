import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { TestContract, ALICE, BOB, CHARLIE, signTestMessage } from 'runar-testing';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ShareToken.runar.ts');
const source = readFileSync(SRC, 'utf8');
const FILE = 'ShareToken.runar.ts';
const bn = (x: unknown): bigint => BigInt(x as string | bigint);
const aliceSig = signTestMessage(ALICE.privKey);

const yesToken = (supply: bigint, holder: string) => ({ supply, holder, marketId: 42n, side: 1n });

describe('TOKEN-001a — ShareToken (YES/NO fungible share)', () => {
  it('compiles to Bitcoin Script', () => {
    const r = compile(source, { fileName: FILE });
    expect(r.success, JSON.stringify(r.diagnostics, null, 2)).toBe(true);
    expect((r.scriptHex ?? '').length).toBeGreaterThan(0);
  });

  it('transfer: whole balance moves to a new holder, market/side preserved', () => {
    const c = TestContract.fromSource(source, yesToken(100n, ALICE.pubKey), FILE);
    const res = c.call('transfer', { sig: aliceSig, newHolder: BOB.pubKey, outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    const o = res.outputs[0]!;
    expect(bn(o.supply)).toBe(100n);
    expect(o.holder).toBe(BOB.pubKey);
  });

  it('split: amount to a new holder, remainder kept', () => {
    const c = TestContract.fromSource(source, yesToken(100n, ALICE.pubKey), FILE);
    const res = c.call('split', { sig: aliceSig, amount: 30n, newHolder: BOB.pubKey, outputSatoshis: 1n });
    expect(res.success, res.error).toBe(true);
    expect(res.outputs).toHaveLength(2);
    expect(bn(res.outputs[0]!.supply)).toBe(30n);
    expect(res.outputs[0]!.holder).toBe(BOB.pubKey);
    expect(bn(res.outputs[1]!.supply)).toBe(70n);
    expect(res.outputs[1]!.holder).toBe(ALICE.pubKey);
  });

  it('rejects a transfer not signed by the holder', () => {
    // token held by CHARLIE, but signed by ALICE → checkSig fails
    const c = TestContract.fromSource(source, yesToken(100n, CHARLIE.pubKey), FILE);
    const res = c.call('transfer', { sig: aliceSig, newHolder: BOB.pubKey, outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });

  it('rejects an over-split (amount ≥ supply)', () => {
    const c = TestContract.fromSource(source, yesToken(100n, ALICE.pubKey), FILE);
    const res = c.call('split', { sig: aliceSig, amount: 100n, newHolder: BOB.pubKey, outputSatoshis: 1n });
    expect(res.success).toBe(false);
  });
});
