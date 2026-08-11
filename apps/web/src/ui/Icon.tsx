// Icons (UI-021) — one stroke-drawn set, no emoji, no dependency.
//
// The app was built from emoji and stray Unicode glyphs (🔍 ◈ ◉ ⚙ ↗ ✓ ⚠). They render differently on
// every platform, they carry their own colour so they ignore the palette, they sit on a different
// baseline from the text beside them, and a screen reader announces them by name. Swapping them for
// one 1.5px stroke set is most of what separates "assembled" from "designed".
//
// Drawn in the Lucide idiom — 24×24 box, 1.5 stroke, round caps — because that is the vocabulary the
// rest of this interface already implies. Inlined rather than installed: a dozen paths do not justify
// a dependency, and the SVG inherits `currentColor` so a caller tints it by setting a text colour.
import type { SVGProps } from 'react';

export type IconName =
  | 'search' | 'trendingUp' | 'trendingDown' | 'layers' | 'wallet' | 'settings'
  | 'check' | 'alert' | 'clock' | 'externalLink' | 'x' | 'plus' | 'compass' | 'receipt'
  | 'circle' | 'inbox' | 'link' | 'minus' | 'zap' | 'globe' | 'arrowLeft' | 'rotateCcw';

const PATHS: Record<IconName, string> = {
  search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16M21 21l-4.35-4.35',
  trendingUp: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  trendingDown: 'M3 7l6 6 4-4 8 8M15 17h6v-6',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  wallet: 'M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11.5 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 11a2 2 0 1 1 0 4z',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
  externalLink: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  rotateCcw: 'M3 3v6h6M3.5 14a9 9 0 1 0 2.1-9.4L3 9',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  minus: 'M5 12h14',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18',
  receipt: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 8h8M8 12h8M8 16h5',
};

export function Icon({
  name, size = 18, ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round"
      // Decorative by default: these sit beside text that already says the same thing, and an icon
      // announced on top of its own label is noise.
      aria-hidden="true" focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
