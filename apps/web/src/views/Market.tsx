import { useState } from 'react';
import { api, usePoll } from '../api';
import type { Signer } from '../signer';
import {
  Button, Callout, Card, EmptyState, Field, KeyValue, Pill, PriceBar, Segmented, StatusMessage, type Status,
} from '../ui';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);
const sats = (n: number) => n.toLocaleString();

/**
 * Market detail + the order ticket.
 *
 * WHY THERE IS NO SEPARATE REVIEW SHEET. The plan for this rebuild called for a Stake-style
 * review step ending in a slide-to-confirm. Building it made clear that would be wrong HERE: a buy
 * is paid through the trader's own BRC-100 wallet, which presents its own approval dialog with the
 * amount and refuses to spend without it. A review sheet plus a slider in front of that is a second
 * confirmation of a confirmation — friction that teaches people to click through carefully-designed
 * dialogs without reading them.
 *
 * So the cost is stated inline, permanently, before the button is pressed, and the wallet remains
 * the confirmation. The slide-to-confirm belongs on the OPERATOR side, where the daemon signs with
 * its own key and there is no wallet dialog — nothing else stands between a click and a broadcast.
 */
export function Market({
  id, signer, identity, onBack,
}: { id: number; signer?: Signer; identity: string; onBack: () => void }) {
  const [market, mErr] = usePoll<any>(() => api.market(id), [id]);
  const [positions] = usePoll<any>(() => api.execPositions(id, identity || undefined), [id, identity]);
  const [receipts] = usePoll<any>(() => api.receipts(id, identity || undefined), [id, identity]);
  const [payout] = usePoll<any>(() => api.payoutPreview(id), [id]);
  const [claims] = usePoll<any>(() => api.payoutClaims(id, identity || undefined), [id, identity]);

  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [units, setUnits] = useState(1);
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'idle' | 'quoting' | 'approving' | 'filling'>('idle');
  const [msg, setMsg] = useState<Status | undefined>();
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<Status | undefined>();
  const [quote] = usePoll<any>(() => api.quote(id, side, units), [id, side, units], 4000);

  const mine = positions?.positions?.find((p: any) => p.trader === identity);
  const myPayout = payout?.winners?.find((w: any) => w.trader === identity);
  const myClaim = claims?.claims?.find((c: any) => c.trader === identity);
  const canTrade = market?.pool && market.pool.resolved !== 1 && market.pool.spendable !== false;
  const devKeyCannotPay = action === 'buy' && signer?.kind === 'local';

  async function place() {
    if (!signer) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const trader = await signer.identityKey();
      const nonce = Date.now();
      const { sig, sigScheme } = await signer.signOrder({ marketId: id, trader, side, action, units, nonce });

      let payment: { intentId: number; paymentTx: string } | undefined;
      if (action === 'buy') {
        setStep('quoting');
        const intent = await api.paymentIntent(id, { trader, side, action, units });
        setStep('approving');
        const paid = await signer.pay({
          lockingScript: intent.locking_script,
          satoshis: intent.satoshis,
          description: `${units} ${side.toUpperCase()} @ market #${id}`,
        });
        payment = { intentId: intent.intent_id, paymentTx: paid.rawTx };
      }

      setStep('filling');
      const r = await api.submitOrder(id, { trader, side, action, units, nonce, sig, sigScheme, ...(payment ?? {}) });
      setMsg({
        tone: 'positive',
        text: `filled ${action} ${units} ${side.toUpperCase()} @ ${r.receipt.priceSats} sat — receipt #${r.receipt.seq}`
          + (action === 'buy' ? ` · paid ${r.receipt.costSats} sat` : ''),
      });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setStep('idle');
      setBusy(false);
    }
  }

  async function claim() {
    if (!signer) return;
    setClaiming(true);
    setClaimMsg(undefined);
    try {
      const prepared = await api.payoutClaim(id, identity);
      if (!prepared.ready) throw new Error(prepared.reason);
      const { accepted } = await signer.claim(prepared.internalize);
      setClaimMsg(accepted
        ? { tone: 'positive', text: `claimed ${prepared.satoshis} sat — it is in your wallet balance now` }
        : { tone: 'warning', text: 'your wallet did not accept the payment' });
    } catch (e) {
      setClaimMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setClaiming(false);
    }
  }

  if (mErr) return <Card tone="danger" title="Could not load this market">{mErr}</Card>;
  if (!market) return <Card><p className="muted">loading…</p></Card>;

  const buyLabel = step === 'quoting' ? 'getting a price…'
    : step === 'approving' ? 'approve the payment in your wallet…'
    : step === 'filling' ? 'filling…'
    : action === 'buy' ? `pay & buy ${units} ${side.toUpperCase()}`
    : `sign & sell ${units} ${side.toUpperCase()}`;

  return (
    <div className="stack">
      <Button variant="link" onClick={onBack}>← all markets</Button>

      <div className="stack-sm">
        <h2>{market.question}</h2>
        <div className="row tiny subtle">
          <span>#{market.id}</span>
          <Pill tone="neutral">{market.state}</Pill>
          {market.resolution && <Pill tone="positive" icon="✓">resolved {market.resolution.toUpperCase()}</Pill>}
          <span>b={market.bUnits}</span>
          <span>pool v{market.pool?.version ?? '—'}</span>
        </div>
      </div>

      {market.pool?.spendable === false && (
        <Callout tone="danger" title="This market's pool was deployed by an older build of the contract.">
          Fills would still be recorded off-chain, but they could never be settled on-chain by this build.
          Trade a market created with the current build instead.
        </Callout>
      )}

      <div className="cols">
        <Card title="Price" testId="panel-price">
          <PriceBar
            yesSats={market.prices.yes_sats}
            noSats={market.prices.no_sats}
            payoutUnit={market.payoutUnit}
            size="lg"
          />
          {/*
            Fills are instant and off-chain; the pool only catches up when a batch settles. Between
            settlements the live price and the chain's price genuinely differ, and that gap IS the
            unsettled batch. Showing it beats implying the chain has already agreed to this price.
          */}
          {market.settled_prices && market.settled_prices.yes_sats !== market.prices.yes_sats && (
            <p className="tiny muted">
              Last settled on chain: YES {market.settled_prices.yes_sats} · NO {market.settled_prices.no_sats}.
              The difference is trades not yet written to the chain.
            </p>
          )}
        </Card>

        <Card title="Order ticket" testId="panel-order">
          {!canTrade ? (
            <EmptyState
              icon="—"
              title="Trading is closed"
              hint={!market.pool ? 'Pool not deployed yet.'
                : market.pool.spendable === false ? 'Pool is unspendable by this build — trading disabled.'
                : 'Market is resolved — trading is closed.'}
            />
          ) : (
            <div className="ticket">
              <div className="ticket-controls">
                <Segmented
                  label="side" value={side} onChange={setSide}
                  options={[
                    { value: 'yes', label: 'YES', tone: 'positive' },
                    { value: 'no', label: 'NO', tone: 'negative' },
                  ]}
                />
                <Segmented
                  label="action" value={action} onChange={setAction}
                  options={[{ value: 'buy', label: 'buy' }, { value: 'sell', label: 'sell' }]}
                />
                <Field label="shares">
                  {(fid) => (
                    <input
                      id={fid} className="control ticket-shares" type="number" min={1} max={100} value={units}
                      onChange={(e) => setUnits(Math.max(1, Number(e.target.value) || 1))}
                    />
                  )}
                </Field>
              </div>

              {/* The review, stated inline and permanently — not behind a step you have to reach. */}
              <div className="review">
                {action === 'buy' ? (
                  <>
                    <KeyValue label={`${units} ${side.toUpperCase()} @ ${market.prices[`${side}_sats`]} sat`}
                      value={quote ? `${sats(quote.est_buy_charge_sats)} sat` : '…'} />
                    <KeyValue label="if you are right, you receive"
                      value={`${sats(units * market.payoutUnit)} sat`} tone="positive" />
                    <KeyValue label="you pay now" emphasis tone="accent"
                      value={quote ? `${sats(quote.est_buy_charge_sats)} sat` : '…'} />
                  </>
                ) : (
                  <KeyValue label="proceeds owed to you" emphasis
                    value={!quote ? '…'
                      : quote.est_sell_proceeds_sats === null ? 'nothing outstanding to sell'
                      : `${sats(quote.est_sell_proceeds_sats)} sat`} />
                )}
              </div>

              <Button
                variant="primary" tone={side === 'yes' ? 'positive' : 'negative'} size="lg" full
                busy={busy} disabled={busy || !signer} onClick={() => void place()}
              >
                {buyLabel}
              </Button>

              <StatusMessage status={msg} />

              {devKeyCannotPay ? (
                <p className="tiny warning-text">
                  A buy is a real payment now, and the development key holds no funds. Connect a BSV wallet
                  (e.g. MetaNet Desktop) and reload to trade.
                </p>
              ) : (
                <p className="tiny muted">
                  {action === 'buy'
                    ? 'Your wallet will ask you to approve the stake. It leaves your balance and is paid to this market.'
                    : 'Selling returns your position to the pool; proceeds are owed to you and paid by the operator.'}{' '}
                  Signed with your {signer?.kind === 'wallet' ? 'wallet' : 'dev key'}; the key never leaves your browser.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="cols">
        <Card title="My position" testId="panel-position">
          {mine ? (
            <div className="row">
              <span className="yes-text strong">YES {shares(mine.netYesShares)}</span>
              <span className="no-text strong">NO {shares(mine.netNoShares)}</span>
              <span className="tiny muted">net cost {sats(mine.netCostSats)} sat</span>
            </div>
          ) : (
            <EmptyState icon="○" title="No position yet" hint="Buy YES or NO above to take one." />
          )}

          {myPayout && (
            <Callout tone="positive" title={`You are owed ${sats(myPayout.sats)} sat`}>
              for {shares(myPayout.shares)} winning shares.
            </Callout>
          )}

          {myClaim && (
            <div className="claim-box">
              <div className="row-between">
                <span className="strong">Paid {sats(myClaim.sats)} sat</span>
                <a href={`https://whatsonchain.com/tx/${myClaim.txid}`} target="_blank" rel="noreferrer" className="tiny">
                  {myClaim.txid.slice(0, 12)}… ↗
                </a>
              </div>

              {myClaim.remittance ? (
                <>
                  {/*
                    Three different kinds of "not finished" exist in this system and they used to look
                    alike. This one is "broadcast but not mined": a wallet needs the merkle proof before
                    it will accept the money, so the button says what it is waiting for.
                  */}
                  {!myClaim.mined_at && <Pill tone="warning" icon="◷">waiting for a block</Pill>}
                  <Button
                    variant="primary" tone="accent" full
                    busy={claiming} disabled={claiming || !signer || !myClaim.mined_at}
                    onClick={() => void claim()}
                  >
                    {claiming ? 'claiming…' : !myClaim.mined_at ? 'waiting for the payout to confirm…' : 'claim into my wallet'}
                  </Button>
                  <StatusMessage status={claimMsg} />
                  <p className="tiny muted">
                    Sent to a one-time address only your key can unlock. Your wallet needs the transaction and
                    the derivation before the balance appears — that is what this button hands it.{' '}
                    {myClaim.mined_at
                      ? `Confirmed in block ${myClaim.mined_at}.`
                      : 'It is not in a block yet; a wallet needs that proof before it will take the money. '
                        + 'The derivation is recoverable from this market at any time, so nothing is lost by waiting.'}
                  </p>
                  <details>
                    <summary className="tiny muted">the derivation, if you want to claim from elsewhere</summary>
                    <pre className="code-block tiny">{JSON.stringify(myClaim.remittance, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p className="tiny warning-text">
                  This payout predates one-time addresses: it went to your identity key's own hash, which no
                  wallet watches. The satoshis are yours but you would have to sweep that key by hand.
                </p>
              )}
            </div>
          )}
        </Card>

        <Card title="My receipts" aside={<Pill tone="neutral">{receipts?.count ?? 0}</Pill>} testId="panel-receipts"
          subtitle="Each fill is a signed receipt — your proof of the trade, and what the on-chain settlement is audited against.">
          {(receipts?.receipts?.length ?? 0) === 0 ? (
            <EmptyState icon="◇" title="No fills yet" hint="Your receipts appear here the moment an order fills." />
          ) : (
            <div className="scroll">
              {(receipts?.receipts ?? []).slice().reverse().map((r: any) => (
                <div key={r.seq} className="receipt-row" data-testid="receipt-row">
                  <span className="receipt-seq">#{r.seq}</span>
                  <span className={`grow ${r.side === 'yes' ? 'yes-text' : 'no-text'}`}>
                    {r.action} {shares(r.shares)} {r.side.toUpperCase()}
                  </span>
                  <span className="tiny muted num">@{r.price_sats} sat</span>
                  {r.settled
                    ? <Pill tone="positive" icon="✓">settled</Pill>
                    : <Pill tone="warning" icon="◷">not yet on chain</Pill>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
