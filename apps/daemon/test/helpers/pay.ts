// FUND-001 test helper — place a PAID buy.
//
// Since the daemon collects the money before it fills, every test that wants a fill has to go through the real
// two-step: quote an intent, then hand back a transaction that pays it. Rather than scatter that dance across
// the suite, it lives here — so the tests stay about what they are testing, and there is exactly one place to
// change if the payment shape does.
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import type { MarketService } from '../../src/service.js';

/**
 * A transaction paying `sats` to a hex locking script — the shape a BRC-100 wallet's `createAction` produces.
 * A decoy output goes first deliberately, so output discovery is exercised rather than always finding index 0.
 */
export function buildPayment(scriptHex: string, sats: number): string {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 1 });
  tx.addOutput({ lockingScript: LockingScript.fromHex(scriptHex), satoshis: sats });
  return tx.toHex();
}

/** Quote an intent, pay it, and submit the order — the full funded-buy path in one call. */
export async function paidBuy(
  svc: MarketService,
  marketId: number,
  order: { trader: string; side: 'yes' | 'no'; units: number; sig: string; nonce: number; sigScheme?: 'ecdsa' | 'brc100' },
): Promise<Awaited<ReturnType<MarketService['submitOrder']>>> {
  const intent = await svc.createPaymentIntent(marketId, {
    trader: order.trader, side: order.side, action: 'buy', units: order.units,
  }) as { intent_id: number; locking_script: string; satoshis: number };

  return svc.submitOrder(marketId, {
    trader: order.trader,
    side: order.side,
    action: 'buy',
    units: order.units,
    sig: order.sig,
    nonce: order.nonce,
    ...(order.sigScheme ? { sigScheme: order.sigScheme } : {}),
    intentId: intent.intent_id,
    paymentTx: buildPayment(intent.locking_script, intent.satoshis),
  });
}
