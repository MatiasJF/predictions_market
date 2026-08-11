// @vitest-environment jsdom
//
// UI-018 — "see it on the chain", and the one case where the honest thing is to show nothing.
//
// A dead explorer link is worse than no link: on a local run the transaction is built and
// Script-verified exactly as it would be on mainnet and then deliberately NOT broadcast, so a link
// leads to a 404 while implying the money went somewhere. Market.tsx had exactly that bug — its
// claim link pointed at WhatsOnChain regardless of network.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
