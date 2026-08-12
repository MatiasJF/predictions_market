import { useState } from 'react';
import { api, usePoll } from '../api';
import type { Signer } from '../signer';
import { ActionCircle, Card, Chips, EmptyState, Icon, Pill, PriceBar, Skeleton, Sparkline } from '../ui';
import { useHistories } from '../useHistories';
import { StakeSheet } from './StakeSheet';

type Filter = 'open' | 'resolved' | 'all';

/**
 * The full list of markets, with the odds as a bar and the two actions that matter attached to each
 * card.
 *
 * Putting Buy YES / Buy NO ON the card is the difference between a directory and an app. It also
 * costs nothing in safety: the circles open the stake sheet with a side chosen, and the sheet still
 * routes through the wallet's own approval.
 */
export function Markets({ onOpen, signer, isMainnet }: { onOpen: (id: number) => void; signer?: Signer; isMainnet: boolean }) {
  const [markets, err] = usePoll<any[]>(() => api.markets(), []);
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ market: any; side: 'yes' | 'no' } | undefined>();
  const histories = useHistories(markets);

  const all = markets ?? [];
  const shown = all
    .filter((m) => (filter === 'all' ? true : filter === 'resolved' ? !!m.resolution : !m.resolution))
    .filter((m) => (q ? String(m.question).toLowerCase().includes(q.toLowerCase()) : true))
    .slice()
    .reverse(); // newest first: the market someone just created is the one they want

  const open = all.filter((m) => m.pool && m.pool.resolved !== 1).length;

  return (
    <div className="stack">
      <section className="hero">
        <div>
          <div className="hero-label">Prediction markets on BSV</div>
          <div className="hero-value">{markets ? all.length : '—'}<small>{all.length === 1 ? 'market' : 'markets'}</small></div>
        </div>
        <div className="hero-stats">
          <div>
            <div className="hero-stat-value">{markets ? open : '—'}</div>
            <div className="hero-stat-label">open for trading</div>
          </div>
          <div>
            <div className="hero-stat-value">{markets ? all.filter((m) => m.resolution).length : '—'}</div>
            <div className="hero-stat-label">resolved</div>
          </div>
        </div>
      </section>

      <div className="stack-sm">
        <label className="searchbar">
          <Icon name="search" size={17} />
          <input
            type="search" className="searchbar-input" value={q} placeholder="Search markets"
            aria-label="Search markets" onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button type="button" className="searchbar-clear" onClick={() => setQ('')} aria-label="Clear search">
              <Icon name="x" size={13} />
            </button>
          )}
        </label>
        <Chips
          label="Filter markets" value={filter} onChange={setFilter}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      {err && <Card tone="danger" title="Could not load markets">{err}</Card>}

      {!markets && !err && (
        <div className="grid-cards" aria-busy="true" aria-label="Loading markets">
          {[0, 1, 2].map((i) => (
            <div key={i} className="market-card">
              <Skeleton height={18} /><Skeleton height={34} /><Skeleton height={14} width="60%" />
            </div>
          ))}
        </div>
      )}

      {markets && shown.length === 0 && (
        <Card>
          <EmptyState
            icon={<Icon name="search" size={28} />}
            title={all.length === 0 ? 'No markets yet' : q ? 'Nothing matches that search' : `No ${filter} markets`}
            hint={all.length === 0
              ? 'Create one from the Operator tab — it takes a question, a liquidity setting and a payout per share.'
              : 'Try another filter, or clear the search.'}
          />
        </Card>
      )}

      <div className="grid-cards">
        {shown.map((m) => {
          const stale = m.pool && m.pool.spendable === false;
          const tradable = m.pool && m.pool.resolved !== 1 && !stale;
          return (
            <article key={m.id} className="market-card" data-testid="market-card">
              <div className="market-meta">
                <span className="meta-chip">#{m.id}</span>
                {m.resolution && <Pill tone="positive" icon={<Icon name="check" size={13} />}>resolved {m.resolution.toUpperCase()}</Pill>}
                {stale && <Pill tone="danger" icon={<Icon name="alert" size={13} />}>stale build — unspendable</Pill>}
                {!m.pool && <Pill tone="neutral" icon={<Icon name="circle" size={13} />}>not deployed</Pill>}
              </div>

              {/* The question is the link into the market — the whole card is not clickable, because
                  the card now contains its own buttons and nesting those inside a button is invalid. */}
              <button type="button" className="market-question market-open" data-testid="market-open"
                onClick={() => onOpen(m.id)}>
                {m.question}
              </button>

              <PriceBar yesSats={m.prices.yes_sats} noSats={m.prices.no_sats} payoutUnit={m.payoutUnit} size="sm" />

              <Sparkline values={histories[m.id] ?? []} payoutUnit={m.payoutUnit} height={40}
                label={`YES price history for market ${m.id}`} />

              <div className="circle-row market-actions">
                <ActionCircle icon={<Icon name="trendingUp" size={22} />} label="YES" tone="positive" disabled={!tradable}
                  title={tradable ? `Back YES at ${m.prices.yes_sats} sat` : 'Trading is closed on this market'}
                  onClick={() => setPicked({ market: m, side: 'yes' })} />
                <ActionCircle icon={<Icon name="trendingDown" size={22} />} label="NO" tone="negative" disabled={!tradable}
                  title={tradable ? `Back NO at ${m.prices.no_sats} sat` : 'Trading is closed on this market'}
                  onClick={() => setPicked({ market: m, side: 'no' })} />
                <ActionCircle icon={<Icon name="externalLink" size={20} />} label="Details" tone="neutral" onClick={() => onOpen(m.id)} />
              </div>

              <div className="meta-row">
                <span className="meta-chip">liquidity <b>b={m.bUnits}</b></span>
                <span className="meta-chip">pays <b>{m.payoutUnit.toLocaleString()} sat</b></span>
                <span className="meta-chip">pool <b>v{m.pool?.version ?? '—'}</b></span>
              </div>
            </article>
          );
        })}
      </div>

      <StakeSheet
        open={!!picked} onClose={() => setPicked(undefined)}
        market={picked?.market} side={picked?.side ?? 'yes'} signer={signer} isMainnet={isMainnet}
      />
    </div>
  );
}
