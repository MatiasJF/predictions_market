import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Signer } from '../signer';
import { AmountPad, Button, Icon, KeyValue, Sheet, StatusMessage, TxLink, type Status } from '../ui';

/**
 * The one place a stake is entered and placed, used by every route into a trade — the deck, a market
 * card, the market detail. Having exactly one of these is the point: a buy is the only action in
 * this app that spends a trader's own money, and it should not have three implementations that can
 * drift apart.
 *
 * The amount gets the whole sheet, because the amount IS the decision. What it costs and what it
 * pays if it wins are stated before the button, not after it.
 *
 * There is deliberately no slide-to-confirm here. The trader's own wallet raises its own approval
 * dialog with the amount and will not spend without it; putting a second ceremony in front of that
 * teaches people to dismiss ceremonies. The slider lives on the operator side, where the daemon
 * signs with its own key and nothing else stands between a click and a broadcast.
 */
export function StakeSheet({
  open, onClose, market, side, signer, isMainnet, onFilled,
}: {
  open: boolean; onClose: () => void; market: any; side: 'yes' | 'no';
  signer?: Signer; isMainnet?: boolean; onFilled?: () => void;
}) {
  const [units, setUnits] = useState(1);
  const [quote, setQuote] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'idle' | 'quoting' | 'approving' | 'filling'>('idle');
  const [msg, setMsg] = useState<Status | undefined>();
  // The transaction the trader just made. Kept so the success state can point straight at it.
  const [done, setDone] = useState<{ txid: string; sats: number; units: number } | undefined>();

  // Re-price whenever the size or side changes. The LMSR price moves with every other fill, so a
  // quote is a snapshot, not a promise — which is exactly why the daemon re-checks it at fill time.
  useEffect(() => {
    if (!open || !market) return;
    let live = true;
    void api.quote(market.id, side, units).then((q) => { if (live) setQuote(q); }).catch(() => {});
    return () => { live = false; };
  }, [open, market?.id, side, units]);

  useEffect(() => { if (open) { setMsg(undefined); setDone(undefined); setUnits(1); } }, [open]);

  const devKey = signer?.kind === 'local';

  async function place() {
    if (!signer || !market) return;
    setBusy(true); setMsg(undefined);
    try {
      const trader = await signer.identityKey();
      const nonce = Date.now();
      const { sig, sigScheme } = await signer.signOrder({ marketId: market.id, trader, side, action: 'buy', units, nonce });

      setStep('quoting');
      const intent = await api.paymentIntent(market.id, { trader, side, action: 'buy', units });

      // MAINNET-012 — do not pay twice for one order.
      //
      // If this order was already paid and something later failed, the daemon returns the SAME quote
      // with the funding transaction attached. Asking the wallet again would send a second payment
      // for one position and strand the first, which is how 1,002 sat was lost on mainnet. The retry
      // is now free: it reuses what is already on the network.
      let paymentTx: string;
      if (intent.already_paid && intent.payment_tx) {
        setStep('filling');
        paymentTx = intent.payment_tx;
      } else {
        setStep('approving');
        paymentTx = (await signer.pay({
          lockingScript: intent.locking_script,
          satoshis: intent.satoshis,
          description: `${units} ${side.toUpperCase()} @ market #${market.id}`,
        })).rawTx;
        setStep('filling');
      }

      const r = await api.submitOrder(market.id, {
        trader, side, action: 'buy', units, nonce, sig, sigScheme,
        intentId: intent.intent_id, paymentTx,
      });
      // The txid comes from the transaction we already hold — no extra request, and it is the one
      // thing a person wants immediately after paying: proof, that they can go and look at.
      const { Transaction } = await import('@bsv/sdk');
      setDone({ txid: Transaction.fromHex(paymentTx).id('hex') as string, sats: r.receipt.costSats, units });
      onFilled?.();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setStep('idle'); setBusy(false);
    }
  }

  if (!market) return null;
  const price = market.prices?.[`${side}_sats`] ?? 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={done ? 'Done' : `Back ${side.toUpperCase()}`}
      footer={done ? (
        <Button variant="primary" tone="accent" size="lg" full onClick={onClose}>Done</Button>
      ) : (
        <>
          <Button
            variant="primary" tone={side === 'yes' ? 'positive' : 'negative'} size="lg" full
            busy={busy} disabled={busy || !signer || devKey} onClick={() => void place()}
          >
            {step === 'quoting' ? 'getting a price…'
              : step === 'approving' ? 'approve in your wallet…'
              : step === 'filling' ? 'filling…'
              : `pay & buy ${units} ${side.toUpperCase()}`}
          </Button>
          <StatusMessage status={msg} />
          {devKey && (
            <p className="tiny warning-text">
              A buy is a real payment, and the development key holds no funds. Connect a BSV wallet
              (e.g. MetaNet Desktop) and reload to trade.
            </p>
          )}
        </>
      )}
    >
      {done ? (
        /*
          The moment that sells this product. Someone has just paid from their own wallet and the
          only question in their head is "did that really happen?" — so the answer is a tick, the
          amount, what they now hold, and a link to their transaction on a public explorer. Not a
          line of status text under a form they have to re-read.
        */
        <div className="stake-done">
          <span className="stake-done-mark"><Icon name="check" size={30} /></span>
          <div className="stake-done-amount num">{done.sats.toLocaleString()}<small> sat</small></div>
          <p className="muted">
            You now hold <b>{done.units} {side.toUpperCase()}</b> in this market.
          </p>
          <p className="tiny muted">{market.question}</p>
          <TxLink txid={done.txid} isMainnet={!!isMainnet} label="See your transaction" />
          {!isMainnet && (
            <p className="tiny muted">
              This run is local: the payment was built and verified exactly as on mainnet, but not broadcast,
              so there is nothing to look up.
            </p>
          )}
        </div>
      ) : (
      <>
      <p className="market-question">{market.question}</p>

      <AmountPad
        value={units}
        onChange={setUnits}
        unit={units === 1 ? 'share' : 'shares'}
        presets={[1, 5, 10, 25]}
        max={100}
        hint={`${side.toUpperCase()} is trading at ${price} of ${market.payoutUnit} sat`}
      />

      <div className="review">
        <KeyValue label="price now" value={`${price} sat`} />
        <KeyValue label="if you are right" value={`${(units * market.payoutUnit).toLocaleString()} sat`} tone="positive" />
        <KeyValue label="you pay" emphasis tone="accent"
          value={quote ? `${Number(quote.est_buy_charge_sats).toLocaleString()} sat` : '…'} />
      </div>

      <p className="tiny muted">
        Your wallet will ask you to approve the stake. It leaves your balance and is paid to this market;
        the fill only exists once that payment is on the network.
      </p>
      </>
      )}
    </Sheet>
  );
}
