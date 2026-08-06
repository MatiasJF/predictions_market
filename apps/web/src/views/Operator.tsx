import { useState } from 'react';
import { api, operatorToken, usePoll } from '../api';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);

/**
 * The operator console. Every state-changing action lands in the SIGN-OFF QUEUE first — nothing reaches the
 * chain until a human authorizes it here. That is the safety property the whole system is built around, so the
 * queue is the centrepiece rather than a footnote.
 */
export function Operator({ network, authRequired }: { network?: string; authRequired?: boolean }) {
  const [markets] = usePoll<any[]>(() => api.markets(), []);
  const [queue, , refreshQueue] = usePoll<any[]>(() => api.broadcasts(), [], 2000);
  const [balance] = usePoll<any>(() => api.balance(), [], 10000);
  const [sel, setSel] = useState<number | undefined>();
  const [token, setToken] = useState(operatorToken.get());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState<number | undefined>();
  // Verified against the daemon, not merely "is the box non-empty" — a wrong token looks identical otherwise.
  const [tokenOk] = usePoll<boolean>(
    () => api.operatorCheck().then(() => true).catch(() => false),
    [token],
    5000,
  );
  const blocked = authRequired && tokenOk !== true;

  // Default to the NEWEST market, not the oldest: a DB accumulates markets across runs, and silently pointing
  // the console at a months-old one is how you end up acting on the wrong market.
  const marketId = sel ?? markets?.[markets.length - 1]?.id;
  const [audit] = usePoll<any>(() => (marketId ? api.audit(marketId) : Promise.resolve(null)), [marketId], 5000);
  const [payout] = usePoll<any>(() => (marketId ? api.payoutPreview(marketId) : Promise.resolve(null)), [marketId], 5000);
  const market = markets?.find((m) => m.id === marketId);
  const pending = (queue ?? []).filter((b) => b.status === 'pending');
  const failed = (queue ?? []).filter((b) => b.status === 'failed').slice(-3).reverse();
  const isMainnet = network === 'mainnet';
  // A pool deployed by an earlier build of the contract cannot be spent by this one. Say so, and don't offer
  // actions that are guaranteed to fail at authorize time.
  const stranded = market?.pool && market.pool.spendable === false;

  async function act(label: string, fn: () => Promise<any>) {
    setBusy(label); setMsg('');
    try {
      const r = await fn();
      const cost = r.size_bytes
        ? ` · ${(r.size_bytes / 1024).toFixed(1)} KB, fee ${Number(r.fee_sats ?? 0).toLocaleString()} sat`
        : '';
      setMsg(`${label}: ${r.txid ? `broadcast ${String(r.txid).slice(0, 20)}…${cost}` : `queued #${r.broadcast_id ?? ''}`}`);
      if (r.id && r.question) setSel(r.id); // a market we just created — select it
      await refreshQueue();
    } catch (e) {
      setMsg(`✗ ${label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      <div className={`card${blocked ? ' danger' : ''}`}>
        <h3>
          Operator token{' '}
          {authRequired
            ? tokenOk === true
              ? <span className="pill good">accepted</span>
              : <span className="pill bad">{token ? 'rejected' : 'required'}</span>
            : <span className="pill dev">not required by this daemon</span>}
        </h3>
        <p className="dim tiny">
          Operator actions spend real money, so they require this token. It is a shared secret over loopback —
          fine locally, never a reason to expose the daemon to a network.
        </p>
        <div className="row">
          <input type="password" value={token} placeholder="PM_OPERATOR_TOKEN"
            onChange={(e) => { setToken(e.target.value); operatorToken.set(e.target.value); }} />
          {balance && <span className="dim">wallet {balance.balance_sats.toLocaleString()} sat</span>}
        </div>
        {blocked && (
          <p className="err tiny">
            This daemon requires an operator token and {token ? 'the one entered was rejected' : 'none is set'}.
            Paste the value you started it with — the same <code>PM_OPERATOR_TOKEN=…</code> from the daemon's
            command line. Until it is accepted, nothing here can be queued or authorized.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Sign-off queue <span className="dim">({pending.length} pending)</span></h3>
        {pending.length === 0 && <p className="dim">Nothing awaiting authorization.</p>}
        {pending.map((b) => (
          <div key={b.id} className="queue">
            <div>
              <b>#{b.id} {b.kind}</b>
              <div className="dim">{b.summary}</div>
              <div className={isMainnet ? 'warnText tiny' : 'dim tiny'}>
                spends ~{b.spend_sats} sat{isMainnet ? ' of REAL money on mainnet' : ' (local — nothing is broadcast)'}
              </div>
            </div>
            <div className="row">
              {confirming === b.id ? (
                <>
                  <button className="danger" disabled={!!busy || blocked}
                    onClick={() => { setConfirming(undefined); void act(`authorize #${b.id}`, () => api.authorize(b.id)); }}>
                    confirm — spend {b.spend_sats} sat
                  </button>
                  <button disabled={!!busy} onClick={() => setConfirming(undefined)}>cancel</button>
                </>
              ) : (
                <>
                  <button className="primary" disabled={!!busy || blocked}
                    onClick={() => (isMainnet
                      ? setConfirming(b.id)
                      : void act(`authorize #${b.id}`, () => api.authorize(b.id)))}>
                    authorize
                  </button>
                  <button disabled={!!busy || blocked}
                    onClick={() => void act(`reject #${b.id}`, () => api.reject(b.id))}>reject</button>
                </>
              )}
            </div>
          </div>
        ))}
        {failed.length > 0 && (
          <div className="failed">
            <b className="err">recently failed</b>
            {failed.map((b) => (
              <div key={b.id} className="tiny">
                <span className="dim">#{b.id} {b.kind} — </span><span className="err">{b.error}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Market</h3>
        <div className="row">
          <select value={marketId ?? ''} onChange={(e) => setSel(Number(e.target.value))}>
            {(markets ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                #{m.id} · {m.payoutUnit} sat/share · b={m.bUnits} · {m.question.slice(0, 40)}
              </option>
            ))}
          </select>
          <button disabled={!!busy || blocked} onClick={() => void act('create market', () => api.createMarket({
            question: `Market ${new Date().toISOString().slice(0, 16)}`, bUnits: 1000, payoutUnit: 1000,
          }))}>new market</button>
        </div>

        {market && (
          <>
            <div className="row dim">
              <span className={`state ${market.state}`}>{market.state}</span>
              <span>{market.payoutUnit} sat per winning share</span>
              <span>b={market.bUnits}</span>
              <span>pool v{market.pool?.version ?? '—'}</span>
              {market.resolution && <span className="pill good">resolved {market.resolution.toUpperCase()}</span>}
            </div>

            {stranded && (
              <div className="card err">
                <b>This pool cannot be spent by the current build.</b>
                <p className="dim">
                  Its locking script <i>is</i> the compiled contract, and the contract has changed since this pool
                  was deployed — so every action below would fail at authorize time. Create a fresh market instead.
                </p>
              </div>
            )}

            <div className="row wrapping">
              <button disabled={!!busy || blocked || !!market.pool}
                onClick={() => void act('deploy', () => api.deploy(market.id))}>deploy pool</button>
              <button disabled={!!busy || blocked || !market.pool || stranded}
                onClick={() => void act('settle', () => api.settle(market.id))}>settle batch</button>
              <button disabled={!!busy || blocked || !market.pool || stranded || market.pool?.resolved === 1}
                onClick={() => void act('resolve YES', () => api.resolve(market.id, 'yes'))}>resolve YES</button>
              <button disabled={!!busy || blocked || !market.pool || stranded || market.pool?.resolved === 1}
                onClick={() => void act('resolve NO', () => api.resolve(market.id, 'no'))}>resolve NO</button>
              <button className="primary" disabled={!!busy || blocked || stranded || !payout?.winners?.length}
                onClick={() => void act('payout', () => api.payout(market.id))}>pay winners</button>
            </div>
            {msg && <p className={msg.startsWith('✗') ? 'err' : 'ok'}>{msg}</p>}
          </>
        )}
      </div>

      <div className="cols">
        <div className="card">
          <h3>Audit</h3>
          <p className="dim tiny">Does the on-chain settlement match the receipts traders actually signed?</p>
          {!audit ? <p className="dim">—</p> : audit.batches === 0 ? <p className="dim">nothing settled yet</p> : (
            <>
              <p className={audit.ok ? 'ok' : 'err'}>
                {audit.ok ? '✅ settlements match the signed receipts' : '❌ MISMATCH'}
              </p>
              {audit.reports.map((r: any) => (
                <div key={r.batchId} className="dim tiny">
                  batch #{r.batchId}: {r.receiptCount} receipts · {r.violations.length} violations ·
                  {r.rabinAttested ? ' attested' : ' not attested'}
                  {r.violations.map((v: any, i: number) => <div key={i} className="err">❌ {v.check}: {v.detail}</div>)}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <h3>Winners</h3>
          {!payout?.resolved ? <p className="dim">market not resolved</p>
            : payout.winners.length === 0 ? <p className="dim">no winning positions</p> : (
              <>
                {payout.winners.map((w: any) => (
                  <div key={w.trader} className="receipt">
                    <code title={w.trader}>{w.trader.slice(0, 16)}…</code>
                    <span>{shares(w.shares)} shares</span>
                    <b>{w.sats} sat</b>
                  </div>
                ))}
                <p className="dim tiny">total {payout.total_sats} sat — paid to the key each trader signed with</p>
              </>
            )}
        </div>
      </div>
    </div>
  );
}
