import { useState } from 'react';
import { api, operatorToken, usePoll } from '../api';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);

/**
 * The operator console. Every state-changing action lands in the SIGN-OFF QUEUE first — nothing reaches the
 * chain until a human authorizes it here. That is the safety property the whole system is built around, so the
 * queue is the centrepiece rather than a footnote.
 */
export function Operator() {
  const [markets] = usePoll<any[]>(() => api.markets(), []);
  const [queue, , refreshQueue] = usePoll<any[]>(() => api.broadcasts(), [], 2000);
  const [balance] = usePoll<any>(() => api.balance(), [], 10000);
  const [sel, setSel] = useState<number | undefined>();
  const [token, setToken] = useState(operatorToken.get());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const marketId = sel ?? markets?.[0]?.id;
  const [audit] = usePoll<any>(() => (marketId ? api.audit(marketId) : Promise.resolve(null)), [marketId], 5000);
  const [payout] = usePoll<any>(() => (marketId ? api.payoutPreview(marketId) : Promise.resolve(null)), [marketId], 5000);
  const market = markets?.find((m) => m.id === marketId);
  const pending = (queue ?? []).filter((b) => b.status === 'pending');

  async function act(label: string, fn: () => Promise<any>) {
    setBusy(label); setMsg('');
    try {
      const r = await fn();
      setMsg(`${label}: ${r.txid ? `broadcast ${String(r.txid).slice(0, 20)}…` : `queued #${r.broadcast_id ?? ''}`}`);
      await refreshQueue();
    } catch (e) {
      setMsg(`✗ ${label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      <div className="card">
        <h3>Operator token</h3>
        <p className="dim tiny">
          Operator actions spend real money, so they require this token. It is a shared secret over loopback —
          fine locally, never a reason to expose the daemon to a network.
        </p>
        <div className="row">
          <input type="password" value={token} placeholder="PM_OPERATOR_TOKEN"
            onChange={(e) => { setToken(e.target.value); operatorToken.set(e.target.value); }} />
          {balance && <span className="dim">wallet {balance.balance_sats.toLocaleString()} sat</span>}
        </div>
      </div>

      <div className="card">
        <h3>Sign-off queue <span className="dim">({pending.length} pending)</span></h3>
        {pending.length === 0 && <p className="dim">Nothing awaiting authorization.</p>}
        {pending.map((b) => (
          <div key={b.id} className="queue">
            <div>
              <b>#{b.id} {b.kind}</b>
              <div className="dim">{b.summary}</div>
              <div className="dim tiny">spends ~{b.spend_sats} sat</div>
            </div>
            <div className="row">
              <button className="primary" disabled={!!busy}
                onClick={() => void act(`authorize #${b.id}`, () => api.authorize(b.id))}>authorize</button>
              <button disabled={!!busy}
                onClick={() => void act(`reject #${b.id}`, () => api.reject(b.id))}>reject</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Market</h3>
        <div className="row">
          <select value={marketId ?? ''} onChange={(e) => setSel(Number(e.target.value))}>
            {(markets ?? []).map((m) => <option key={m.id} value={m.id}>#{m.id} {m.question.slice(0, 48)}</option>)}
          </select>
          <button disabled={!!busy} onClick={() => void act('create market', () => api.createMarket({
            question: `Market ${new Date().toISOString().slice(0, 16)}`, bUnits: 1000, payoutUnit: 1000,
          }))}>new market</button>
        </div>

        {market && (
          <>
            <div className="row dim">
              <span className={`state ${market.state}`}>{market.state}</span>
              <span>pool v{market.pool?.version ?? '—'}</span>
              {market.resolution && <span className="pill good">resolved {market.resolution.toUpperCase()}</span>}
            </div>
            <div className="row wrapping">
              <button disabled={!!busy || !!market.pool}
                onClick={() => void act('deploy', () => api.deploy(market.id))}>deploy pool</button>
              <button disabled={!!busy || !market.pool}
                onClick={() => void act('settle', () => api.settle(market.id))}>settle batch</button>
              <button disabled={!!busy || !market.pool || market.pool?.resolved === 1}
                onClick={() => void act('resolve YES', () => api.resolve(market.id, 'yes'))}>resolve YES</button>
              <button disabled={!!busy || !market.pool || market.pool?.resolved === 1}
                onClick={() => void act('resolve NO', () => api.resolve(market.id, 'no'))}>resolve NO</button>
              <button className="primary" disabled={!!busy || !payout?.winners?.length}
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
