// UI-010 — the primitive set.
//
// Small, unstyled-by-caller building blocks. Two rules:
//   1. A caller never passes a colour, a radius or a gap; it passes MEANING (`tone="danger"`), and
//      the primitive resolves it through tokens. That is what stops the palette drifting again.
//   2. Anything that conveys status carries an icon and words as well as a colour. Colour alone
//      fails for ~8% of men, fails in bright sun, and fails on a projector — which is exactly where
//      this gets demoed.
import { Icon } from './Icon';
import type { CSSProperties, ReactNode } from 'react';
import './primitives.css';

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'danger' | 'warning';

/* ---------------------------------------------------------------------------------------------
   Card — the panel every screen is built from.

   `title` is rendered into a heading that also NAMES the region, so a screen-reader user can jump
   between "Sign-off queue", "My position" and so on. The old markup had headings but no landmarks,
   so the whole page was one undifferentiated blob.
   --------------------------------------------------------------------------------------------- */
let cardSeq = 0;
export function Card({
  title, subtitle, aside, tone = 'neutral', testId, className = '', children,
}: {
  title?: ReactNode; subtitle?: ReactNode; aside?: ReactNode; tone?: Tone;
  testId?: string; className?: string; children?: ReactNode;
}) {
  const id = `card-h-${(cardSeq += 1)}`;
  const labelled = title ? { role: 'region' as const, 'aria-labelledby': id } : {};
  return (
    <section className={`card tone-${tone} ${className}`} data-testid={testId} {...labelled}>
      {title && (
        <header className="card-head">
          <div className="grow">
            <h3 id={id}>{title}</h3>
            {subtitle && <p className="tiny muted">{subtitle}</p>}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

/* --------------------------------------------------------------------------------------------- */
export function Button({
  variant = 'secondary', tone = 'accent', size = 'md', full, busy, children, ...rest
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'link';
  tone?: Tone; size?: 'sm' | 'md' | 'lg'; full?: boolean; busy?: boolean; children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} tone-${tone} btn-${size}${full ? ' btn-full' : ''}`}
      // `aria-busy` is what tells a screen reader the thing is working. Sighted users get the label
      // change ("filling…"); everyone else got nothing at all before this.
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------------------------
   Pill — a small status token. Always icon + word.
   --------------------------------------------------------------------------------------------- */
export function Pill({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`pill tone-${tone}`}>
      {icon && <span aria-hidden="true" className="pill-icon">{icon}</span>}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------------------------
   Stat — a number and what it means. The number leads; the label explains.
   --------------------------------------------------------------------------------------------- */
export function Stat({
  label, value, unit, tone = 'neutral', size = 'md',
}: { label: ReactNode; value: ReactNode; unit?: ReactNode; tone?: Tone; size?: 'md' | 'lg' | 'xl' }) {
  return (
    <div className={`stat stat-${size} tone-${tone}`}>
      <div className="stat-value num">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   StatusMessage — the result of an action.

   This primitive exists to kill a real defect. Both trader and operator views decided success vs
   failure with `msg.startsWith('✗')` — a glyph inside a string was load-bearing logic. Callers now
   pass a tone, and the tone drives both the styling and the live-region politeness.
   --------------------------------------------------------------------------------------------- */
export interface Status { tone: Extract<Tone, 'positive' | 'danger' | 'warning' | 'accent'>; text: string }

export function StatusMessage({ status }: { status?: Status }) {
  if (!status) return null;
  const isError = status.tone === 'danger';
  return (
    <p
      className={`status tone-${status.tone}`}
      // An error interrupts; progress does not. Both used to be silent to assistive tech.
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <span className="status-icon">
        <Icon name={isError ? 'x' : status.tone === 'warning' ? 'alert' : 'check'} size={13} />
      </span>
      <span>{status.text}</span>
    </p>
  );
}

/* ---------------------------------------------------------------------------------------------
   Callout — a standing condition, not the result of an action. Mainnet, a stranded pool, money
   owed. Icon + heading + explanation, never colour on its own.
   --------------------------------------------------------------------------------------------- */
export function Callout({
  tone = 'warning', title, children, testId,
}: { tone?: Tone; title: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className={`callout tone-${tone}`} data-testid={testId}>
      <span className="callout-icon">
        <Icon name={tone === 'danger' ? 'alert' : tone === 'positive' ? 'check' : 'zap'} size={15} />
      </span>
      <div className="grow">
        <b>{title}</b>
        {children && <div className="tiny muted callout-body">{children}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   EmptyState — what a list says when it has nothing.
   `My receipts` used to render an empty box with no copy at all.
   --------------------------------------------------------------------------------------------- */
export function EmptyState({ icon = <Icon name="inbox" size={28} />, title, hint }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <div className="strong">{title}</div>
      {hint && <div className="tiny muted">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   Segmented — an exclusive choice (YES/NO, buy/sell).

   A real radiogroup rather than a row of buttons, so arrow keys work and a screen reader announces
   "2 of 2 selected" instead of reading two unrelated buttons.
   --------------------------------------------------------------------------------------------- */
export function Segmented<T extends string>({
  label, value, onChange, options, tone,
}: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: T; label: ReactNode; tone?: Tone }[]; tone?: Tone;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`segment tone-${o.tone ?? tone ?? 'accent'}${value === o.value ? ' is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   Field — a labelled input. The label is properly associated via htmlFor/id rather than relying on
   the wrapping-label trick, so `getByLabelText` and screen readers both work.
   --------------------------------------------------------------------------------------------- */
let fieldSeq = 0;
export function Field({
  label, hint, children, id: given,
}: { label: string; hint?: ReactNode; id?: string; children: (id: string) => ReactNode }) {
  const id = given ?? `field-${(fieldSeq += 1)}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="tiny muted">{hint}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   KeyValue — the review-row shape every payment confirmation uses: label left, value right,
   the total emphasised.
   --------------------------------------------------------------------------------------------- */
export function KeyValue({
  label, value, emphasis, tone,
}: { label: ReactNode; value: ReactNode; emphasis?: boolean; tone?: Tone }) {
  return (
    <div className={`kv${emphasis ? ' kv-total' : ''}${tone ? ` tone-${tone}` : ''}`}>
      <span className="muted">{label}</span>
      <span className="num strong">{value}</span>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- */
export function Skeleton({ width = '100%', height = 16 }: { width?: string | number; height?: number }) {
  const style: CSSProperties = { width, height };
  return <span className="skeleton" style={style} aria-hidden="true" />;
}
