// @vitest-environment jsdom
//
// UI-015 — the deck shows ONE card and moves on.
//
// Two defects reported by looking at it: the card behind rendered its full content, so a second
// question, a second set of odds and a second graph were legible around and (in glass) through the
// one you were meant to be reading; and picking a side flew the card out and then snapped it back,
// because the deck never advanced.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SwipeDeck } from '../src/ui/SwipeDeck';

afterEach(() => cleanup());

const items = [
  { key: 1, q: 'First question' },
  { key: 2, q: 'Second question' },
  { key: 3, q: 'Third question' },
];
const renderDeck = (onPick = vi.fn()) => {
  render(<SwipeDeck items={items} onPick={onPick} renderCard={(m: any) => <p>{m.q}</p>} />);
  return onPick;
};

describe('SwipeDeck', () => {
  it('renders only the CURRENT market — never the one behind it', () => {
    renderDeck();
    expect(screen.getByText('First question')).toBeTruthy();
    // The stack is a silhouette, not a second card. Its content must not be in the document at all.
    expect(screen.queryByText('Second question'), 'the card behind must render no content').toBeNull();
    expect(screen.queryByText('Third question')).toBeNull();
  });

  it('advances after a pick, instead of snapping the same card back', async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    render(<SwipeDeck items={items} onPick={onPick} renderCard={(m: any) => <p>{m.q}</p>} />);

    fireEvent.click(screen.getByRole('button', { name: /Back YES/ }));
    await act(async () => { vi.advanceTimersByTime(300); });

    expect(onPick).toHaveBeenCalledWith(0, 'yes');
    expect(screen.queryByText('First question'), 'the picked card must not come back').toBeNull();
    expect(screen.getByText('Second question')).toBeTruthy();
    vi.useRealTimers();
  });

  // UI-023 renamed skip to an explicit forward arrow and added its opposite. Browsing in either direction must
  // never pick a side — that is the safety line this file exists to hold.
  it('next moves on without picking a side', () => {
    const onPick = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: /Next market/ }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText('Second question')).toBeTruthy();
  });

  it('back returns to the previous market, and does not pick a side either', () => {
    const onPick = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: /Next market/ }));
    expect(screen.getByText('Second question')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Previous market/ }));
    expect(screen.getByText('First question')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('cannot go back past the first market', () => {
    renderDeck();
    const back = screen.getByRole('button', { name: /Previous market/ }) as HTMLButtonElement;
    expect(back.disabled, 'nothing to go back to').toBe(true);
  });

  it('counts down what is left, so the deck has an end in sight', () => {
    renderDeck();
    expect(screen.getByText(/3 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Next market/ }));
    expect(screen.getByText(/2 left/)).toBeTruthy();
  });

  it('says nothing is bought by swiping — the safety line, on screen', () => {
    renderDeck();
    expect(screen.getByText(/Nothing is bought until you approve the amount/)).toBeTruthy();
  });
});

/**
 * A layout contract, checked in the stylesheet because jsdom does not lay anything out.
 *
 * The card used to be `position: absolute; inset: 0` inside a fixed-height stack, so it was pinned to
 * 380px regardless of what it held — and once the price graph was added, every card held more than
 * that and spilled out of the bottom. Overlaying via grid keeps the cards stacked while letting the
 * container take the height of the tallest one.
 */
describe('deck layout', () => {
  it('does not pin a card to a fixed box — it must grow to hold its content', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '..', 'src', 'ui', 'SwipeDeck.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const card = css.slice(css.indexOf('.deck-card {'), css.indexOf('.deck-card:active'));
    expect(card, 'a card pinned with inset:0 cannot grow past its container').not.toMatch(/position:\s*absolute/);
    expect(card, 'cards overlay by sharing one grid cell').toMatch(/grid-area:\s*1\s*\/\s*1/);
    expect(card, 'the height rule must be a floor, not a ceiling').toMatch(/min-height/);

    const stack = css.slice(css.indexOf('.deck-stack {'), css.indexOf('.deck-card {'));
    expect(stack, 'the stack must size to its tallest card').not.toMatch(/min-height|height:\s*\d/);
  });
});

/**
 * UI-026 — YES sits to the LEFT of NO in the action row.
 *
 * Asked for explicitly, and worth pinning because it is the kind of ordering a later refactor "tidies"
 * back. Order is read off the DOM rather than from a class, so it is the order a person actually sees.
 */
describe('SwipeDeck button order', () => {
  it('puts YES left and NO right', () => {
    renderDeck();
    const labels = screen.getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => /Back (YES|NO)/.test(t));
    expect(labels.map((t) => (t.includes('YES') ? 'yes' : 'no'))).toEqual(['yes', 'no']);
  });
});
