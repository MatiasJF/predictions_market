import { describe, it, expect } from 'vitest';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { openDb, migrate, type Db } from '@pm/persistence';
import { WAD, type MarketParams } from '@pm/lmsr';
import { ExecutionEngine, WifReceiptSigner, signOrder, verifyOrder, orderPayload, ORDER_PROTOCOL_ID, orderKeyID, type SignedOrderFields } from '../src/index.js';

// LIVE-001a — orders must be authenticated by the trader. Before this the engine accepted any trader pubkey as
// a plain string, so the OPERATOR could fabricate fills in a user's name. These tests are the security
// properties, not happy-path coverage.
const P: MarketParams = { b: 1000n * WAD, payoutUnit: 100_000n, unit: WAD };
const MARKET = 1;

const alice = PrivateKey.fromRandom();
const bob = PrivateKey.fromRandom();
const alicePub = alice.toPublicKey().toDER('hex') as string;
const bobPub = bob.toPublicKey().toDER('hex') as string;

function fresh(): { db: Db; eng: ExecutionEngine } {
  const db = openDb(':memory:');
  migrate(db);
  // FUND-001: these predate the money leg and exercise LMSR/receipt/settlement mechanics, not funding.
  // Funding is proven in `funding.test.ts`; opting out explicitly here keeps each test about one thing.
  const eng = new ExecutionEngine(db, new WifReceiptSigner(PrivateKey.fromRandom().toWif()), true, false);
  eng.openMarket(MARKET, P);
  return { db, eng };
}
const fields = (trader: string, nonce: number): SignedOrderFields => ({
  marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce,
});

