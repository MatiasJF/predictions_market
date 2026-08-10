// @vitest-environment jsdom
//
// UI-010 — the two primitives that carry behaviour rather than just looks.
//
// `SlideToConfirm` is the gate in front of every irreversible spend, and `PriceBar` is how a trader
// reads the odds. Both are the kind of component that looks fine and is wrong: a slider that fires
// on a stray click, or a bar whose percentage disagrees with the numbers beside it. Neither is
// something to check by looking at it.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { SlideToConfirm } from '../src/ui/SlideToConfirm';
import { PriceBar } from '../src/ui/PriceBar';
import { StatusMessage } from '../src/ui/primitives';

afterEach(() => cleanup());

const slider = () => screen.getByRole('slider') as HTMLInputElement;
/** Drag the handle to `v` and let go — what a pointer actually does. */
const dragTo = (v: number) => {
  fireEvent.change(slider(), { target: { value: String(v) } });
  fireEvent.pointerUp(slider());
};

describe('SlideToConfirm — the gate on spending real money', () => {
  it('does NOT fire on a nudge: a stray click must never authorize a spend', () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm label="spend 8,180 sat" onConfirm={onConfirm} />);
    dragTo(40);
    expect(onConfirm, 'a partial drag is not an intention').not.toHaveBeenCalled();
    expect(slider().value, 'and the handle snaps back so it never looks half-done').toBe('0');
  });

  it('fires when dragged the whole way', () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm label="spend 8,180 sat" onConfirm={onConfirm} />);
    dragTo(100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires exactly ONCE, however much it is wiggled afterwards', () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm label="spend 8,180 sat" onConfirm={onConfirm} />);
    dragTo(100);
    dragTo(100);
    dragTo(95);
    // Paying twice is the defect that cost 3,000 sat on mainnet (2026-08-06). Not from this control.
    expect(onConfirm, 'a confirm control must be idempotent').toHaveBeenCalledTimes(1);
  });

  it('is operable from the keyboard — the action cannot be pointer-only', () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm label="spend 8,180 sat" onConfirm={onConfirm} />);
    slider().focus();
    fireEvent.keyUp(slider(), { key: 'Enter' });
    expect(onConfirm, 'keyboard and switch users need this action too').toHaveBeenCalledTimes(1);
  });

  it('stays LOCKED until the acknowledgement is ticked (the Kraken pattern)', () => {
    const onConfirm = vi.fn();
    render(
      <SlideToConfirm label="spend 8,180 sat" onConfirm={onConfirm}
        requireAck="I understand this spends real satoshis on mainnet." />,
    );
    expect(slider().disabled, 'the slider must not move before the operator acknowledges').toBe(true);
    dragTo(100);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(slider().disabled).toBe(false);
    dragTo(100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('says WHY it is locked, so the reason is available without seeing the checkbox', () => {
    render(<SlideToConfirm label="spend 8,180 sat" onConfirm={vi.fn()} requireAck="I understand." />);
    expect(slider().getAttribute('aria-label')).toMatch(/tick the acknowledgement first/);
  });

  it('does nothing at all while disabled or busy', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<SlideToConfirm label="go" onConfirm={onConfirm} disabled />);
    dragTo(100);
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<SlideToConfirm label="go" onConfirm={onConfirm} busy />);
    dragTo(100);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('PriceBar — the odds, at a glance', () => {
  it('splits at the true probability, not at the raw satoshi figure', () => {
    render(<PriceBar yesSats={731} noSats={269} payoutUnit={1000} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('73');
    expect(screen.getByText('73%')).toBeTruthy();
    expect(screen.getByText('27%')).toBeTruthy();
  });

  it('starts a fresh market at an even split', () => {
    render(<PriceBar yesSats={500} noSats={500} payoutUnit={1000} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('50');
  });

  it('states the odds in words too — the bar cannot be the only signal', () => {
    render(<PriceBar yesSats={620} noSats={380} payoutUnit={1000} />);
    const label = screen.getByRole('meter').getAttribute('aria-label') ?? '';
    expect(label).toMatch(/YES 62 percent/);
    expect(label).toMatch(/620 of 1000 satoshis/);
  });

  it('survives a loading frame instead of rendering NaN%', () => {
    render(<PriceBar yesSats={0} noSats={0} payoutUnit={0} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('StatusMessage — retiring the ✗-prefix hack', () => {
  it('announces an error assertively and shows an icon, not just a colour', () => {
    render(<StatusMessage status={{ tone: 'danger', text: 'payment not on the network yet' }} />);
    const el = screen.getByRole('alert');
    expect(el.getAttribute('aria-live')).toBe('assertive');
    expect(el.textContent).toMatch(/payment not on the network yet/);
    // Colour alone fails on a projector, in sunlight, and for colour-blind viewers.
    expect(el.querySelector('.status-icon')).toBeTruthy();
  });

  it('announces success politely rather than interrupting', () => {
    render(<StatusMessage status={{ tone: 'positive', text: 'filled buy 5 YES' }} />);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});
