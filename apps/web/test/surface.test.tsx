// @vitest-environment jsdom
//
// UI-012 — does the glass toggle actually reach the DOM?
//
// Reported as "I don't really see any change", with the shrewd guess that the page background was
// just plain black. Two very different causes look identical from the outside: the attribute never
// being set, or being set and having nothing visible to do. This pins the first, so the question can
// only ever be about the second.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { applySurface, readSurface } from '../src/theme';

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-surface'); });
afterEach(() => cleanup());

describe('surface mode', () => {
  it('defaults to solid, and solid means NO attribute (so the base palette applies untouched)', () => {
    expect(readSurface()).toBe('solid');
    applySurface('solid');
    expect(document.documentElement.hasAttribute('data-surface')).toBe(false);
  });

  it('sets data-surface="glass" on the ROOT element — which is what every glass rule keys off', () => {
    applySurface('glass');
    expect(document.documentElement.getAttribute('data-surface')).toBe('glass');
  });

  it('remembers the choice across a reload', () => {
    localStorage.setItem('pm.surface', 'glass');
    expect(readSurface()).toBe('glass');
  });

  it('the header toggle flips it, and says which state it is in', async () => {
    const { App } = await import('../src/App');
    render(<App />);
    const btn = await screen.findByRole('button', { name: /Surface:/ });
    expect(btn.textContent).toMatch(/solid/);
    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-surface'), 'clicking must reach the DOM').toBe('glass');
    expect(screen.getByRole('button', { name: /Surface:/ }).textContent).toMatch(/glass/);
  });
});

/**
 * The floating bar must belong to the theme it is sitting on.
 *
 * Reported as "theme of the left sidebar is inverted, on light is dark and on dark is light" — and
 * it was exactly that: the bar was painted with `--surface-inverse`, which is by definition the
 * opposite of the current theme. It gave a dark bar in light mode and a light bar in dark mode.
 * Revolut's bar looks dark because their whole page is dark, not because it inverts.
 */
describe('the floating nav bar', () => {
  it('never paints itself with an inverted token', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '..', 'src', 'ui', 'chassis.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ''); // comments explain the bug; they are not the bug
    const bar = css.slice(css.indexOf('.tabbar {'), css.indexOf('.tab-icon'));
    expect(bar, 'the bar must follow the theme, not oppose it').not.toMatch(/--surface-inverse|--text-inverse/);
  });
});