describe('trader-authenticated orders (LIVE-001a)', () => {
  it('fills an order the trader actually signed', async () => {
    const { db, eng } = fresh();
    const f = fields(alicePub, 1);
    const sr = await eng.submit({ ...f, sig: signOrder(alice.toWif(), f), ts: 1 });
    expect(sr.receipt.trader).toBe(alicePub);

    const row = db.prepare('SELECT order_sig, nonce FROM exec_orders WHERE seq=1').get() as
      { order_sig: string | null; nonce: number | null };
    expect(row.order_sig, "the trader's authorization is persisted").toBeTruthy();
    expect(row.nonce).toBe(1);
  });

  it('REJECTS an unsigned order (the operator cannot fabricate a fill)', async () => {
    const { db, eng } = fresh();
    await expect(
      eng.submit({ ...fields(alicePub, 1), ts: 1 })
    ).rejects.toThrow(/signature and nonce/);
    expect((db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(0);
  });

  it('REJECTS a forged signature', async () => {
    const { eng } = fresh();
    const f = fields(alicePub, 1);
    const forged = signOrder(bob.toWif(), f); // bob signs alice's order
    await expect(eng.submit({ ...f, sig: forged, ts: 1 })).rejects.toThrow(/bad trader signature/);
  });

  it('REJECTS impersonation: a valid signature from A submitted under B', async () => {
    const { eng } = fresh();
    const aliceOrder = fields(alicePub, 1);
    const aliceSig = signOrder(alice.toWif(), aliceOrder);
    // same signature, but the order now claims to be bob's
    await expect(
      eng.submit({ ...fields(bobPub, 1), sig: aliceSig, ts: 1 })
    ).rejects.toThrow(/bad trader signature/);
  });

  it('REJECTS a replayed order (same nonce twice)', async () => {
    const { db, eng } = fresh();
    const f = fields(alicePub, 7);
    const sig = signOrder(alice.toWif(), f);
    await eng.submit({ ...f, sig, ts: 1 });
    await expect(eng.submit({ ...f, sig, ts: 2 })).rejects.toThrow(); // UNIQUE(market,trader,nonce)
    expect((db.prepare('SELECT COUNT(*) c FROM exec_orders').get() as { c: number }).c).toBe(1);
  });

  it('detects any tampering with the signed order fields', async () => {
    const f = fields(alicePub, 3);
    const sig = signOrder(alice.toWif(), f);
    expect(await verifyOrder(f, sig)).toBe(true);
    expect(await verifyOrder({ ...f, units: 100n }, sig), 'size tampered').toBe(false);
    expect(await verifyOrder({ ...f, side: 'no' }, sig), 'side tampered').toBe(false);
    expect(await verifyOrder({ ...f, action: 'sell' }, sig), 'action tampered').toBe(false);
    expect(await verifyOrder({ ...f, nonce: 4 }, sig), 'nonce tampered').toBe(false);
  });
});

// UI-001 — BRC-100 wallet signing. This is what lets a trader use a REAL wallet: they sign in their own wallet
// with counterparty:'anyone', and the daemon verifies from their public identity key alone — no wallet, no
// private key, no callback. The security properties must hold identically to the ECDSA path.
describe('BRC-100 wallet-signed orders (UI-001)', () => {
  const walletOf = (priv: PrivateKey) => new ProtoWallet(priv);
  const traderPriv = PrivateKey.fromRandom();

  async function identityOf(priv: PrivateKey): Promise<string> {
    const { publicKey } = await walletOf(priv).getPublicKey({ identityKey: true });
    return publicKey;
  }
  /** Exactly what the browser does: sign the order payload in the wallet. */
  async function walletSign(priv: PrivateKey, f: SignedOrderFields): Promise<string> {
    const { signature } = await walletOf(priv).createSignature({
      data: Utils.toArray(orderPayload(f), 'utf8'),
      protocolID: ORDER_PROTOCOL_ID,
      keyID: orderKeyID(f.nonce),
      counterparty: 'anyone',
    });
    return Utils.toHex(signature);
  }

  it('a wallet-signed order verifies server-side WITHOUT the wallet', async () => {
    const trader = await identityOf(traderPriv);
    const f: SignedOrderFields = { marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce: 1 };
    expect(await verifyOrder(f, await walletSign(traderPriv, f), 'brc100')).toBe(true);
  });

  it('fills through the engine and records the scheme', async () => {
    const { db, eng } = fresh();
    const trader = await identityOf(traderPriv);
    const f: SignedOrderFields = { marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce: 5 };
    const sr = await eng.submit({ ...f, sig: await walletSign(traderPriv, f), sigScheme: 'brc100', ts: 1 });
    expect(sr.receipt.trader).toBe(trader);
    const row = db.prepare('SELECT sig_scheme FROM exec_orders WHERE seq=1').get() as { sig_scheme: string };
    expect(row.sig_scheme).toBe('brc100');
  });

  it('REJECTS tampering with any signed field', async () => {
    const trader = await identityOf(traderPriv);
    const f: SignedOrderFields = { marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce: 2 };
    const sig = await walletSign(traderPriv, f);
    expect(await verifyOrder({ ...f, units: 50n }, sig, 'brc100'), 'size').toBe(false);
    expect(await verifyOrder({ ...f, side: 'no' }, sig, 'brc100'), 'side').toBe(false);
    expect(await verifyOrder({ ...f, action: 'sell' }, sig, 'brc100'), 'action').toBe(false);
  });

  it('REJECTS impersonation (another identity key cannot claim the signature)', async () => {
    const trader = await identityOf(traderPriv);
    const f: SignedOrderFields = { marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce: 3 };
    const sig = await walletSign(traderPriv, f);
    const other = await identityOf(PrivateKey.fromRandom());
    expect(await verifyOrder({ ...f, trader: other }, sig, 'brc100')).toBe(false);
  });

  it('REJECTS an ECDSA signature presented as brc100 (and vice versa)', async () => {
    const trader = await identityOf(traderPriv);
    const f: SignedOrderFields = { marketId: MARKET, trader, side: 'yes', action: 'buy', units: 1n, nonce: 4 };
    const walletSig = await walletSign(traderPriv, f);
    expect(await verifyOrder(f, walletSig, 'ecdsa'), 'wallet sig under ecdsa').toBe(false);
    const rawSig = signOrder(traderPriv.toWif(), { ...f, trader: traderPriv.toPublicKey().toDER('hex') as string });
    expect(await verifyOrder(f, rawSig, 'brc100'), 'ecdsa sig under brc100').toBe(false);
  });
});
