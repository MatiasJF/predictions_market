// MAINNET-014 — a balance must count money already on its way out.
//
// Summing an address's unspent outputs overstates it whenever a spend is pending: the list still
// holds the inputs the mempool transaction is spending AND the change it creates. After two deploys
// costing 8,148 sat the operator's panel read 405,270 against a real 198,615 — reassuring at exactly
// the moment an operator checks it to decide whether to authorize the next spend.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WocChainCheck } from '../src/verify.js';

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

/** WoC reports `unconfirmed` as a NET delta — negative while a spend is in flight. */
function mockBalances(confirmed: number, unconfirmed: number) {
  globalThis.fetch = vi.fn(async (url: any) => ({
    ok: true,
    json: async () => (String(url).includes('/confirmed/balance') ? { confirmed } : { unconfirmed }),
  })) as any;
}

describe('WocChainCheck.balanceOf', () => {
  it('nets pending spends out of the headline figure', async () => {
    // The real numbers from 2026-08-11: 206,763 confirmed, two deploys costing 8,148 in the mempool.
    mockBalances(206_763, -8_148);
    const b = await new WocChainCheck('main').balanceOf('1GfBrmSWX9jrMPJ2jUjkyhVs1gMj8E8PBD');
    expect(b.spendable, 'the panel used to read 405,270 here').toBe(198_615);
    expect(b.confirmed).toBe(206_763);
    expect(b.unconfirmed).toBe(-8_148);
  });

  it('equals the confirmed balance when nothing is pending', async () => {
    mockBalances(198_507, 0);
    const b = await new WocChainCheck('main').balanceOf('1GfBrmSWX9jrMPJ2jUjkyhVs1gMj8E8PBD');
    expect(b.spendable).toBe(198_507);
  });

  it('counts incoming money too, not only outgoing', async () => {
    // A top-up sitting in the mempool is spendable-ish and should not be invisible.
    mockBalances(151_245, 200_000);
    const b = await new WocChainCheck('main').balanceOf('addr');
    expect(b.spendable).toBe(351_245);
  });
});

// A mock can only prove the arithmetic; it cannot prove the endpoint paths or field names are real.
// Behind a flag so the suite stays offline: PM_CHAIN_E2E=1 pnpm vitest run packages/wallet/test/balance.test.ts
describe.skipIf(process.env.PM_CHAIN_E2E !== '1')('against the real WhatsOnChain', () => {
  it('reads the operator funding address', async () => {
    const b = await new WocChainCheck('main').balanceOf('1GfBrmSWX9jrMPJ2jUjkyhVs1gMj8E8PBD');
    expect(Number.isFinite(b.confirmed), 'confirmed must be a number, not undefined').toBe(true);
    expect(Number.isFinite(b.unconfirmed)).toBe(true);
    expect(b.spendable).toBe(b.confirmed + b.unconfirmed);
    console.log(`  live: confirmed ${b.confirmed}, pending ${b.unconfirmed}, spendable ${b.spendable}`);
  }, 30_000);
});
