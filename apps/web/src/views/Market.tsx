import { useState } from 'react';
import { api, usePoll } from '../api';
import type { Signer } from '../signer';
import {
  ActionCircle, Button, Callout, Card, EmptyState, Field, KeyValue, Pill, PriceBar, Segmented,
  Sparkline, StatusMessage, TxLink, yesSeries, type Status,
} from '../ui';
import { StakeSheet } from './StakeSheet';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);
const sats = (n: number) => n.toLocaleString();

/**
 * Market detail.
 *
 * BUYING LIVES IN ONE PLACE. This view used to carry its own quote → pay → submit, which meant the
 * single action that spends a trader's own money had two implementations — the sheet used by the
 * deck and the market cards, and this one. A commit message claimed there was only one; there were
 * two, and the next fix to the payment path would have landed in one of them. Backing a side here
 * now opens the same `StakeSheet` as everywhere else.
 *
 * Selling stays inline, because a sell is not a payment: it is money the market comes to owe you,
 * so there is no wallet approval to route and nothing to confirm twice.
 */
export function Market({
  id, signer, identity, isMainnet, onBack,
}: { id: number; signer?: Signer; identity: string; isMainnet: boolean; onBack: () => void }) {
  const [market, mErr] = usePoll<any>(() => api.market(id), [id]);
  const [positions] = usePoll<any>(() => api.execPositions(id, identity || undefined), [id, identity]);
  const [receipts] = usePoll<any>(() => api.receipts(id, identity || undefined), [id, identity]);
  const [payout] = usePoll<any>(() => api.payoutPreview(id), [id]);
  const [claims] = usePoll<any>(() => api.payoutClaims(id, identity || undefined), [id, identity]);
  // Every fill, not just this trader's — the market's own history is what the graph is about.
  const [allFills] = usePoll<any>(() => api.receipts(id), [id], 5000);

  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [units, setUnits] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Status | undefined>();
  const [staking, setStaking] = useState<'yes' | 'no' | undefined>();
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<Status | undefined>();
  const [quote] = usePoll<any>(() => api.quote(id, side, units), [id, side, units], 4000);

  const mine = positions?.positions?.find((p: any) => p.trader === identity);
  const myPayout = payout?.winners?.find((w: any) => w.trader === identity);
  // Everything this market has paid me — winnings AND sale proceeds. Both arrive at a one-time
  // address and both need the wallet told how it was derived, so both belong in the same list.
  const myClaims: any[] = (claims?.claims ?? []).filter((c: any) => c.trader === identity);
  const canTrade = market?.pool && market.pool.resolved !== 1 && market.pool.spendable !== false;
  const devKeyCannotPay = signer?.kind === 'local';
  // What this trader holds, which is the ceiling on what they can close.
  const heldYes = mine ? shares(mine.netYesShares) : 0;
  const heldNo = mine ? shares(mine.netNoShares) : 0;
  const heldSide = side === 'yes' ? heldYes : heldNo;

  /** SELL only. A buy goes through `StakeSheet`, which is the single implementation of paying. */
  async function sell() {
    if (!signer) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const trader = await signer.identityKey();
      const nonce = Date.now();
      const { sig, sigScheme } = await signer.signOrder({ marketId: id, trader, side, action: 'sell', units, nonce });
      const r = await api.submitOrder(id, { trader, side, action: 'sell', units, nonce, sig, sigScheme });
      setMsg({
        tone: 'positive',
        text: `sold ${units} ${side.toUpperCase()} @ ${r.receipt.priceSats} sat — receipt #${r.receipt.seq}. `
          + 'The market now owes you the proceeds; the operator pays them from the stake pot.',
      });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function claim(kind: 'payout' | 'proceeds') {
    if (!signer) return;
    setClaiming(true);
    setClaimMsg(undefined);
    try {
      const prepared = await api.payoutClaim(id, identity, kind);
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
          <Sparkline
            values={yesSeries(allFills?.receipts ?? [], market.payoutUnit)}
            payoutUnit={market.payoutUnit}
            height={64}
            label={`YES price across ${allFills?.count ?? 0} fills in this market`}
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
              {/* Backing a side opens the ONE sheet that takes payments — same as the deck and the cards. */}
              <div className="circle-row market-actions">
                <ActionCircle icon="↑" label={`YES ${market.prices.yes_sats}`} tone="positive"
                  title={`Back YES at ${market.prices.yes_sats} sat`} onClick={() => setStaking('yes')} />
                <ActionCircle icon="↓" label={`NO ${market.prices.no_sats}`} tone="negative"
                  title={`Back NO at ${market.prices.no_sats} sat`} onClick={() => setStaking('no')} />
              </div>

              {devKeyCannotPay ? (
                <p className="tiny warning-text">
                  A buy is a real payment now, and the development key holds no funds. Connect a BSV wallet
                  (e.g. MetaNet Desktop) and reload to trade.
                </p>
              ) : (
                <p className="tiny muted">
                  Your wallet will ask you to approve the stake. It leaves your balance and is paid to this market.
                </p>
              )}

              {/* --- selling: not a payment, so it stays here ------------------------------------ */}
              {/*
                What you actually hold, stated before the controls. The sell control used to offer
                itself regardless, and the engine now refuses a sell larger than the position — so
                without this the button is simply a button that fails.
              */}
              <div className="ticket-sell">
                <span className="section-label">close a position</span>
                <div className="row tiny muted">
                  <span>you hold</span>
                  <b className={heldYes > 0 ? 'yes-text' : undefined}>YES {heldYes}</b>
                  <b className={heldNo > 0 ? 'no-text' : undefined}>NO {heldNo}</b>
                </div>
                <div className="ticket-controls">
                  <Segmented
                    label="side to sell" value={side} onChange={setSide}
                    options={[
                      { value: 'yes', label: 'YES', tone: 'positive' },
                      { value: 'no', label: 'NO', tone: 'negative' },
                    ]}
                  />
                  <Field label="shares to sell">
                    {(fid) => (
                      <input id={fid} className="control ticket-shares" type="number" min={1} max={100} value={units}
                        onChange={(e) => setUnits(Math.max(1, Number(e.target.value) || 1))} />
                    )}
                  </Field>
                </div>
                <div className="review">
                  <KeyValue label="proceeds owed to you" emphasis
                    value={!quote ? '…'
                      : quote.est_sell_proceeds_sats === null ? 'nothing outstanding to sell'
                      : `${sats(quote.est_sell_proceeds_sats)} sat`} />
                </div>
                <Button variant="secondary" tone="neutral" full busy={busy}
                  disabled={busy || !signer || units > heldSide}
                  onClick={() => void sell()}>
                  {heldSide === 0
                    ? `nothing to sell on ${side.toUpperCase()}`
                    : units > heldSide
                      ? `you only hold ${heldSide} ${side.toUpperCase()}`
                      : `sign & sell ${units} ${side.toUpperCase()}`}
                </Button>
                <p className="tiny muted">
                  Selling returns your position to the pool. Proceeds are owed to you immediately and paid by
                  the operator from the stake pot — they are a debt until then, not a transfer.
                </p>
              </div>

              <StatusMessage status={msg} />
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

          {myClaims.map((c) => (
            <div className="claim-box" key={`${c.kind}-${c.txid}-${c.order_seq ?? ''}`}>
              <div className="row-between">
                <span className="strong">
                  {c.kind === 'proceeds' ? 'Sale proceeds' : 'Winnings'} — {sats(c.sats)} sat
                </span>
                <TxLink txid={c.txid} isMainnet={isMainnet} label="See the payment" />
              </div>

              {c.remittance ? (
                <>
                  {!c.mined_at && <Pill tone="warning" icon="◷">waiting for a block</Pill>}
                  <Button
                    variant="primary" tone="accent" full
                    busy={claiming} disabled={claiming || !signer || !c.mined_at}
                    onClick={() => void claim(c.kind)}
                  >
                    {claiming ? 'claiming…'
                      : !c.mined_at ? 'waiting to confirm…'
                      : 'claim into my wallet'}
                  </Button>
                  <p className="tiny muted">
                    Sent to a one-time address only your key can unlock. Your wallet needs the transaction and
                    the derivation before the balance appears — that is what this button hands it.{' '}
                    {c.mined_at ? `Confirmed in block ${c.mined_at}.` : 'It is not in a block yet.'}
                  </p>
                </>
              ) : (
                <p className="tiny warning-text">
                  This payment predates one-time addresses: it went to your identity key's own hash, which no
                  wallet watches. The satoshis are yours but that key has to be swept by hand.
                </p>
              )}
            </div>
          ))}
          {myClaims.length > 0 && <StatusMessage status={claimMsg} />}
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
                  {/*
                    The links ARE the status. This row used to carry a "not yet on chain" pill, which
                    is internal vocabulary for something the trader can simply see: the receipt exists
                    from the moment they pay, and the settled batch appears when the market writes it
                    to the chain. Two links tell that story without a word of jargon.

                    Keyed on each TRANSACTION's own network, not the daemon's, because one database
                    can hold both rehearsed and real ones and only the real ones exist on an explorer.
                  */}
                  <TxLink txid={r.payment_txid} isMainnet={r.payment_network === 'mainnet'} label="receipt" compact />
                  {r.settled && (
                    <TxLink txid={r.settle_txid} isMainnet={r.settle_network === 'mainnet'} label="settled batch" compact />
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <StakeSheet
        open={!!staking} onClose={() => setStaking(undefined)}
        market={market} side={staking ?? 'yes'} signer={signer} isMainnet={isMainnet}
      />
    </div>
  );
}
