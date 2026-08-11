import { useState } from 'react';
import { api, usePoll } from '../api';
import type { Signer } from '../signer';
import { AnimatedNumber, EmptyState, HowItWorks, Pill, PriceBar, Sparkline, SwipeDeck } from '../ui';
import { useHistories } from '../useHistories';
import { StakeSheet } from './StakeSheet';

/**
 * Discover — one market at a time, as a yes/no call.
 *
 * The rest of the app lets you study a market. This is for the other mode: working through what is
 * open and forming a view quickly. Picking a side opens the stake sheet with that side chosen; it
 * does not buy anything.
 */
export function Discover({ signer, onOpen, isMainnet }: { signer?: Signer; onOpen: (id: number) => void; isMainnet: boolean }) {
  const [markets] = usePoll<any[]>(() => api.markets(), []);
  const [picked, setPicked] = useState<{ market: any; side: 'yes' | 'no' } | undefined>();
  const histories = useHistories(markets);

  // Only markets you could actually trade. A resolved or unspendable market in a deck is a card you
  // are invited to act on and then refused, which is worse than not showing it.
  const tradable = (markets ?? []).filter(
    (m) => m.pool && m.pool.resolved !== 1 && m.pool.spendable !== false,
  );

  return (
    <div className="stack">
      {/* First thing a stranger sees, until they dismiss it. */}
      <HowItWorks payoutUnit={tradable[0]?.payoutUnit ?? 1000} />

      <SwipeDeck
        items={tradable.map((m) => ({ key: m.id, ...m }))}
        onPick={(i, side) => setPicked({ market: tradable[i], side })}
        onEmpty={
          <EmptyState
            icon="◎"
            title={markets && markets.length > 0 ? "You've seen everything open" : 'No markets yet'}
            hint={markets && markets.length > 0
              ? 'Deploy a new one from the Operator tab, or browse the full list under Markets.'
              : 'Create one from the Operator tab.'}
          />
        }
        renderCard={(m) => (
          <>
            <div className="row">
              <Pill tone="neutral">#{m.id}</Pill>
              <Pill tone="accent">b={m.bUnits}</Pill>
            </div>

            <div className="deck-question">{m.question}</div>

            <div>
              <div className="deck-odds">
                <AnimatedNumber value={Math.round((m.prices.yes_sats / (m.prices.yes_sats + m.prices.no_sats)) * 100)} />%
              </div>
              <div className="deck-odds-label">the market says YES</div>
            </div>

            <PriceBar yesSats={m.prices.yes_sats} noSats={m.prices.no_sats} payoutUnit={m.payoutUnit} />

            <Sparkline values={histories[m.id] ?? []} payoutUnit={m.payoutUnit} height={56}
              label={`YES price history for market ${m.id}`} />

            <div className="deck-foot tiny subtle">
              <span>{m.payoutUnit} sat per winning share</span>
              <button type="button" className="chip" onClick={(e) => { e.stopPropagation(); onOpen(m.id); }}>
                details ↗
              </button>
            </div>
          </>
        )}
      />

      <StakeSheet
        open={!!picked}
        onClose={() => setPicked(undefined)}
        market={picked?.market}
        side={picked?.side ?? 'yes'}
        signer={signer} isMainnet={isMainnet}
      />
    </div>
  );
}
