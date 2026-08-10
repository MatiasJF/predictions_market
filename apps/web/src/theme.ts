// Theme (UI-010): follow the operating system by default, let the user override, remember it.
//
// The old stylesheet had a light palette behind `prefers-color-scheme` and nothing else — no way to
// choose, nothing remembered. Following the OS is the right default (it is what the user already
// told their machine), but "right default" is not the same as "no choice": someone demoing this on
// a projector in a bright room needs to force light, and someone in a dark room needs the opposite,
// regardless of what their laptop decided at 9am.
//
// `null` means "follow the system" and is a real, selectable state rather than merely the absence of
// a choice — hence three modes, not two.
import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | null;

const KEY = 'pm.theme';

export function readTheme(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/**
 * Apply a mode by setting (or clearing) `data-theme` on <html>. Clearing it is what hands control
 * back to the media query — see tokens.css, where dark is defined both inside
 * `prefers-color-scheme` and under `[data-theme="dark"]` so either route reaches the same palette.
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode) root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
}

export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readTheme());

  useEffect(() => { applyTheme(mode); }, [mode]);

  const set = (m: ThemeMode) => {
    if (m) localStorage.setItem(KEY, m);
    else localStorage.removeItem(KEY);
    setMode(m);
  };
  return [mode, set];
}

/** What the user would actually SEE right now — needed to label the toggle honestly. */
export function effectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode) return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}


/* ---------------------------------------------------------------------------------------------
   Surface style — glass or solid.

   Kept ORTHOGONAL to light/dark on purpose. Making "glass" a third theme would have meant four
   palettes to keep in step and, inevitably, one of them drifting. As a surface attribute it is a
   handful of token overrides that compose with whichever palette is active.

   Solid stays the default. Glass costs GPU on every scroll, and it is a preference rather than an
   improvement — some people find it harder to read, which is reason enough not to impose it.
   --------------------------------------------------------------------------------------------- */
export type SurfaceMode = 'solid' | 'glass';

const SURFACE_KEY = 'pm.surface';

export function readSurface(): SurfaceMode {
  return localStorage.getItem(SURFACE_KEY) === 'glass' ? 'glass' : 'solid';
}

export function applySurface(mode: SurfaceMode): void {
  const root = document.documentElement;
  if (mode === 'glass') root.setAttribute('data-surface', 'glass');
  else root.removeAttribute('data-surface');
}

export function useSurface(): [SurfaceMode, (m: SurfaceMode) => void] {
  const [mode, setMode] = useState<SurfaceMode>(() => readSurface());
  useEffect(() => { applySurface(mode); }, [mode]);
  const set = (m: SurfaceMode) => { localStorage.setItem(SURFACE_KEY, m); setMode(m); };
  return [mode, set];
}
