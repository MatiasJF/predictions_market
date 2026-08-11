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
import { Icon } from './Icon';
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
      // ADVANCE. Without this the card flew out and then snapped straight back, because `flying`
      // reset while `top` still pointed at the same market. The deck moves on whether or not the
      // stake is completed — the sheet already holds its own reference to the market that was
      // picked, so cancelling it does not need the card back.
      setTop((t) => Math.min(t + 1, items.length));
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
        {/*
          An EMPTY shell behind the top card — a silhouette, not a second card.
          
          It used to render the next market's full content, which meant the card underneath was
          legible through and around the one you were meant to be reading: two questions, two sets of
          odds, two graphs, one of them not yours to act on yet. Reported as cards "piled onto each
          other". The stack is worth keeping as a hint that more is coming; the content behind it is
          not, and it was never readable enough to be information anyway.
        */}
        {items[top + 1] && <div className="deck-card is-behind" aria-hidden="true" />}

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
          <Icon name="x" size={20} />
          <span className="sr-only">Back NO on this market</span>
        </button>
        <button type="button" className="deck-btn deck-btn-skip" onClick={skip}>
          <Icon name="rotateCcw" size={18} />
          <span className="sr-only">Skip this market</span>
        </button>
        <button type="button" className="deck-btn deck-btn-yes" onClick={() => choose('yes')}>
          <Icon name="check" size={20} />
          <span className="sr-only">Back YES on this market</span>
        </button>
      </div>

      <p className="tiny subtle deck-hint">
        Swipe or tap to pick a side — {items.length - top} left. Nothing is bought until you approve the amount.
      </p>
    </div>
  );
}
