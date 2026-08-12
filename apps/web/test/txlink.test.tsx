// @vitest-environment jsdom
//
// UI-018 — "see it on the chain", and the one case where the honest thing is to show nothing.
//
// A dead explorer link is worse than no link: on a local run the transaction is built and
// Script-verified exactly as it would be on mainnet and then deliberately NOT broadcast, so a link
// leads to a 404 while implying the money went somewhere. Market.tsx had exactly that bug — its
// claim link pointed at WhatsOnChain regardless of network.
import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { TxLink } from '../src/ui/TxLink';

afterEach(() => cleanup());
const TXID = '7c8be78075368f984739426d1d377bc2d2a51baffca16cc1225246a930100585';

describe('TxLink', () => {
  it('links to the transaction on mainnet', () => {
    render(<TxLink txid={TXID} isMainnet />);
    const a = screen.getByRole('link');
    expect(a.getAttribute('href')).toBe(`https://whatsonchain.com/tx/${TXID}`);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });

  it('renders NOTHING off mainnet — a local run has no explorer entry', () => {
    const { container } = render(<TxLink txid={TXID} isMainnet={false} />);
    expect(container.innerHTML, 'a dead link implies the money went somewhere it did not').toBe('');
  });

  it('renders nothing when there is no transaction yet', () => {
    const { container } = render(<TxLink txid={null} isMainnet />);
    expect(container.innerHTML).toBe('');
  });

  it('announces the full txid even when it shows an abbreviation', () => {
    render(<TxLink txid={TXID} isMainnet label="your payment" compact />);
    // On screen it is truncated to fit a row; a screen reader should still get the whole thing.
    expect(screen.getByText(/^7c8be780…$/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe(`your payment — transaction ${TXID}`);
  });
});

/**
 * UI-025 — the transaction log shows the five most recent, and can be opened.
 *
 * It rendered every broadcast ever made. By the end of a demo run that is the longest thing on the page,
 * and it sits above the market controls an operator actually needs, so everything useful is below the
 * fold. Reported as "too big".
 *
 * The two things that must not break while truncating: the NEWEST rows are the ones kept (a log that
 * hides the transaction you just made is worse than a long one), and the totals keep describing the whole
 * log rather than the visible slice.
 */
describe('TxLog', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, kind: 'settle', status: 'broadcast', network: 'mainnet',
    txid: `${i + 1}`.repeat(64).slice(0, 64),
    summary: `settle ${i + 1}`, size_bytes: 1024, fee_sats: 100,
  }));

  it('shows only the five most recent, newest first', async () => {
    const { TxLog } = await import('../src/views/TxLog');
    render(<TxLog broadcasts={rows} isMainnet />);
    const ids = screen.getAllByText(/^#\d+ settle$/).map((e) => e.textContent);
    expect(ids).toEqual(['#8 settle', '#7 settle', '#6 settle', '#5 settle', '#4 settle']);
    expect(screen.queryByText('#3 settle'), 'older rows stay hidden until asked for').toBeNull();
  });

  it('opens the full log on request, and goes back', async () => {
    const { TxLog } = await import('../src/views/TxLog');
    render(<TxLog broadcasts={rows} isMainnet />);
    fireEvent.click(screen.getByRole('button', { name: /show all 8 transactions/ }));
    expect(screen.getAllByText(/^#\d+ settle$/).length).toBe(8);
    fireEvent.click(screen.getByRole('button', { name: /show the 5 most recent/ }));
    expect(screen.getAllByText(/^#\d+ settle$/).length).toBe(5);
  });

  it('totals the WHOLE log, not the visible slice', async () => {
    const { TxLog } = await import('../src/views/TxLog');
    render(<TxLog broadcasts={rows} isMainnet />);
    // 8 rows × 1024 B = 8.0 KB, 8 × 100 = 800 sat — not the 5 on screen.
    expect(screen.getByText(/8\.0 KB · 800 sat in fees/)).toBeTruthy();
  });
});
