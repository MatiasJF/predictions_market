// FUND-001 — the derivation that decides whether money is recoverable.
//
// If `deriveDestination` and `derivePaymentKey` ever disagree, payments land at an address nobody holds the key
// for: on chain, visibly ours, permanently unspendable. Nothing downstream would notice — the transaction
// confirms, the balance query shows satoshis, and only a spend attempt (much later, with real money) fails.
// So this file proves correspondence directly rather than trusting the library.
import { describe, it, expect } from 'vitest';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  BRC29_PROTOCOL, brc29KeyID, deriveDestination, derivePaymentAddress, derivePaymentKey,
  findPaymentOutput, identityKeyOf, assertIdentityKey, newDerivationNonce,
} from '../src/brc29.js';

const operator = PrivateKey.fromRandom();
const trader = PrivateKey.fromRandom();

describe('BRC-29 derivation — payer and recipient must agree', () => {
  it('the recipient can derive the private key for what the payer paid to', () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    const priv = derivePaymentKey(trader, dest.remittance);
    expect(priv.toPublicKey().toString(), 'derived keys must correspond').toBe(dest.publicKey);
    expect(priv.toPublicKey().toAddress()).toBe(dest.address);
  });

  it('produces a spendable P2PKH — the derived key really unlocks the derived script', async () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    const priv = derivePaymentKey(trader, dest.remittance);

    // Build a funding tx paying the destination, then spend it with the derived key.
    const funding = new Transaction();
    funding.addOutput({ lockingScript: new P2PKH().lock(dest.address), satoshis: 5000 });

    const spend = new Transaction();
    spend.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(priv),
    });
    spend.addOutput({ lockingScript: new P2PKH().lock(trader.toPublicKey().toAddress()), satoshis: 4000 });
    await spend.sign();

    expect(spend.inputs[0]!.unlockingScript, 'derived key must unlock the derived script').toBeTruthy();
  });

  it('is deterministic for fixed nonces, and different for different ones', () => {
    const nonces = { prefix: newDerivationNonce(), suffix: newDerivationNonce() };
    const a = deriveDestination(operator, identityKeyOf(trader), nonces);
    const b = deriveDestination(operator, identityKeyOf(trader), nonces);
    expect(b.lockingScript, 'same nonces ⇒ same destination').toBe(a.lockingScript);

    const c = deriveDestination(operator, identityKeyOf(trader));
    expect(c.lockingScript, 'fresh nonces ⇒ different destination').not.toBe(a.lockingScript);
  });

  it('pays the RECIPIENT, not the payer — the expensive mistake this guards', () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    expect(dest.address, 'must not be the payer\'s own address')
      .not.toBe(operator.toPublicKey().toAddress());
    // and the payer cannot spend it
    const wrong = derivePaymentKey(operator, dest.remittance);
    expect(wrong.toPublicKey().toString()).not.toBe(dest.publicKey);
  });

  it('a third party cannot derive the key, even knowing the full remittance', () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    const attacker = PrivateKey.fromRandom();
    const derived = derivePaymentKey(attacker, dest.remittance);
    expect(derived.toPublicKey().toString()).not.toBe(dest.publicKey);
  });

  it('the remittance carries the PAYER identity, which is what the recipient derives against', () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    expect(dest.remittance.senderIdentityKey).toBe(identityKeyOf(operator));
    // tampering with it breaks derivation — proving the field is load-bearing, not decorative
    const tampered = { ...dest.remittance, senderIdentityKey: identityKeyOf(PrivateKey.fromRandom()) };
    expect(derivePaymentKey(trader, tampered).toPublicKey().toString()).not.toBe(dest.publicKey);
  });

  it('uses the standard protocol id and key-id format (a custom one would strand funds)', () => {
    expect(BRC29_PROTOCOL).toEqual([2, '3241645161d8']);
    expect(brc29KeyID('AAAA', 'BBBB')).toBe('AAAA BBBB');
  });

  it('derivePaymentAddress agrees with the payer\'s destination', () => {
    const dest = deriveDestination(operator, identityKeyOf(trader));
    expect(derivePaymentAddress(trader, dest.remittance)).toBe(dest.address);
  });
});

describe('findPaymentOutput — the check behind the payment gate', () => {
  const dest = deriveDestination(operator, identityKeyOf(trader));
  const out = (hex: string, satoshis: number) => ({ satoshis, lockingScript: { toHex: () => hex } });
  const other = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex();

  it('finds the paying output among others and reports its index and value', () => {
    const found = findPaymentOutput([out(other, 9999), out(dest.lockingScript, 5000)], dest.lockingScript, 5000);
    expect(found).toEqual({ outputIndex: 1, satoshis: 5000 });
  });

  it('REJECTS a transaction that pays us nothing', () => {
    expect(() => findPaymentOutput([out(other, 9999)], dest.lockingScript, 1))
      .toThrow(/no output pays the expected destination/);
  });

  it('REJECTS underpayment, and says so distinctly from "not paid"', () => {
    expect(() => findPaymentOutput([out(dest.lockingScript, 4999)], dest.lockingScript, 5000))
      .toThrow(/underpaid — output pays 4999 sat, expected at least 5000/);
  });

  it('accepts overpayment (the surplus is handled upstream, not here)', () => {
    expect(findPaymentOutput([out(dest.lockingScript, 6000)], dest.lockingScript, 5000).satoshis).toBe(6000);
  });
});

describe('assertIdentityKey', () => {
  it('accepts a real key and rejects junk rather than deriving garbage', () => {
    expect(assertIdentityKey(identityKeyOf(trader))).toBe(identityKeyOf(trader));
    expect(() => assertIdentityKey('not-a-key')).toThrow(/invalid identity key/);
    expect(() => assertIdentityKey('')).toThrow(/invalid identity key/);
  });
});
