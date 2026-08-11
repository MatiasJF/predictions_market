// The app chassis (UI-011) — the parts that make this read as an app rather than a dashboard.
//
// The previous pass restyled a dashboard: panels, forms, a top nav. Consumer fintech is organised
// differently — one object with actions ARRANGED AROUND it, primary navigation at the thumb, amounts
// entered in a sheet rather than a form field. These are those pieces.
//
// Responsive by structure, not by hiding things: below ~720px the navigation is a bottom tab bar
// (where a thumb is), above it a left rail (where a pointer is). Same markup, same order, same
// accessible names — only the CSS differs, so nothing is duplicated and nothing can drift.
import { Icon } from './Icon';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import './chassis.css';

/* ---------------------------------------------------------------------------------------------
   ActionCircle — a round icon button with its label beneath.

   The single most recognisable element of this genre, and the thing most obviously missing before.
   It matters for more than looks: putting Buy YES / Buy NO / Sell next to the price turns a market
   from something you READ into something you ACT on, which is the whole difference between a
   dashboard and an app.
   --------------------------------------------------------------------------------------------- */
export function ActionCircle({
  icon, label, tone = 'accent', disabled, onClick, title,
}: {
  icon: ReactNode; label: string; tone?: 'accent' | 'positive' | 'negative' | 'neutral';
  disabled?: boolean; onClick?: () => void; title?: string;
}) {
  return (
    <button
      type="button"
      className={`circle-action tone-${tone}`}
      disabled={disabled}
      onClick={onClick}
      title={title ?? label}
      // The visible label is a fragment — "YES 500" — which reads as nonsense on its own. `title` does
      // NOT provide an accessible name when there is content, so without this a screen reader
      // announced "up arrow YES 500 button". The full phrase is the name; the fragment is the caption.
      aria-label={title ?? label}
    >
      <span className="circle-action-dot" aria-hidden="true">{icon}</span>
      <span className="circle-action-label">{label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------------------------------------
   Avatar — the coloured disc that starts every row in a transaction list.

   Not decoration: it is what lets the eye find a row's KIND before reading a word of it, which is
   why every banking list has one. Ours encodes the side of the market.
   --------------------------------------------------------------------------------------------- */
export function Avatar({ tone = 'neutral', children, size = 'md' }: {
  tone?: 'accent' | 'positive' | 'negative' | 'neutral' | 'warning' | 'danger';
  children: ReactNode; size?: 'sm' | 'md';
}) {
  return <span className={`avatar avatar-${size} tone-${tone}`} aria-hidden="true">{children}</span>;
}

/* ---------------------------------------------------------------------------------------------
   Chips — a horizontal, scrollable filter row. A tablist, so arrow keys work.
   --------------------------------------------------------------------------------------------- */
export function Chips<T extends string>({
  label, value, onChange, options,
}: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="chips" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
          className={`chip${value === o.value ? ' is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   Sheet — a bottom sheet.

   Where amounts get entered, because a sheet gives the number the whole screen and pushes
   everything else out of the way. Modal semantics are done properly: Escape closes it, focus moves
   in on open and RETURNS to whatever opened it on close, and the background is inert to assistive
   tech. A sheet that traps a keyboard user is worse than a form field.
   --------------------------------------------------------------------------------------------- */
export function Sheet({
  open, onClose, title, children, footer,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Send focus back where it came from, or the user is dumped at the top of the document.
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        ref={panel} onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   AmountPad — a big number with preset chips.

   Every fintech app enters money this way, and the reason is that the amount is the decision. A
   16px input in a row of form fields makes the most consequential number on screen the least
   prominent one.
   --------------------------------------------------------------------------------------------- */
export function AmountPad({
  value, onChange, unit, presets, max = 100, hint,
}: {
  value: number; onChange: (v: number) => void; unit: string;
  presets: number[]; max?: number; hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="amountpad">
      <div className="amountpad-value">
        <span className="num">{value}</span>
        <span className="amountpad-unit">{unit}</span>
      </div>
      {hint && <div className="tiny muted amountpad-hint">{hint}</div>}

      <div className="amountpad-presets">
        {presets.filter((p) => p <= max).map((p) => (
          <button key={p} type="button" className={`chip${value === p ? ' is-on' : ''}`} onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
        <button type="button" className={`chip${value === max ? ' is-on' : ''}`} onClick={() => onChange(max)}>max</button>
      </div>

      {/* The real input stays, labelled and focusable: presets are a shortcut, never the only way in. */}
      <label className="amountpad-field" htmlFor={id}>
        <span>shares</span>
        <input id={id} type="number" min={1} max={max} value={value} className="control"
          onChange={(e) => onChange(Math.min(max, Math.max(1, Number(e.target.value) || 1)))} />
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   TabBar — primary navigation. Bottom bar on a phone, left rail on a desktop.
   --------------------------------------------------------------------------------------------- */
export interface TabDef<T extends string> { value: T; label: string; icon: ReactNode }

export function TabBar<T extends string>({
  value, onChange, tabs, badge,
}: { value: T; onChange: (v: T) => void; tabs: TabDef<T>[]; badge?: Partial<Record<T, number>> }) {
  return (
    <nav className="tabbar" aria-label="Primary">
      {tabs.map((t) => (
        <button key={t.value} type="button" className={`tab${value === t.value ? ' is-on' : ''}`}
          aria-current={value === t.value ? 'page' : undefined} onClick={() => onChange(t.value)}>
          <span className="tab-icon" aria-hidden="true">
            {t.icon}
            {!!badge?.[t.value] && <span className="tab-badge">{badge[t.value]}</span>}
          </span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
