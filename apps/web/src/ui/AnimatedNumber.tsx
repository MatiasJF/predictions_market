// A number that moves when it changes (UI-020).
//
// The price bar slides when a trade lands, but the figure inside it used to swap instantly — so the
// one thing that makes this product different, a price that MOVES because someone traded, was
// happening too fast to notice. Counting between the two values makes the movement legible, and
// legible movement is the whole difference between "a number" and "a market".
//
// Honest about reduced motion: if the OS has been asked for less of it, the value snaps. Animation
// here is emphasis, never information — the number is always correct at rest either way.
import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function useCountTo(target: number, ms = 420): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const raf = useRef<number>();

  useEffect(() => {
    if (target === from.current) return;
    if (prefersReducedMotion()) { from.current = target; setShown(target); return; }

    const start = performance.now();
    const a = from.current;
    const b = target;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      // Ease out: the number arrives rather than skidding to a stop.
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(a + (b - a) * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); from.current = target; };
  }, [target, ms]);

  return shown;
}

/** The animated value, with the true one always available to assistive tech. */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const shown = useCountTo(value);
  return (
    <span className={className}>
      <span aria-hidden="true">{shown.toLocaleString()}</span>
      {/* Never animate what a screen reader reads: it would announce every intermediate frame. */}
      <span className="sr-only">{value.toLocaleString()}</span>
    </span>
  );
}
