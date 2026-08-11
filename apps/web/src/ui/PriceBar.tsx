// The bonding curve, made visible (UI-010).
//
// This is the one component that makes the product look like itself. An LMSR market IS a bonding
// curve — every buy moves the price — and until this morning that fact was invisible: `b` was
// hard-coded at 1000 so prices barely moved (ADR-045), and the price shown came from the on-chain
// pool, which only advances at settlement, so it did not move AT ALL between batches (ADR-046).
//
// Both are fixed, and this renders the consequence: a single bar split at the current probability
// that visibly slides when someone trades. A number changing from 500 to 562 is a fact you have to
// read; a bar moving is one you notice.
//
// Accessibility: the split is also stated in text, and the bar exposes itself as a meter so the
// value is available without seeing it. Reduced motion is honoured globally in base.css — the bar
// then snaps rather than slides, which loses the flourish and none of the information.
import { AnimatedNumber, useCountTo } from './AnimatedNumber';
import './PriceBar.css';

export function PriceBar({
  yesSats, noSats, payoutUnit, size = 'md', showLabels = true,
}: {
  yesSats: number; noSats: number; payoutUnit: number;
  size?: 'sm' | 'md' | 'lg'; showLabels?: boolean;
}) {
  // Guard against a zero/absent payout unit rather than rendering NaN% — the daemon always sends
  // one, but a loading frame can arrive first.
  const total = yesSats + noSats;
  const pct = total > 0 ? Math.round((yesSats / total) * 100) : 50;
  // The split animates in CSS; the figures animate here, so both tell the same story at the same speed.
  const shownPct = useCountTo(pct);

  return (
    <div className={`pricebar pricebar-${size}`}>
      <div
        className="pricebar-track"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Market odds: YES ${pct} percent, ${yesSats} of ${payoutUnit} satoshis per winning share`}
      >
        <div className="pricebar-yes" style={{ width: `${pct}%` }}>
          <span className="pricebar-pct num" aria-hidden="true">{shownPct}%</span>
        </div>
        <div className="pricebar-no">
          <span className="pricebar-pct num" aria-hidden="true">{100 - shownPct}%</span>
        </div>
      </div>

      {showLabels && (
        <div className="pricebar-legend">
          <span className="yes-text">
            <AnimatedNumber value={yesSats} className="num strong" /> YES
          </span>
          <span className="subtle tiny">of {payoutUnit} sat per winning share</span>
          <span className="no-text">
            NO <AnimatedNumber value={noSats} className="num strong" />
          </span>
        </div>
      )}
    </div>
  );
}
