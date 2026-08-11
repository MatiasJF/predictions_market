import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Avatar, Button, Card, EmptyState, Pill, Skeleton, Icon} from '../ui';

const WAD = 10n ** 18n;
const shares = (s: string) => Number(BigInt(s) / WAD);
const sats = (n: number) => Number(n).toLocaleString();

/**
 * Everything this trader holds, across every market — the "where do I stand?" screen.
 *
 * It genuinely needs a request per market: the daemon reports positions per market, and there is no
 * endpoint that aggregates across them. That is fine at this scale and honest about the cost; the
 * alternative was inventing an API in a UI ticket, or worse, showing the market's aggregate position
 * and calling it the trader's — which an earlier draft of the home screen actually did.
 */
export function Positions({ identity, onOpen }: { identity: string; onOpen: (id: number) => void }) {
  const [markets] = usePoll<any[]>(() => api.markets(), []);
  const [rows, setRows] = useState<any[] | undefined>();

  useEffect(() => {
    if (!markets || !identity) return;
    let live = true;
    void (async () => {
      const found = await Promise.all(markets.map(async (m) => {
        const [pos, claims] = await Promise.all([
          api.execPositions(m.id, identity).catch(() => null),
          api.payoutClaims(m.id, identity).catch(() => null),
        ]);
        const mine = pos?.positions?.find((p: any) => p.trader === identity);
        const claim = claims?.claims?.find((c: any) => c.trader === identity);
        if (!mine && !claim) return null;
        return { market: m, mine, claim };
      }));
      if (live) setRows(found.filter(Boolean));
    })();
    return () => { live = false; };
  }, [markets, identity]);

  const staked = (rows ?? []).reduce((s, r) => s + (r.mine ? Number(r.mine.netCostSats) : 0), 0);
  const claimable = (rows ?? []).filter((r) => r.claim?.remittance && r.claim.mined_at);

  return (
    <div className="stack">
      <section className="hero">
        <div>
          <div className="hero-label">Staked across all markets</div>
          <div className="hero-value">{rows ? sats(staked) : '—'}<small>sat</small></div>
        </div>
        <div className="hero-stats">
          <div>
            <div className="hero-stat-value">{rows ? rows.length : '—'}</div>
            <div className="hero-stat-label">markets held</div>
          </div>
          <div>
            <div className="hero-stat-value">{rows ? claimable.length : '—'}</div>
            <div className="hero-stat-label">ready to claim</div>
          </div>
        </div>
      </section>

      {!rows && (
        <Card><Skeleton height={20} /><Skeleton height={20} width="70%" /></Card>
      )}

      {rows?.length === 0 && (
        <Card>
          <EmptyState icon={<Icon name="inbox" size={28} />} title="You hold nothing yet"
            hint="Back a side from Discover or Markets and your positions show up here." />
        </Card>
      )}

      {rows && rows.length > 0 && (
        <Card title="Your positions">
          <div className="list">
            {rows.map(({ market, mine, claim }) => {
              const yes = mine ? shares(mine.netYesShares) : 0;
              const no = mine ? shares(mine.netNoShares) : 0;
              const leaning = yes >= no ? 'yes' : 'no';
              return (
                <div key={market.id} className="list-row">
                  <Avatar tone={leaning === 'yes' ? 'positive' : 'negative'}>
                    {leaning.toUpperCase()}
                  </Avatar>
                  <button type="button" className="grow position-link" onClick={() => onOpen(market.id)}>
                    <span className="truncate strong">{market.question}</span>
                    <span className="tiny muted">
                      {yes > 0 && `YES ${yes}`}{yes > 0 && no > 0 && ' · '}{no > 0 && `NO ${no}`}
                      {mine && ` · ${sats(mine.netCostSats)} sat staked`}
                    </span>
                  </button>
                  {claim?.remittance && (
                    claim.mined_at
                      ? <Pill tone="positive" icon={<Icon name="check" size={13} />}>claimable</Pill>
                      : <Pill tone="warning" icon={<Icon name="clock" size={13} />}>waiting for a block</Pill>
                  )}
                  <Button variant="link" size="sm" onClick={() => onOpen(market.id)}>open</Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
