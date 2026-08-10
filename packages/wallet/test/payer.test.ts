// FUND-001 step 7b — paying a seller, out of the stakes.
//
// A sell is the market owing a trader money. Until now that debt was recorded and never paid: mainnet market #7
// booked 998 sat of proceeds with no code path able to send them. These tests cover the payment itself — that it
// spends real stake UTXOs, that the seller can actually spend what lands, and that it refuses rather than
// improvises when the pot is short.
import { describe, it, expect } from 'vitest';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { buildProceedsPayment, deriveDestination, derivePaymentKey, scopedNonces } from '../src/index.js';
import type { StakeUtxo } from '../src/index.js';

const potKey = PrivateKey.fromRandom();

/**
 * A stake as it exists after a trader pays: satoshis at a one-time BRC-29 address the pot can re-derive.
 * Built as a real transaction, because the payment we are testing has to sign against it.
 */
function stake(traderKey: PrivateKey, satoshis: number, scope: string): StakeUtxo {
  const dest = deriveDestination(traderKey, potKey.toPublicKey().toString(), scopedNonces(scope));
  const funding = new Transaction();
  // A decoy first, so the vout under test is never 0 by luck.
  funding.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 1 });
  funding.addOutput({ lockingScript: new P2PKH().lock(dest.address), satoshis });
  return { txid: funding.id('hex'), vout: 1, satoshis, remittance: dest.remittance, sourceRawTx: funding.toHex() };
}

describe('buildProceedsPayment', () => {
  const seller = PrivateKey.fromRandom();
  const sellerPub = seller.toPublicKey().toString();

  it('pays a seller out of staked satoshis, and the seller can spend what arrives', async () => {
    const stakes = [stake(PrivateKey.fromRandom(), 5_000, 'stake:1')];
    const p = await buildProceedsPayment(potKey, stakes, [{ trader: sellerPub, satoshis: 998, scope: 'sell:7:3' }]);

    expect(p.paid).toHaveLength(1);
    expect(p.paid[0]).toMatchObject({ trader: sellerPub, satoshis: 998, outputIndex: 0 });

    // THE POINT: the seller derives the key from the remittance and it unlocks the output they were paid.
    const key = derivePaymentKey(seller, p.paid[0]!.remittance);
    expect(key.toPublicKey().toHash('hex')).toBe(p.paid[0]!.pkh);

    const tx = Transaction.fromHex(p.rawTx);
    expect(tx.outputs[0]?.lockingScript.toHex()).toBe(`76a914${p.paid[0]!.pkh}88ac`);
    expect(tx.outputs[0]?.satoshis).toBe(998);
  });

  it('returns the remainder to the pot, so what is left is in one place and countable', async () => {
    const stakes = [stake(PrivateKey.fromRandom(), 5_000, 'stake:1')];
    const p = await buildProceedsPayment(potKey, stakes, [{ trader: sellerPub, satoshis: 998, scope: 'sell:7:3' }]);

    expect(p.changeSats).toBe(5_000 - 998 - p.feeSats);
    const tx = Transaction.fromHex(p.rawTx);
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[1]?.lockingScript.toHex())
      .toBe(new P2PKH().lock(potKey.toPublicKey().toAddress()).toHex());
  });

  it('spends several stakes at once when one is not enough', async () => {
    const stakes = [
      stake(PrivateKey.fromRandom(), 600, 'stake:1'),
      stake(PrivateKey.fromRandom(), 600, 'stake:2'),
    ];
    const p = await buildProceedsPayment(potKey, stakes, [{ trader: sellerPub, satoshis: 1_000, scope: 'sell:7:3' }]);
    expect(Transaction.fromHex(p.rawTx).inputs).toHaveLength(2);
  });

  it('pays several people in one transaction, each at their own destination', async () => {
    const other = PrivateKey.fromRandom();
    const otherPub = other.toPublicKey().toString();
    const p = await buildProceedsPayment(potKey, [stake(PrivateKey.fromRandom(), 9_000, 'stake:1')], [
      { trader: sellerPub, satoshis: 500, scope: 'sell:7:3' },
      { trader: otherPub, satoshis: 700, scope: 'sell:7:4' },
    ]);
    expect(p.paid.map((x) => x.outputIndex)).toEqual([0, 1]);
    expect(derivePaymentKey(seller, p.paid[0]!.remittance).toPublicKey().toHash('hex')).toBe(p.paid[0]!.pkh);
    expect(derivePaymentKey(other, p.paid[1]!.remittance).toPublicKey().toHash('hex')).toBe(p.paid[1]!.pkh);
    // Two people, two distinct one-time addresses — never a shared or reused one.
    expect(p.paid[0]!.pkh).not.toBe(p.paid[1]!.pkh);
  });

  it('derives the SAME destination for the same scope, so a rebuild after a restart pays the same address', async () => {
    const args = [{ trader: sellerPub, satoshis: 500, scope: 'sell:7:3' }];
    const a = await buildProceedsPayment(potKey, [stake(PrivateKey.fromRandom(), 9_000, 'stake:1')], args);
    const b = await buildProceedsPayment(potKey, [stake(PrivateKey.fromRandom(), 9_000, 'stake:2')], args);
    expect(a.paid[0]!.pkh).toBe(b.paid[0]!.pkh);
  });

  it('REFUSES when the pot cannot cover its own book, rather than paying some and not others', async () => {
    const stakes = [stake(PrivateKey.fromRandom(), 400, 'stake:1')];
    await expect(buildProceedsPayment(potKey, stakes, [{ trader: sellerPub, satoshis: 998, scope: 'sell:7:3' }]))
      .rejects.toThrow(/cannot cover its own book/);
  });

  it('REFUSES when the pot covers the debt but not the fee — a short fee is a stuck transaction', async () => {
    // Exactly the debt and nothing more: solvent on paper, unpayable in practice.
    const stakes = [stake(PrivateKey.fromRandom(), 998, 'stake:1')];
    await expect(buildProceedsPayment(potKey, stakes, [{ trader: sellerPub, satoshis: 998, scope: 'sell:7:3' }]))
      .rejects.toThrow(/cannot cover .* plus a .* fee/);
  });

  it('pays the miner minimum, not a multiple of it (ADR-038)', async () => {
    const p = await buildProceedsPayment(potKey, [stake(PrivateKey.fromRandom(), 9_000, 'stake:1')], [
      { trader: sellerPub, satoshis: 500, scope: 'sell:7:3' },
    ]);
    expect(p.feeSats).toBe(Math.max(1, Math.ceil((p.sizeBytes / 1000) * 100)));
  });
});
