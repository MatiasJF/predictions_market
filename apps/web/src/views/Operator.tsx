import { useState } from 'react';
import { api, operatorToken, usePoll } from '../api';
import { TxLog } from './TxLog';
import { previewPrice, maxLossSats } from '../curve';
import {
  Button, Callout, Card, EmptyState, Field, Pill, SlideToConfirm, StatusMessage, type Status,
} from '../ui';
import './Operator.css';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);
const sats = (n: number) => Number(n).toLocaleString();

/** Where a market is in its life. Derived from state rather than tracked, so it cannot go stale. */
const STEPS = ['deploy', 'trade', 'settle', 'resolve', 'pay'] as const;

/**
 * The operator console.
 *
 * Every state-changing action lands in the SIGN-OFF QUEUE first — nothing reaches the chain until a
 * human authorizes it here. That is the safety property the whole system is built around, so the
 * queue is the centrepiece rather than a footnote.
 *
 * This surface is deliberately denser and more cautionary than the trader's. It is also where
 * slide-to-confirm belongs: a trader's spend is approved in their own wallet, but here the daemon
 * signs with its own key, so on mainnet a single click is the only thing between an operator and an
 * irreversible broadcast. Twice now that has cost real money.
 */
export function Operator({ network, authRequired }: { network?: string; authRequired?: boolean }) {
  const [markets] = usePoll<any[]>(() => api.markets(), []);
  const [queue, , refreshQueue] = usePoll<any[]>(() => api.broadcasts(), [], 2000);
  const [balance] = usePoll<any>(() => api.balance(), [], 10000);
  const [sel, setSel] = useState<number | undefined>();
  const [token, setToken] = useState(operatorToken.get());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<Status | undefined>();
  const [tokenOk] = usePoll<boolean>(() => api.operatorCheck().then(() => true).catch(() => false), [token], 5000);
  const blocked = authRequired && tokenOk !== true;

  // Default to the NEWEST market, not the oldest: a DB accumulates markets across runs, and silently
  // pointing the console at a months-old one is how you end up acting on the wrong market.
  const marketId = sel ?? markets?.[markets.length - 1]?.id;
  const [audit] = usePoll<any>(() => (marketId ? api.audit(marketId) : Promise.resolve(null)), [marketId], 5000);
  const [payout] = usePoll<any>(() => (marketId ? api.payoutPreview(marketId) : Promise.resolve(null)), [marketId], 5000);
  const [debts] = usePoll<any>(() => (marketId ? api.sellDebts(marketId) : Promise.resolve(null)), [marketId], 5000);

  const [question, setQuestion] = useState('');
  const [bUnits, setBUnits] = useState(20);
  const [payoutUnit, setPayoutUnit] = useState(1000);
  const preview = [1, 5, 20].map((n) => ({ n, price: previewPrice(bUnits, payoutUnit, n) }));
  const maxLoss = maxLossSats(bUnits, payoutUnit);

  const market = markets?.find((m) => m.id === marketId);
  const pending = (queue ?? []).filter((b) => b.status === 'pending');
  const failed = (queue ?? []).filter((b) => b.status === 'failed').slice(-3).reverse();
  const isMainnet = network === 'mainnet';
  const stranded = market?.pool && market.pool.spendable === false;

  const step = !market?.pool ? 'deploy'
    : market.pool.resolved === 1 ? 'pay'
    : (queue ?? []).some((b) => b.kind === 'settle' && b.status === 'broadcast') ? 'resolve'
    : 'settle';

  async function act(label: string, fn: () => Promise<any>) {
    setBusy(label); setMsg(undefined);
    try {
      const r = await fn();
      const cost = r.size_bytes
        ? ` · ${(r.size_bytes / 1024).toFixed(1)} KB, fee ${sats(r.fee_sats ?? 0)} sat`
        : '';
      setMsg({
        tone: 'positive',
        text: `${label}: ${r.txid ? `broadcast${cost} — see the transaction log below` : `queued #${r.broadcast_id ?? ''}`}`,
      });
      if (r.id && r.question) setSel(r.id); // a market we just created — select it
      await refreshQueue();
    } catch (e) {
      setMsg({ tone: 'danger', text: `${label}: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack">
      {/* --- status strip: what an operator needs to know BEFORE acting, in one place ------------- */}
      <div className="opstrip">
        <div className="opstat">
          <span className="opstat-label">network</span>
          {isMainnet
            ? <Pill tone="danger" icon="⚠">mainnet · real money</Pill>
            : <Pill tone="neutral" icon="○">{network ?? '—'}</Pill>}
        </div>
        <div className="opstat">
          <span className="opstat-label">operator token</span>
          {!authRequired ? <Pill tone="neutral">not required</Pill>
            : tokenOk === true ? <Pill tone="positive" icon="✓">accepted</Pill>
            : <Pill tone="danger" icon="✕">{token ? 'rejected' : 'required'}</Pill>}
        </div>
        <div className="opstat">
          <span className="opstat-label">funding wallet</span>
          <span className="num strong">{balance ? `${sats(balance.balance_sats)} sat` : '—'}</span>
        </div>
        <div className="opstat">
          <span className="opstat-label">awaiting sign-off</span>
          <span className="num strong">{pending.length}</span>
        </div>
      </div>

      <Card
        title="Operator token"
        subtitle="Operator actions spend real money, so they require this token. It is a shared secret over loopback — fine locally, never a reason to expose the daemon to a network."
        tone={blocked ? 'danger' : 'neutral'}
        testId="panel-token"
      >
        <Field label="token">
          {(id) => (
            <input id={id} className="control" type="password" value={token} placeholder="PM_OPERATOR_TOKEN"
              onChange={(e) => { setToken(e.target.value); operatorToken.set(e.target.value); }} />
          )}
        </Field>
        {blocked && (
          <Callout tone="danger" title="Nothing here can be queued or authorized.">
            This daemon requires an operator token and {token ? 'the one entered was rejected' : 'none is set'}.
            Paste the value you started it with — the same <code>PM_OPERATOR_TOKEN=…</code> from the daemon's
            command line.
          </Callout>
        )}
      </Card>

      {/* --- the human gate --------------------------------------------------------------------- */}
      <Card title="Sign-off queue" aside={<Pill tone={pending.length ? 'warning' : 'neutral'}>{pending.length} pending</Pill>}
        testId="panel-signoff">
        {pending.length === 0 && (
          <EmptyState icon="✓" title="Nothing awaiting authorization"
            hint="Actions you queue below appear here before anything reaches the chain." />
        )}

        {pending.map((b) => (
          <div key={b.id} className="queue-row" data-testid="queue-row" data-kind={b.kind}>
            <div className="grow">
              <div className="row">
                <b>#{b.id} {b.kind}</b>
                <Pill tone={isMainnet ? 'danger' : 'neutral'} icon={isMainnet ? '⚠' : '○'}>
                  {isMainnet ? `spends ~${sats(b.spend_sats)} sat of REAL money` : `~${sats(b.spend_sats)} sat · nothing is broadcast`}
                </Pill>
              </div>
              <div className="tiny muted">{b.summary}</div>
            </div>

            <div className="queue-actions">
              {/*
                On mainnet, authorizing is irreversible and there is no wallet dialog behind it — the
                daemon signs with its own key. So it takes a deliberate drag, gated behind an
                acknowledgement, with the amount written on the control itself. Off mainnet nothing is
                broadcast, so a plain button is honest and quicker.
              */}
              {isMainnet ? (
                <SlideToConfirm
                  label={`slide to spend ${sats(b.spend_sats)} sat`}
                  requireAck={`I understand this broadcasts to mainnet and spends ~${sats(b.spend_sats)} sat that cannot be recovered.`}
                  disabled={!!busy || blocked}
                  busy={busy === `authorize #${b.id}`}
                  onConfirm={() => void act(`authorize #${b.id}`, () => api.authorize(b.id))}
                />
              ) : (
                <Button variant="primary" disabled={!!busy || blocked}
                  onClick={() => void act(`authorize #${b.id}`, () => api.authorize(b.id))}>authorize</Button>
              )}
              <Button variant="ghost" tone="neutral" disabled={!!busy || blocked}
                onClick={() => void act(`reject #${b.id}`, () => api.reject(b.id))}>reject</Button>
            </div>
          </div>
        ))}

        {failed.length > 0 && (
          <div className="failed-block">
            <span className="section-label danger-text">recently failed</span>
            {failed.map((b) => (
              <div key={b.id} className="tiny">
                <span className="muted">#{b.id} {b.kind} — </span>
                <span className="danger-text break-all">{b.error}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <TxLog broadcasts={queue ?? []} isMainnet={isMainnet} />

      {/* --- market lifecycle -------------------------------------------------------------------- */}
      <Card title="Market" testId="panel-market">
        <div className="row">
          <Field label="market">
            {(id) => (
              <select id={id} className="control" value={marketId ?? ''}
                onChange={(e) => setSel(Number(e.target.value))}>
                {(markets ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    #{m.id} · {m.payoutUnit} sat/share · b={m.bUnits} · {m.question.slice(0, 40)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button disabled={!!busy || blocked}
            onClick={() => void act('create market', () => api.createMarket({
              question: question.trim() || `Market ${new Date().toISOString().slice(0, 16)}`, bUnits, payoutUnit,
            }))}>new market</Button>
        </div>

        <div className="newmarket-grid">
          <Field label="question">
            {(id) => (
              <input id={id} className="control" value={question} placeholder="Will X happen by …?"
                onChange={(e) => setQuestion(e.target.value)} />
            )}
          </Field>
          <Field label="b (liquidity)">
            {(id) => (
              <input id={id} className="control" type="number" min={1} max={100000} value={bUnits}
                onChange={(e) => setBUnits(Math.max(1, Number(e.target.value) || 1))} />
            )}
          </Field>
          <Field label="sat per winning share">
            {(id) => (
              <input id={id} className="control" type="number" min={1} max={1000000} value={payoutUnit}
                onChange={(e) => setPayoutUnit(Math.max(1, Number(e.target.value) || 1))} />
            )}
          </Field>
        </div>
        <p className="tiny muted">
          Lower <b>b</b> = a steeper curve: each bet moves the price more.{' '}
          <b>{preview.map((p) => `${p.n} buys → ${p.price}`).join(' · ')}</b> (out of {payoutUnit} sat).{' '}
          It is also your exposure — the most this market can lose is <b>b · ln2 · payout</b> ≈{' '}
          <b>{sats(maxLoss)} sat</b>, which you underwrite.
        </p>

        {market && (
          <>
            {/* Where this market actually is. Six loose buttons never said that. */}
            <ol className="stepper" aria-label="Market lifecycle">
              {STEPS.map((s) => (
                <li key={s} className={`stepper-step${s === step ? ' is-now' : ''}${STEPS.indexOf(s) < STEPS.indexOf(step as any) ? ' is-done' : ''}`}>
                  <span className="stepper-dot" aria-hidden="true" />
                  <span>{s}</span>
                </li>
              ))}
            </ol>

            <div className="row tiny muted">
              <Pill tone="neutral">{market.state}</Pill>
              <span>{market.payoutUnit} sat per winning share</span>
              <span>b={market.bUnits}</span>
              <span>pool v{market.pool?.version ?? '—'}</span>
              {market.resolution && <Pill tone="positive" icon="✓">resolved {market.resolution.toUpperCase()}</Pill>}
            </div>

            {stranded && (
              <Callout tone="danger" title="This pool cannot be spent by the current build.">
                Its locking script <i>is</i> the compiled contract, and the contract has changed since this pool
                was deployed — so every action below would fail at authorize time. Create a fresh market instead.
              </Callout>
            )}

            {debts?.owed?.length > 0 && (
              <Callout tone="warning" title={`This market owes ${sats(debts.owed_sats)} sat to ${debts.owed.length} seller(s).`}>
                Until that is paid it is a real liability, not a rounding detail.
              </Callout>
            )}

            <div className="row">
              <Button disabled={!!busy || blocked || !!market.pool}
                onClick={() => void act('deploy', () => api.deploy(market.id))}>deploy pool</Button>
              <Button disabled={!!busy || blocked || !market.pool || stranded}
                onClick={() => void act('settle', () => api.settle(market.id))}>settle batch</Button>
              <Button disabled={!!busy || blocked || !market.pool || stranded || market.pool?.resolved === 1}
                onClick={() => void act('resolve YES', () => api.resolve(market.id, 'yes'))}>resolve YES</Button>
              <Button disabled={!!busy || blocked || !market.pool || stranded || market.pool?.resolved === 1}
                onClick={() => void act('resolve NO', () => api.resolve(market.id, 'no'))}>resolve NO</Button>
              <Button variant="primary" disabled={!!busy || blocked || stranded || !payout?.winners?.length}
                onClick={() => void act('payout', () => api.payout(market.id))}>pay winners</Button>
              {/*
                Sellers are owed money the moment they sell. Not gated on `stranded`: this pays out of the
                stake pot with ordinary transactions and has nothing to do with the covenant, so a pool this
                build cannot spend is no reason to keep owing people money.
              */}
              <Button variant="primary" tone="warning" disabled={!!busy || blocked || !debts?.owed?.length}
                onClick={() => void act('proceeds', () => api.payProceeds(market.id))}>
                pay sellers{debts?.owed_sats ? ` (${sats(debts.owed_sats)} sat)` : ''}
              </Button>
            </div>

            <StatusMessage status={msg} />
          </>
        )}
      </Card>

      <div className="cols">
        <Card title="Audit" subtitle="Does the on-chain settlement match the receipts traders actually signed?"
          testId="panel-audit">
          {!audit ? <p className="muted">—</p>
            : audit.batches === 0 ? <EmptyState icon="○" title="Nothing settled yet" hint="Settle a batch to create something to audit." />
            : (
              <>
                <StatusMessage status={audit.ok
                  ? { tone: 'positive', text: 'settlements match the signed receipts' }
                  : { tone: 'danger', text: 'MISMATCH — the chain does not match the receipts' }} />
                {audit.reports.map((r: any) => (
                  <div key={r.batchId} className="tiny muted">
                    batch #{r.batchId}: {r.receiptCount} receipts · {r.violations.length} violations ·
                    {r.rabinAttested ? ' attested' : ' not attested'}
                    {r.violations.map((v: any, i: number) => (
                      <div key={i} className="danger-text">✕ {v.check}: {v.detail}</div>
                    ))}
                  </div>
                ))}
              </>
            )}
        </Card>

        <Card title="Winners" testId="panel-winners">
          {!payout?.resolved ? <EmptyState icon="○" title="Market not resolved" hint="Resolve it to see who is owed what." /> : (
            <>
              {payout.winners.length > 0 && (
                <>
                  <div className="list">
                    {payout.winners.map((w: any) => (
                      <div key={w.trader} className="list-row">
                        <code className="truncate grow" title={w.trader}>{w.trader.slice(0, 16)}…</code>
                        <span className="tiny muted">{shares(w.shares)} shares</span>
                        <b className="num">{w.sats} sat</b>
                      </div>
                    ))}
                  </div>
                  <p className="tiny muted">total {sats(payout.total_sats)} sat — paid to the key each trader signed with</p>
                </>
              )}
              {(payout.paid ?? []).length > 0 && (
                <>
                  <Callout tone="positive" title={`Already paid ${sats(payout.paid_sats)} sat on chain`}>
                    Paying again would send REAL money twice.
                  </Callout>
                  <div className="list">
                    {payout.paid.map((p: any) => (
                      <div key={p.trader} className="list-row muted">
                        <code className="truncate grow" title={p.trader}>{p.trader.slice(0, 16)}…</code>
                        <span className="num">{p.sats} sat</span>
                        <code className="tiny" title={p.txid}>{String(p.txid).slice(0, 12)}…</code>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {payout.winners.length === 0 && (payout.paid ?? []).length === 0 && (
                <EmptyState icon="○" title="No winning positions" />
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
