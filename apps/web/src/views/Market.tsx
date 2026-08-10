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
  const [claims] = usePoll<any>(() => api.payoutClaims(id, identity || undefined), [id, identity]);

  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [units, setUnits] = useState(1);
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [busy, setBusy] = useState(false);
  // What the user is waiting on. A wallet approval can sit for a while, so say which stage it is.
  const [step, setStep] = useState<'idle' | 'quoting' | 'approving' | 'filling'>('idle');
  const [msg, setMsg] = useState<string>('');
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<string>('');
  const [quote] = usePoll<any>(() => api.quote(id, side, units), [id, side, units], 4000);

  const mine = positions?.positions?.find((p: any) => p.trader === identity);
  const myPayout = payout?.winners?.find((w: any) => w.trader === identity);
  const myClaim = claims?.claims?.find((c: any) => c.trader === identity);
  // Don't let someone build a position that could never be settled on-chain.
  const canTrade = market?.pool && market.pool.resolved !== 1 && market.pool.spendable !== false;

  /**
   * Place an order.
   *
   * A BUY is now a real payment (FUND-001): quote a one-time destination, ask the wallet to pay it — the user
   * approves the amount in their own wallet — then submit the order with the payment. The daemon verifies the
   * transaction pays what was quoted and is actually on the network before it fills, so a fill cannot exist
   * without money having moved. A SELL is money owed to the trader, so it needs no payment.
   */
  async function place() {
    if (!signer) return;
    setBusy(true);
    setMsg('');
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
      const r = await api.submitOrder(id, {
        trader, side, action, units, nonce, sig, sigScheme,
        ...(payment ? payment : {}),
      });
      setMsg(
        `filled ${action} ${units} ${side.toUpperCase()} @ ${r.receipt.priceSats} sat — receipt #${r.receipt.seq}` +
        (action === 'buy' ? ` · paid ${r.receipt.costSats} sat` : ''),
      );
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    } finally {
      setStep('idle');
      setBusy(false);
    }
  }

  /**
   * Claim winnings into the connected wallet. Two steps, and the first is the one that fails: the daemon has to
   * fetch the payout transaction with its merkle proof, which only exists once the transaction is mined. The
   * wallet then verifies that proof itself before it will accept the money.
   */
  async function claim() {
    if (!signer) return;
    setClaiming(true);
    setClaimMsg('');
    try {
      const prepared = await api.payoutClaim(id, identity);
      if (!prepared.ready) throw new Error(prepared.reason);
      const { accepted } = await signer.claim(prepared.internalize);
      setClaimMsg(accepted
        ? `claimed ${prepared.satoshis} sat — it is in your wallet balance now`
        : 'your wallet did not accept the payment');
    } catch (e) {
      setClaimMsg(`✗ ${e instanceof Error ? e.message : e}`);
    } finally {
      setClaiming(false);
    }
  }

  if (mErr) return <div className="card err">{mErr}</div>;
  if (!market) return <div className="card dim">loading…</div>;

  return (
    <div>
      <button className="link" onClick={onBack}>← all markets</button>
      <h2>#{market.id} · {market.question}</h2>
      <div className="row dim">
        <span className={`state ${market.state}`}>{market.state}</span>
        {market.resolution && <span className="pill good">resolved {market.resolution.toUpperCase()}</span>}
        <span>pool v{market.pool?.version ?? '—'}</span>
        <span>b={market.bUnits}</span>
        <span>{market.payoutUnit} sat per winning share</span>
      </div>

      {market.pool?.spendable === false && (
        <div className="card err">
          <b>This market's pool was deployed by an older build of the contract.</b>
          <p className="dim">
            Fills would still be recorded off-chain, but they could never be settled on-chain by this build.
            Trade a market created with the current build instead.
          </p>
        </div>
      )}

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
              {!market.pool ? 'Pool not deployed yet.'
                : market.pool.spendable === false ? 'Pool is unspendable by this build — trading disabled.'
                : 'Market is resolved — trading is closed.'}
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
                {step === 'quoting' ? 'getting a price…'
                  : step === 'approving' ? 'approve the payment in your wallet…'
                  : step === 'filling' ? 'filling…'
                  : action === 'buy' ? `pay & buy ${units} ${side.toUpperCase()}`
                  : `sign & sell ${units} ${side.toUpperCase()}`}
              </button>
              {msg && <p className={msg.startsWith('✗') ? 'err' : 'ok'}>{msg}</p>}
              {action === 'buy' && signer?.kind === 'local' ? (
                <p className="warnText tiny">
                  A buy is a real payment now, and the development key holds no funds. Connect a BSV wallet
                  (e.g. MetaNet Desktop) and reload to trade.
                </p>
              ) : (
                <p className="dim tiny">
                  {action === 'buy'
                    ? 'Your wallet will ask you to approve the stake. It leaves your balance and is paid to this market.'
                    : 'Selling returns your position to the pool; proceeds are owed to you at settlement.'}{' '}
                  Signed with your {signer?.kind === 'wallet' ? 'wallet' : 'dev key'}; the key never leaves your browser.
                </p>
              )}
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
          {myClaim && (
            <div className="paid">
              <p className="ok">
                Paid <b>{myClaim.sats} sat</b> — <a href={`https://whatsonchain.com/tx/${myClaim.txid}`} target="_blank" rel="noreferrer">{myClaim.txid.slice(0, 12)}…</a>
              </p>
              {myClaim.remittance ? (
                <>
                  {/*
                    Disabled until the payout is in a block. A wallet will not accept the money without the
                    merkle proof of a mined transaction, so before that this button has exactly one possible
                    outcome — an error. Better to show why it is waiting than to let someone press it.
                  */}
                  <button
                    className="primary"
                    disabled={claiming || !signer || !myClaim.mined_at}
                    onClick={() => void claim()}
                  >
                    {claiming ? 'claiming…'
                      : !myClaim.mined_at ? 'waiting for the payout to confirm…'
                      : 'claim into my wallet'}
                  </button>
                  {claimMsg && <p className={claimMsg.startsWith('✗') ? 'err' : 'ok'}>{claimMsg}</p>}
                  <p className="dim tiny">
                    Sent to a one-time address only your key can unlock. Your wallet needs the transaction and
                    the derivation before the balance appears — that is what this button hands it.{' '}
                    {myClaim.mined_at
                      ? `Confirmed in block ${myClaim.mined_at}.`
                      : 'It is not in a block yet; a wallet needs that proof before it will take the money. ' +
                        'The derivation is recoverable from this market at any time, so nothing is lost by waiting.'}
                  </p>
                  <details>
                    <summary className="dim tiny">the derivation, if you want to claim from elsewhere</summary>
                    <pre className="tiny">{JSON.stringify(myClaim.remittance, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p className="warnText tiny">
                  This payout predates one-time addresses: it went to your identity key's own hash, which no
                  wallet watches. The satoshis are yours but you would have to sweep that key by hand.
                </p>
              )}
            </div>
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
