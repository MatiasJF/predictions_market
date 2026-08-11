// Price history (UI-013) — where the market has actually been.
//
// The PriceBar says where the market is NOW. That is one number, and one number cannot tell you
// whether 62% is a market that has been drifting up all day or one that just lurched. For a bonding
// curve — where every fill moves the price by construction — the shape of the movement is most of
// the information, and until now none of it was visible anywhere.
//
// NO NEW API. The series is derived from the receipt ledger the app already fetches. Every fill
// records the price it executed at, so the fills ARE the history.
//
// One subtlety worth stating: a receipt records the price of the side that traded, so a NO fill at
// 380 and a YES fill at 620 describe the same market. LMSR keeps the two exactly complementary
// (`yes + no = payoutUnit`, proven in @pm/lmsr), so a NO price converts to the YES price by
// subtraction with no approximation. Everything below is therefore one honest YES series.
import { Icon } from './Icon';
import './Sparkline.css';

export interface Fill { side: string; price_sats: number }

/** The YES-price series implied by a market's fills, oldest first. */
export function yesSeries(fills: readonly Fill[], payoutUnit: number): number[] {
  return fills.map((f) => (f.side === 'yes' ? f.price_sats : payoutUnit - f.price_sats));
}

export function Sparkline({
  values, payoutUnit, height = 44, label,
}: { values: number[]; payoutUnit: number; height?: number; label?: string }) {
  // One point is not a line. Two identical points are not a trend. Say so rather than drawing a
  // flat line that implies a history the market does not have.
  if (values.length < 2) {
    return (
      <div className="spark spark-empty" style={{ height }}>
        <span className="tiny muted">{values.length === 0 ? 'no trades yet' : 'one trade so far'}</span>
      </div>
    );
  }

  const W = 100;
  const H = 40;
  // Scale to the market's own range rather than 0..payoutUnit, or a market that has moved 500→560
  // renders as a flat line. A floor keeps a tiny move from filling the whole box with noise.
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, payoutUnit * 0.02);
  const min = Math.max(0, lo - pad);
  const max = Math.min(payoutUnit, hi + pad);
  const span = max - min || 1;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / span) * H;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;

  const first = values[0]!;
  const last = values[values.length - 1]!;
  const rising = last >= first;
  const id = `spark-${Math.round(first)}-${Math.round(last)}-${values.length}`;

  return (
    <div className="spark" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={label ?? `YES price history: ${first} to ${last} satoshis over ${values.length} fills`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon className="spark-area" points={area} fill={`url(#${id})`} />
        <polyline className="spark-line" points={line} />
        <circle className="spark-dot" cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="2" />
      </svg>
      {/*
        Direction is stated three ways, and it has to be: colour (green/orange) is meaningless to a
        colour-blind viewer, and the icon is decorative — an <Icon> is aria-hidden, so a screen reader
        would otherwise read "120" with no sign attached. The word carries it. It is visually hidden
        rather than absent so the row stays tight without the meaning going with it.
      */}
      <span className={`spark-delta ${rising ? 'yes-text' : 'no-text'}`} data-testid="spark-delta">
        <Icon name={rising ? 'trendingUp' : 'trendingDown'} size={12} />
        <span className="sr-only">{rising ? 'up' : 'down'} </span>
        {Math.abs(last - first)}
      </span>
    </div>
  );
}
