import { api, usePoll } from '../api';
import { Card, EmptyState, Pill, PriceBar, Skeleton } from '../ui';

/**
 * The trader's home: a hero stating the shape of the venue, then one card per market.
 *
 * The odds are a BAR rather than two satoshi figures. "YES 620 · NO 380" requires the reader to do
 * arithmetic against a payout unit before it means anything; a bar filled 62% of the way does not.
 * It is also the thing that visibly MOVES when someone trades, which is the whole point of an LMSR
 * market and was invisible until this morning (ADR-045/046).
 */
export function Markets({ onOpen }: { onOpen: (id: number) => void }) {
  const [markets, err] = usePoll<any[]>(() => api.markets(), []);

  // Only facts that this one call actually supports.
  //
  // A first draft showed "you hold a position" from `m.positions`, which is the MARKET's aggregate
  // across every trader, not this trader's — it would have told everyone they held a position in
  // every traded market. The per-trader figure needs a query per market, so rather than show a
  // plausible-looking wrong number, the home screen shows none. `identity` stays a prop because the
  // header states who you are; repeating it here added nothing and made the page ambiguous.
  const open = (markets ?? []).filter((m) => m.pool && m.pool.resolved !== 1).length;
  const resolved = (markets ?? []).filter((m) => m.resolution).length;

  return (
    <div className="stack">
      <section className="hero">
        <div>
          <div className="hero-label">Prediction markets on BSV</div>
          <div className="hero-value">
            {markets ? markets.length : '—'}
            <small>{markets?.length === 1 ? 'market' : 'markets'}</small>
          </div>
        </div>
        <div className="hero-stats">
          <div>
            <div className="hero-stat-value">{markets ? open : '—'}</div>
            <div className="hero-stat-label">open for trading</div>
          </div>
          <div>
            <div className="hero-stat-value">{markets ? resolved : '—'}</div>
            <div className="hero-stat-label">resolved</div>
          </div>
        </div>
      </section>

      {err && <Card tone="danger" title="Could not load markets">{err}</Card>}

      {!markets && !err && (
        <div className="grid-cards" aria-busy="true" aria-label="Loading markets">
          {[0, 1, 2].map((i) => (
            <div key={i} className="market-card">
              <Skeleton height={18} />
              <Skeleton height={34} />
              <Skeleton height={14} width="60%" />
            </div>
          ))}
        </div>
      )}

      {markets?.length === 0 && (
        <Card>
          <EmptyState
            icon="◎"
            title="No markets yet"
            hint="Create one from the Operator tab — it takes a question, a liquidity setting and a payout per share."
          />
        </Card>
      )}

      {markets && markets.length > 0 && (
        <div className="grid-cards">
          {/* Newest first: the market someone just created is the one they want. */}
          {markets.slice().reverse().map((m) => {
            const stale = m.pool && m.pool.spendable === false;
            return (
              <button key={m.id} className="market-card" data-testid="market-card" onClick={() => onOpen(m.id)}>
                <div className="market-meta">
                  <span className="tiny subtle">#{m.id}</span>
                  {m.resolution && <Pill tone="positive" icon="✓">resolved {m.resolution.toUpperCase()}</Pill>}
                  {stale && <Pill tone="danger" icon="⚠">stale build — unspendable</Pill>}
                  {!m.pool && <Pill tone="neutral" icon="○">not deployed</Pill>}
                </div>

                <div className="market-question">{m.question}</div>

                <PriceBar
                  yesSats={m.prices.yes_sats}
                  noSats={m.prices.no_sats}
                  payoutUnit={m.payoutUnit}
                  size="sm"
                />

                <div className="market-meta tiny subtle">
                  <span>b={m.bUnits}</span>
                  <span>·</span>
                  <span>pool v{m.pool?.version ?? '—'}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
