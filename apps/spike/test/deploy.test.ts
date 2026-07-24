import { describe, it, expect } from 'vitest';
import { runDryRun } from '../src/measure.js';

// DEPLOY-001a — verifies the deploy/buy tooling builds real transactions offline (MockProvider) and
// records the tx sizes that answer feasibility unknown #6 (per-trade fee). No chain, no funds.
describe('DEPLOY-001a — offline deploy + buy transaction construction', () => {
  it('builds a deploy and sequential buys, with sane tx sizes', async () => {
    const r = await runDryRun(3, 0.05);
    // deploy tx is a real, non-trivial transaction
    expect(r.deployBytes).toBeGreaterThan(200);
    // 3 buys built
    expect(r.buyBytes).toHaveLength(3);
    for (const b of r.buyBytes) {
      // a stateful buy carries the OP_PUSH_TX preimage + continuation; expect a few KB, well under 100 KB
      expect(b).toBeGreaterThan(1000);
      expect(b).toBeLessThan(100_000);
    }
    // sequential buys have stable size (state is fixed-width) — within 1% of each other
    const [a, , c] = r.buyBytes;
    expect(Math.abs((c ?? 0) - (a ?? 0))).toBeLessThan((a ?? 1) * 0.01);
  });
});
