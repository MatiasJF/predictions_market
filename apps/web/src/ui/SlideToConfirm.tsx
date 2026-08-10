// Slide to confirm (UI-010) — the gate on anything that spends real money.
//
// Pattern taken from what fintech actually does for irreversible transfers: Mercury, Wealthfront,
// Zing, Wolt and Kraken all make you drag rather than tap, because a tap is one stray click and a
// drag is an intention. Kraken goes further and keeps the slider DISABLED until you tick an
// acknowledgement — adopted here via `requireAck`, because the operator path authorizes broadcasts
// that have already cost real satoshis by accident once (the double payout of 2026-08-06).
//
// It replaces a two-click "confirm — spend N sat" button. Strictly harder to do by accident, and it
// makes the amount impossible to miss because the amount is written on the thing you drag.
//
// KEYBOARD IS NOT AN AFTERTHOUGHT. A drag-only control would lock out keyboard and switch users
// from the only action that matters. This is a real <input type="range"> under the styling: arrow
// keys and Home/End move it, and releasing below the threshold snaps back exactly as a pointer drag
// does. Everything works without a mouse.
import { useEffect, useId, useRef, useState } from 'react';
import './SlideToConfirm.css';

/** How far along the track counts as "meant it". */
const THRESHOLD = 92;

export function SlideToConfirm({
  label, onConfirm, disabled, busy, tone = 'danger', requireAck,
}: {
  /** Written on the control itself — put the AMOUNT here. */
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'danger' | 'accent';
  /** Text of an acknowledgement that must be ticked before the slider unlocks. */
  requireAck?: string;
}) {
  const [value, setValue] = useState(0);
  const [acked, setAcked] = useState(false);
  const [done, setDone] = useState(false);
  const ackId = useId();
  const fired = useRef(false);

  const locked = Boolean(disabled) || Boolean(busy) || (Boolean(requireAck) && !acked);

  // Reset when it becomes usable again, so a cancelled or failed action doesn't leave the handle
  // stranded mid-track looking like it half-happened.
  useEffect(() => {
    if (locked) { setValue(0); fired.current = false; setDone(false); }
  }, [locked]);

  function commit(v: number) {
    // The lock is enforced HERE, not merely by the input's `disabled` attribute.
    //
    // Found by `ui-primitives.test.tsx`: a programmatically dispatched event reaches the handler
    // even on a disabled input, so the acknowledgement gate and the disabled/busy states could all
    // be bypassed by anything that wasn't a human finger. Relying on the DOM to refuse events is
    // the wrong place for a guard on spending money — the callback itself has to refuse.
    if (locked || done) return;
    if (v >= THRESHOLD && !fired.current) {
      fired.current = true;
      setValue(100);
      setDone(true);
      onConfirm();
      return;
    }
    if (!fired.current) setValue(0); // didn't go far enough — snap back
  }

  return (
    <div className="slide-wrap">
      {requireAck && (
        <label className="slide-ack" htmlFor={ackId}>
          <input
            id={ackId}
            type="checkbox"
            checked={acked}
            disabled={disabled || busy}
            onChange={(e) => setAcked(e.target.checked)}
          />
          <span>{requireAck}</span>
        </label>
      )}

      <div className={`slide tone-${tone}${locked ? ' is-locked' : ''}${done ? ' is-done' : ''}`}>
        <div className="slide-fill" style={{ width: `${value}%` }} aria-hidden="true" />
        <span className="slide-label">{busy ? 'working…' : done ? 'confirmed' : label}</span>
        <input
          className="slide-input"
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={locked || done}
          // A range input is what gives us keyboard and switch access for free. The visible track,
          // fill and handle are styling over the top of it.
          aria-label={requireAck && !acked ? `${label} — tick the acknowledgement first` : label}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => {
            // Enter/Space are the conventional "activate" keys; honour them as a direct confirm so
            // a keyboard user isn't forced to hold an arrow key to 92.
            if (e.key === 'Enter' || e.key === ' ') commit(100);
            else commit(Number((e.target as HTMLInputElement).value));
          }}
          onBlur={(e) => commit(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
