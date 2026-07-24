import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { TestContract } from 'runar-testing';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Counter.runar.ts');
const source = readFileSync(SRC, 'utf8');
const FILE = 'Counter.runar.ts';

describe('CONTRACT-001 gate — Rúnar compiles + executes a stateful contract (offline)', () => {
  it('compiles Counter to Bitcoin Script', () => {
    const r = compile(source, { fileName: FILE });
    // compile() never throws; assert no error diagnostics, dumping them if any.
    expect(r.success, JSON.stringify(r.diagnostics, null, 2)).toBe(true);
    expect(typeof r.scriptHex).toBe('string');
    expect((r.scriptHex ?? '').length).toBeGreaterThan(0);
    expect((r.scriptAsm ?? '').length).toBeGreaterThan(0);
  });

  it('executes increment() advancing state 0 → 1 → 2 via OP_PUSH_TX continuation', () => {
    const c = TestContract.fromSource(source, { count: 0n }, FILE);
    expect(c.state.count).toBe(0n);

    const r1 = c.call('increment');
    expect(r1.success, r1.error).toBe(true);
    expect(c.state.count).toBe(1n);

    const r2 = c.call('increment');
    expect(r2.success, r2.error).toBe(true);
    expect(c.state.count).toBe(2n);
  });
});
