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

  it('skip moves on without picking a side', () => {
    const onPick = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText('Second question')).toBeTruthy();
  });

  it('counts down what is left, so the deck has an end in sight', () => {
    renderDeck();
    expect(screen.getByText(/3 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    expect(screen.getByText(/2 left/)).toBeTruthy();
  });

  it('says nothing is bought by swiping — the safety line, on screen', () => {
    renderDeck();
    expect(screen.getByText(/Nothing is bought until you approve the amount/)).toBeTruthy();
  });
});
