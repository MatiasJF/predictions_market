// @vitest-environment jsdom
//
// UI-020 — the first five seconds, and a number that moves.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { HowItWorks } from '../src/ui/HowItWorks';
import { AnimatedNumber } from '../src/ui/AnimatedNumber';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('HowItWorks', () => {
  it('explains the three things a stranger needs before anything else makes sense', () => {
    render(<HowItWorks payoutUnit={1000} />);
    expect(screen.getByText(/Pick a side/)).toBeTruthy();
    expect(screen.getByText(/Pay from your own wallet/)).toBeTruthy();
    expect(screen.getByText(/Collect if it happens/)).toBeTruthy();
    // The payout is the market's, not a hard-coded 1000.
    cleanup();
    render(<HowItWorks payoutUnit={100_000} />);
    expect(screen.getByText(/100,000 sat/)).toBeTruthy();
  });

  it('stays dismissed — an explainer that reappears every reload is worse than none', () => {
    const { unmount } = render(<HowItWorks />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByText(/Pick a side/)).toBeNull();
    unmount();
    render(<HowItWorks />);
    expect(screen.queryByText(/Pick a side/), 'it must not come back on the next visit').toBeNull();
  });
});

describe('AnimatedNumber', () => {
  it('always exposes the TRUE value to assistive tech, never a frame mid-count', async () => {
    const { rerender } = render(<AnimatedNumber value={500} />);
    rerender(<AnimatedNumber value={620} />);
    // Whatever the visible digits are doing, the announced value is the real one.
    expect(screen.getByText('620', { selector: '.sr-only' })).toBeTruthy();
  });

  it('arrives at the target', async () => {
    const { rerender } = render(<AnimatedNumber value={500} />);
    rerender(<AnimatedNumber value={620} />);
    await waitFor(() => {
      const visible = document.querySelector('[aria-hidden="true"]')!.textContent;
      expect(visible).toBe('620');
    }, { timeout: 2000 });
  });

  it('snaps instead of counting when the OS asks for less motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<AnimatedNumber value={500} />);
    rerender(<AnimatedNumber value={620} />);
    expect(document.querySelector('[aria-hidden="true"]')!.textContent, 'no tween for reduced motion').toBe('620');
    vi.unstubAllGlobals();
  });
});
