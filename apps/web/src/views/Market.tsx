import { useState } from 'react';
import { api, usePoll } from '../api';
import type { Signer } from '../signer';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);

/**
 * Market detail + the order ticket. Placing an order signs it with the trader's own key (real wallet when one
 * is present) and posts it; the daemon verifies the signature BEFORE filling, so a fill is evidence the user
 * actually authorized the trade. Fills are instant and off-chain — settlement happens in batches.
 */
export function Market({
  id, signer, identity, onBack,
}: { id: number; signer?: Signer; identity: string; onBack: () => void }) {
  const [market, mErr] = usePoll<any>(() => api.market(id), [id]);
  const [positions] = usePoll<any>(() => api.execPositions(id, identity || undefined), [id, identity]);
  const [receipts] = usePoll<any>(() => api.receipts(id, identity || undefined), [id, identity]);
  const [payout] = usePoll<any>(() => api.payoutPreview(id), [id]);

  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [units, setUnits] = useState(1);
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [quote] = usePoll<any>(() => api.quote(id, side, units), [id, side, units], 4000);

  const mine = positions?.positions?.find((p: any) => p.trader === identity);
  const myPayout = payout?.winners?.find((w: any) => w.trader === identity);
  const canTrade = market?.pool && market?.pool?.resolved !== 1;

  async function place() {
    if (!signer) return;
    setBusy(true);
    setMsg('');
    try {
      const trader = await signer.identityKey();
      const nonce = Date.now();
      const { sig, sigScheme } = await signer.signOrder({ marketId: id, trader, side, action, units, nonce });
      const r = await api.submitOrder(id, { trader, side, action, units, nonce, sig, sigScheme });
      setMsg(`filled ${action} ${units} ${side.toUpperCase()} @ ${r.receipt.priceSats} sat — receipt #${r.receipt.seq}`);
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  if (mErr) return <div className="card err">{mErr}</div>;
  if (!market) return <div className="card dim">loading…</div>;

  return (
    <div>
      <button className="link" onClick={onBack}>← all markets</button>
      <h2>{market.question}</h2>
      <div className="row dim">
        <span className={`state ${market.state}`}>{market.state}</span>
        {market.resolution && <span className="pill good">resolved {market.resolution.toUpperCase()}</span>}
        <span>pool v{market.pool?.version ?? '—'}</span>
      </div>

      <div className="cols">
        <div className="card">
          <h3>Price</h3>
          <div className="bigprices">
            <div className="yes"><b>{market.prices.yes_sats}</b><span>YES</span></div>
            <div className="no"><b>{market.prices.no_sats}</b><span>NO</span></div>
          </div>
          <p className="dim">out of {market.payoutUnit} sat per winning share</p>
        </div>

        <div className="card">
          <h3>Order ticket</h3>
          {!canTrade ? (
            <p className="dim">
              {market.pool ? 'Market is resolved — trading is closed.' : 'Pool not deployed yet.'}
            </p>
          ) : (
            <>
              <div className="row">
                <button className={side === 'yes' ? 'on yes' : ''} onClick={() => setSide('yes')}>YES</button>
                <button className={side === 'no' ? 'on no' : ''} onClick={() => setSide('no')}>NO</button>
                <button className={action === 'buy' ? 'on' : ''} onClick={() => setAction('buy')}>buy</button>
                <button className={action === 'sell' ? 'on' : ''} onClick={() => setAction('sell')}>sell</button>
              </div>
              <label>
                shares
                <input type="number" min={1} max={100} value={units}
                  onChange={(e) => setUnits(Math.max(1, Number(e.target.value) || 1))} />
              </label>
              {quote && (
                <p className="dim">
                  est. {action === 'buy'
                    ? `cost ${quote.est_buy_charge_sats} sat`
                    : quote.est_sell_proceeds_sats === null
                      ? 'nothing outstanding to sell'
                      : `proceeds ${quote.est_sell_proceeds_sats} sat`}
                </p>
              )}
              <button className="primary" disabled={busy || !signer} onClick={() => void place()}>
                {busy ? 'signing…' : `sign & ${action} ${units} ${side.toUpperCase()}`}
              </button>
              {msg && <p className={msg.startsWith('✗') ? 'err' : 'ok'}>{msg}</p>}
              <p className="dim tiny">
                Signed with your {signer?.kind === 'wallet' ? 'wallet' : 'dev key'}; the key never leaves your browser.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <h3>My position</h3>
          {mine ? (
            <div className="row">
              <span className="yes">YES {shares(mine.netYesShares)}</span>
              <span className="no">NO {shares(mine.netNoShares)}</span>
              <span className="dim">net cost {mine.netCostSats} sat</span>
            </div>
          ) : (
            <p className="dim">no position yet</p>
          )}
          {myPayout && (
            <p className="ok">
              You are owed <b>{myPayout.sats} sat</b> for {shares(myPayout.shares)} winning shares.
            </p>
          )}
        </div>

        <div className="card">
          <h3>My receipts <span className="dim">({receipts?.count ?? 0})</span></h3>
          <p className="dim tiny">
            Each fill is a signed receipt — your proof of the trade, and what the on-chain settlement is audited against.
          </p>
          <div className="scroll">
            {(receipts?.receipts ?? []).slice().reverse().map((r: any) => (
              <div key={r.seq} className="receipt">
                <span>#{r.seq}</span>
                <span className={r.side}>{r.action} {shares(r.shares)} {r.side.toUpperCase()}</span>
                <span className="dim">@{r.price_sats} sat</span>
                <span className={`pill ${r.settled ? 'good' : 'dev'}`}>{r.settled ? 'settled' : 'pending'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
