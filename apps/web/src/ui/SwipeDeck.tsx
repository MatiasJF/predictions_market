// The swipe deck (UI-011) — the screen nothing else in this category has.
//
// A prediction market is a yes/no question. The interface that solved "present a yes/no call" is not
// a banking app, it is a card stack — and it maps onto this product more naturally than onto what it
// was invented for. One market per card, drag right for YES, left for NO.
//
// THE SAFETY LINE, and it is not negotiable: a swipe PICKS A SIDE AND OPENS THE STAKE SHEET. It
// never places a bet. A gesture that spends satoshis is a defect waiting for a jostled elbow, and
// this project has already lost money twice to actions that were easier to take than to understand.
// The wallet approval stays exactly where it is.
//
// Gestures are never the only route either: the two buttons underneath do the same thing, they are
// in the tab order, and the whole deck is operable from a keyboard. A swipe is a shortcut for people
// who have hands free, not a toll gate.
import { useRef, useState, type ReactNode } from 'react';
import './SwipeDeck.css';

/** How far a card must travel before letting go counts as a choice rather than a fidget. */
const COMMIT_PX = 90;

export function SwipeDeck({
  items, onPick, onEmpty, renderCard,
}: {
  items: { key: string | number }[];
  onPick: (index: number, side: 'yes' | 'no') => void;
  onEmpty?: ReactNode;
  renderCard: (item: any, index: number) => ReactNode;
}) {
  const [top, setTop] = useState(0);
  const [dx, setDx] = useState(0);
  const [flying, setFlying] = useState<'yes' | 'no' | null>(null);
  const start = useRef<number | null>(null);

  const item = items[top];
  const intent: 'yes' | 'no' | null = dx > 40 ? 'yes' : dx < -40 ? 'no' : null;

  function choose(side: 'yes' | 'no') {
    if (!item) return;
    setFlying(side);
    // Let the card leave before the sheet arrives, or the animation is wasted behind a scrim.
    setTimeout(() => {
      onPick(top, side);
      setFlying(null);
      setDx(0);
    }, 180);
  }

  function skip() {
    setDx(0);
    setTop((t) => Math.min(t + 1, items.length));
  }

  if (!item) {
    return (
      <div className="deck-empty">
        {onEmpty}
        {items.length > 0 && (
          <button type="button" className="chip" onClick={() => setTop(0)}>start again</button>
        )}
      </div>
    );
  }

  return (
    <div className="deck">
      <div className="deck-stack">
        {/* One card behind the top one, to read as a stack rather than a single card. */}
        {items[top + 1] && (
          <article className="deck-card is-behind" aria-hidden="true">{renderCard(items[top + 1], top + 1)}</article>
        )}

        <article
          className={`deck-card${flying ? ` is-flying-${flying}` : ''}`}
          style={flying ? undefined : { transform: `translateX(${dx}px) rotate(${dx / 26}deg)` }}
          onPointerDown={(e) => { start.current = e.clientX; (e.target as Element).setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (start.current !== null) setDx(e.clientX - start.current); }}
          onPointerUp={() => {
            if (start.current === null) return;
            start.current = null;
            if (dx > COMMIT_PX) choose('yes');
            else if (dx < -COMMIT_PX) choose('no');
            else setDx(0);
          }}
          onPointerCancel={() => { start.current = null; setDx(0); }}
        >
          {/* What the drag is about to do, stated before it happens. */}
          {intent && <span className={`deck-stamp deck-stamp-${intent}`}>{intent.toUpperCase()}</span>}
          {renderCard(item, top)}
        </article>
      </div>

      <div className="deck-actions">
        <button type="button" className="deck-btn deck-btn-no" onClick={() => choose('no')}>
          <span aria-hidden="true">✕</span>
          <span className="sr-only">Back NO on this market</span>
        </button>
        <button type="button" className="deck-btn deck-btn-skip" onClick={skip}>
          <span aria-hidden="true">↷</span>
          <span className="sr-only">Skip this market</span>
        </button>
        <button type="button" className="deck-btn deck-btn-yes" onClick={() => choose('yes')}>
          <span aria-hidden="true">✓</span>
          <span className="sr-only">Back YES on this market</span>
        </button>
      </div>

      <p className="tiny subtle deck-hint">
        Swipe or tap to pick a side — {items.length - top} left. Nothing is bought until you approve the amount.
      </p>
    </div>
  );
}
