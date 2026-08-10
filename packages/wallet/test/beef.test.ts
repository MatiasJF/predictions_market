// FUND-001 step 7 — the proof a wallet demands before it will accept money.
//
// A winner's payout is already theirs; their wallet just does not know the output exists. `internalizeAction`
// fixes that, but it takes the transaction as **AtomicBEEF** — the wallet verifies the payment itself rather
// than trusting whoever handed it over. These tests cover the two halves of producing that: locating the right
// output, and (against the real chain, on request) actually assembling the proof.
import { describe, it, expect } from 'vitest';
import { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { NoBeefSource, ToolboxBeefSource, outputPayingPkh } from '../src/index.js';

/** A mined transaction paying `pkh`, in the form a wallet is handed. Decoys either side of the real output. */
function minedPaymentBeef(pkh: string, sats: number): string {
  const decoy = () => new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress());
  const tx = new Transaction();
  tx.addOutput({ lockingScript: decoy(), satoshis: 1 });
  tx.addOutput({ lockingScript: LockingScript.fromHex(`76a914${pkh}88ac`), satoshis: sats });
  tx.addOutput({ lockingScript: decoy(), satoshis: 1 });
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]]);
  return Buffer.from(tx.toAtomicBEEF()).toString('hex');
}

describe('outputPayingPkh', () => {
  const pkh = 'ab'.repeat(20);

  it('finds the output that pays a winner, past decoys on both sides', () => {
    expect(outputPayingPkh(minedPaymentBeef(pkh, 4000), pkh)).toEqual({ outputIndex: 1, satoshis: 4000 });
  });

  it('refuses rather than guessing when nothing pays that key', () => {
    expect(() => outputPayingPkh(minedPaymentBeef(pkh, 4000), 'cd'.repeat(20)))
      .toThrow(/no output pays the expected destination/);
  });
});

describe('NoBeefSource', () => {
  it('admits it has nothing, so an offline daemon says "not yet" instead of inventing a proof', async () => {
    expect(await new NoBeefSource().atomicBeef()).toBeUndefined();
  });
});

// Hits WhatsOnChain. Off by default so the suite stays offline and deterministic:
//   PM_CHAIN_E2E=1 pnpm vitest run packages/wallet/test/beef.test.ts
const CHAIN = process.env.PM_CHAIN_E2E === '1';
describe.skipIf(!CHAIN)('ToolboxBeefSource against mainnet', () => {
  // A REAL payout this project made (live-mainnet.db): 8 winners, 4,000 sat each.
  const TXID = '4332b02491a588005fdc2da67418a95eea96a04b275205e0045efd119efad7b4';

  it('assembles AtomicBEEF for a real payout and locates a winner', async () => {
    const src = new ToolboxBeefSource('main');
    const beef = await src.atomicBeef(TXID);
    expect(beef, 'no BEEF came back for a mined transaction').toBeTruthy();
    expect(outputPayingPkh(beef!, '595df4de46a710fa986d239d294c2ace501e73f1')).toEqual({ outputIndex: 2, satoshis: 4000 });
    expect(await src.atomicBeef(TXID), 'a mined transaction should be cached, not refetched').toBe(beef);
  }, 60_000);

  it('does not let the toolbox rewrite the environment on import', async () => {
    // The toolbox calls `dotenv.config({ override: true })` when it loads, which re-reads this repo's `.env`
    // over the running process. The daemon reads PM_NETWORK per request to decide whether to show the MAINNET
    // warning — so without containment, a winner clicking "claim" could flip that warning. See `load()`.
    process.env.PM_NETWORK = 'local';
    delete process.env.PM_FUNDING_WIF;
    await new ToolboxBeefSource('main').atomicBeef(TXID);
    expect(process.env.PM_NETWORK, 'PM_NETWORK was overwritten by importing the toolbox').toBe('local');
    expect(process.env.PM_FUNDING_WIF, 'a funding WIF appeared in a process started without one').toBeUndefined();
  }, 60_000);
});
