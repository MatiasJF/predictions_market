// FUND-001, the return leg — a winner must be able to SPEND what they won.
//
// The complaint that started this ticket was "no money ever leaves my wallet, and I never see anything arrive".
// The buy side is fixed by the payment gate. This is the other half: winnings used to be paid to
// `hash160(identity key)`, which no wallet watches. The satoshis were real and were genuinely the winner's, but
// nothing in their wallet knew about them — so in practice they were unspendable.
//
// A payout now goes to a one-time BRC-29 destination derived FOR the winner, and the daemon hands back the
// derivation so their wallet can internalize it as ordinary spendable balance. The test that matters is the
// last one: take the remittance, derive the key, and check it really does unlock the output that was paid.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { ExecutionEngine, makeReceiptSigner, signOrder, pkhOf } from '@pm/execution';
import { MarketService } from '../src/service.js';
import { paidBuy } from './helpers/pay.js';
import { OfflineChainCheck, derivePaymentKey, scopedNonces, BRC29_PROTOCOL, brc29KeyID } from '@pm/wallet';
import { KeyDeriver, P2PKH, PrivateKey } from '@bsv/sdk';

const PAYOUT_UNIT = 1000;
const UNITS = 3;

/** The operator's stake pot key. In production it comes from the environment; here it is ours to check against. */
let operatorKey: PrivateKey;
/** The winner's identity key — the key they traded with, and the only key that can claim the payout. */
let winnerKey: PrivateKey;

async function resolvedMarketWithAWinner() {
  operatorKey = PrivateKey.fromRandom();
  winnerKey = PrivateKey.fromRandom();

  const db: Db = openDb(':memory:');
  migrate(db);
  const exec = new ExecutionEngine(db, makeReceiptSigner());
  const svc = new MarketService(db, new MockEngine(), exec, operatorKey, new OfflineChainCheck());

  const m = await svc.createMarket({ question: 'Will X happen?', bUnits: 1000, payoutUnit: PAYOUT_UNIT });
  await svc.enqueueDeploy(m.id);
  const dep = db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='deploy'").get(m.id) as { id: number };
  await svc.authorize(dep.id);

  const trader = winnerKey.toPublicKey().toString();
  const fields = { marketId: m.id, trader, side: 'yes' as const, action: 'buy' as const, units: BigInt(UNITS), nonce: 1 };
  await paidBuy(svc, m.id, { trader, side: 'yes', units: UNITS, sig: signOrder(winnerKey.toWif(), fields), nonce: 1 });

  db.prepare("UPDATE markets SET resolution='yes', state='resolved' WHERE id=?").run(m.id);
  db.prepare('UPDATE pool_utxos SET resolved=1, winner=1 WHERE market_id=?').run(m.id);
  return { db, svc, marketId: m.id, trader };
}

/** Run the payout all the way through the sign-off queue, as an operator would. */
async function payWinners(db: Db, svc: MarketService, marketId: number) {
  await svc.enqueuePayout(marketId);
  const b = db.prepare("SELECT id FROM broadcasts WHERE market_id=? AND kind='payout'").get(marketId) as { id: number };
  return svc.authorize(b.id);
}

describe('FUND-001 — a winner can claim their payout into their own wallet', () => {
  let db: Db; let svc: MarketService; let marketId: number; let trader: string;
  beforeEach(async () => { ({ db, svc, marketId, trader } = await resolvedMarketWithAWinner()); });

  it('pays a derived destination, NOT the identity key hash a wallet cannot see', () => {
    const p = svc.payoutPreview(marketId) as any;
    expect(p.winners).toHaveLength(1);
    expect(p.winners[0].sats).toBe(UNITS * PAYOUT_UNIT);
    expect(
      p.winners[0].pkh,
      'paying hash160(identity key) is the bug this ticket exists to fix',
    ).not.toBe(pkhOf(trader));
  });

  it('derives the SAME destination every time, so the digest it commits to survives a restart', async () => {
    const first = (svc.payoutPreview(marketId) as any).winners[0];
    const firstDigest = (svc.payoutPreview(marketId) as any).digest;

    // A fresh service over the same database — the state a daemon restart leaves behind.
    const reopened = new MarketService(db, new MockEngine(), new ExecutionEngine(db, makeReceiptSigner()), operatorKey, new OfflineChainCheck());
    const again = (reopened.payoutPreview(marketId) as any);
    expect(again.winners[0].pkh).toBe(first.pkh);
    expect(again.digest, 'the payout commitment must not move under a restart').toBe(firstDigest);
  });

  it('records the remittance with the payment, and serves it to the winner', async () => {
    const res = await payWinners(db, svc, marketId);

    const { claims } = svc.payoutClaims(marketId, trader) as any;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ trader, sats: UNITS * PAYOUT_UNIT, txid: res.txid });
    expect(claims[0].remittance).toMatchObject({
      senderIdentityKey: operatorKey.toPublicKey().toString(),
    });
    expect(claims[0].remittance.derivationPrefix).toBeTruthy();
    expect(claims[0].remittance.derivationSuffix).toBeTruthy();
  });

  it('THE POINT: the remittance derives a key that unlocks the satoshis actually paid', async () => {
    await payWinners(db, svc, marketId);
    const { claims } = svc.payoutClaims(marketId, trader) as any;
    const claim = claims[0];

    // The winner's side of BRC-29: derive the private key from the operator's identity key + the nonces.
    const spendKey = derivePaymentKey(winnerKey, claim.remittance);

    // It must correspond to the hash160 the payout transaction actually paid — this is the whole claim.
    expect(spendKey.toPublicKey().toHash('hex')).toBe(claim.pkh);
    // …and the P2PKH the winner would rebuild from it is byte-identical to the one the payout tx pays.
    expect(new P2PKH().lock(spendKey.toPublicKey().toAddress()).toHex())
      .toBe(`76a914${claim.pkh}88ac`);
  });

  it('nobody else can derive it — including the operator, from the winner side', async () => {
    await payWinners(db, svc, marketId);
    const { claims } = svc.payoutClaims(marketId, trader) as any;
    const stranger = PrivateKey.fromRandom();
    expect(derivePaymentKey(stranger, claims[0].remittance).toPublicKey().toHash('hex')).not.toBe(claims[0].pkh);
  });

  it('matches what the operator derives as payer, so the two sides agree on one address', async () => {
    await payWinners(db, svc, marketId);
    const { claims } = svc.payoutClaims(marketId, trader) as any;
    const { prefix, suffix } = scopedNonces(`pm-payout:${marketId}:${trader}`);
    const asPayer = new KeyDeriver(operatorKey).derivePublicKey(BRC29_PROTOCOL, brc29KeyID(prefix, suffix), trader);
    expect(asPayer.toHash('hex')).toBe(claims[0].pkh);
  });

  it('reports no remittance for pre-FUND-001 payouts instead of a half-filled one', () => {
    db.prepare(
      `INSERT INTO payouts(market_id, trader_pubkey, pkh, shares, sats, payout_digest, txid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(marketId, trader, pkhOf(trader), '0', 500, 'de'.repeat(32), 'f'.repeat(64));
    const { claims } = svc.payoutClaims(marketId, trader) as any;
    expect(claims[0].remittance, 'a legacy payout has nothing to internalize — say so').toBeNull();
  });
});
