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
