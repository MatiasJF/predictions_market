// @vitest-environment jsdom
//
// UI-019 — the moment after paying.
//
// A demo lives or dies on this screen: someone has just sent money from their own wallet and the only
// question in their head is "did that really happen?". A line of status text under a form they have
// to re-read is not an answer; a tick, the amount, and a link to their transaction is.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { StakeSheet } from '../src/views/StakeSheet';
import { api } from '../src/api';

const MARKET = { id: 7, question: 'Will X happen?', payoutUnit: 1000, prices: { yes_sats: 500, no_sats: 500 } };
const RAW = '0100000000010000000000000000016a00000000'; // parseable, and that is all this needs

const signer: any = {
  kind: 'wallet',
  identityKey: async () => '02' + 'ab'.repeat(32),
  signOrder: async () => ({ sig: 'aa', sigScheme: 'brc100' }),
  pay: async () => ({ txid: 'ignored', rawTx: RAW }),
  claim: async () => ({ accepted: true }),
};

beforeEach(() => {
  vi.spyOn(api, 'quote').mockResolvedValue({ est_buy_charge_sats: 502 } as any);
  vi.spyOn(api, 'paymentIntent').mockResolvedValue({
    intent_id: 1, locking_script: '76a914' + 'ab'.repeat(20) + '88ac', satoshis: 502, already_paid: false,
  } as any);
  vi.spyOn(api, 'submitOrder').mockResolvedValue({ receipt: { seq: 1, costSats: 502, priceSats: 500 } } as any);
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

const buy = async () => {
  fireEvent.click(screen.getByRole('button', { name: /pay & buy/i }));
  await waitFor(() => expect(screen.getByText(/You now hold/)).toBeTruthy());
};

describe('StakeSheet success state', () => {
  it('answers "did that really happen?" with the amount, the position and a link', async () => {
    render(<StakeSheet open onClose={() => {}} market={MARKET} side="yes" signer={signer} isMainnet />);
    await buy();

    expect(screen.getByText('502')).toBeTruthy();          // what left the wallet
    expect(screen.getByText(/1 YES/)).toBeTruthy();          // what they hold now
    const link = screen.getByRole('link', { name: /See your transaction/i });
    expect(link.getAttribute('href'), 'the link must point at the payment just made')
      .toMatch(/^https:\/\/whatsonchain\.com\/tx\/[0-9a-f]{64}$/);
  });

  it('replaces the form rather than appending to it — the decision is made', async () => {
    render(<StakeSheet open onClose={() => {}} market={MARKET} side="yes" signer={signer} isMainnet />);
    await buy();
    expect(screen.queryByRole('button', { name: /pay & buy/i }), 'the pay button must be gone').toBeNull();
  });

  it('offers no link off mainnet, and says why', async () => {
    render(<StakeSheet open onClose={() => {}} market={MARKET} side="yes" signer={signer} isMainnet={false} />);
    await buy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/not broadcast/)).toBeTruthy();
  });
});
