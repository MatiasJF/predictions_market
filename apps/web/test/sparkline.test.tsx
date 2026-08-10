// @vitest-environment jsdom
//
// UI-013 — the price history has to be the price history.
//
// A graph is the easiest thing in an interface to get quietly wrong: it renders, it looks plausible,
// and nobody checks the arithmetic. The conversion here is the risky part — a receipt records the
// price of the side that traded, so a NO fill and a YES fill describe the same market from opposite
// ends, and mixing them up plots a market's history upside down.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Sparkline, yesSeries } from '../src/ui/Sparkline';

afterEach(() => cleanup());

describe('yesSeries', () => {
  it('leaves YES fills alone', () => {
    expect(yesSeries([{ side: 'yes', price_sats: 620 }], 1000)).toEqual([620]);
  });

  it('flips NO fills into the YES price — they describe the same market', () => {
    // LMSR keeps the two sides exactly complementary, so this is subtraction, not an approximation.
    expect(yesSeries([{ side: 'no', price_sats: 380 }], 1000)).toEqual([620]);
  });

  it('produces ONE coherent series from a mix of both sides', () => {
    const fills = [
      { side: 'yes', price_sats: 500 },
      { side: 'no', price_sats: 440 },  // → YES 560
      { side: 'yes', price_sats: 620 },
    ];
    expect(yesSeries(fills, 1000)).toEqual([500, 560, 620]);
  });

  it('respects a market\'s own payout unit rather than assuming 1000', () => {
    expect(yesSeries([{ side: 'no', price_sats: 30_000 }], 100_000)).toEqual([70_000]);
  });
});

describe('Sparkline', () => {
  it('refuses to draw a trend from too few points', () => {
    render(<Sparkline values={[]} payoutUnit={1000} />);
    expect(screen.getByText('no trades yet')).toBeTruthy();
    cleanup();
    render(<Sparkline values={[500]} payoutUnit={1000} />);
    // One point is not a line, and a flat line would imply a history the market does not have.
    expect(screen.getByText('one trade so far')).toBeTruthy();
  });

  it('states the move in words, so the shape is not the only signal', () => {
    render(<Sparkline values={[500, 562, 620]} payoutUnit={1000} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toMatch(/500 to 620/);
    expect(screen.getByText(/▲ 120/)).toBeTruthy();
  });

  it('marks a fall as a fall', () => {
    render(<Sparkline values={[620, 500]} payoutUnit={1000} />);
    expect(screen.getByText(/▼ 120/)).toBeTruthy();
  });

  it('scales to the market\'s own range, so a small move is still visible', () => {
    render(<Sparkline values={[500, 502]} payoutUnit={1000} />);
    const pts = screen.getByRole('img').querySelector('polyline')!.getAttribute('points')!;
    const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
    // Against a fixed 0..1000 axis these two would be the same pixel and the line would look dead.
    expect(Math.abs(ys[0]! - ys[1]!), 'a 2-sat move must still render as a slope').toBeGreaterThan(1);
  });
});
