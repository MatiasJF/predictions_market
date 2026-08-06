// @vitest-environment jsdom
//
// UI-001 acceptance test — the whole trader/operator journey driven THROUGH THE UI.
//
// This renders the real React app (real api client, real signer, real views) into jsdom and clicks the actual
// buttons. It is not a headless Chrome: there is no layout or paint here. What it does prove is that every
// screen wires to the daemon correctly and that the journey a user actually walks — create → deploy → sign an
// order → settle → audit → resolve → pay winners — works end to end with a human authorizing each broadcast.
//
// It needs a live daemon, so it skips unless one is running:
//   PM_NETWORK=local PM_ENGINE=scrypt PM_OPERATOR_TOKEN=<tok> pnpm --filter @pm/daemon dev
//   PM_UI_E2E=1 PM_OPERATOR_TOKEN=<tok> pnpm vitest run apps/web/test/ui-journey.test.tsx
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { App } from '../src/App';

const API = process.env.VITE_PM_API ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.PM_OPERATOR_TOKEN ?? '';
const ENABLED = process.env.PM_UI_E2E === '1';

// The pool covenant is heavy; each authorized broadcast builds and verifies a real Script.
const WAIT = { timeout: 45_000, interval: 250 };
const LONG = { timeout: 420_000 };

let daemonUp = false;
beforeAll(async () => {
  if (!ENABLED) return;
  daemonUp = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
  localStorage.setItem('pm.operator.token', TOKEN);
});
afterEach(() => cleanup());

/** Click the button whose visible text matches, once it exists and is enabled. */
async function clickWhenReady(name: RegExp, scope?: HTMLElement) {
  const q = scope ? within(scope) : screen;
  const btn = await waitFor(() => {
    const b = q.getByRole('button', { name }) as HTMLButtonElement;
    if (b.disabled) throw new Error(`still disabled: ${name}`);
    return b;
  }, WAIT);
  fireEvent.click(btn);
  return btn;
}

/** The pending rows currently shown in the sign-off queue. */
function queueRows(kind: RegExp): HTMLElement[] {
  const card = screen.getByText(/Sign-off queue/).closest('.card') as HTMLElement;
  return [...card.querySelectorAll('.queue')].filter((r) => kind.test(r.textContent ?? '')) as HTMLElement[];
}

/** Authorize what's sitting in the sign-off queue — the human gate every on-chain action passes through. */
async function authorizeQueue(kind: RegExp) {
  const row = await waitFor(() => {
    const [r] = queueRows(kind);
    if (!r) throw new Error(`no pending ${kind} in the queue`);
    return r;
  }, WAIT);
  await clickWhenReady(/^authorize$/, row);
  // Broadcasting is slow (build + verify a real covenant Script), so give it room — but it MUST leave the queue.
  await waitFor(() => {
    if (queueRows(kind).length > 0) throw new Error(`${kind} still pending`);
  }, { timeout: 180_000, interval: 500 });
}

describe.skipIf(!ENABLED)('UI-001 — full journey through the UI', () => {
  it('create → deploy → signed order → settle → audit → resolve → pay winners', LONG, async () => {
    expect(daemonUp, `daemon not reachable at ${API}`).toBe(true);
    render(<App />);

    // The app comes up, finds no BRC-100 wallet in jsdom, and says so rather than pretending otherwise.
    await waitFor(() => expect(screen.getByText(/daemon ok/)).toBeTruthy(), WAIT);
    // Wallet detection is a probe with a timeout; wait for it to land rather than assuming.
    await waitFor(() => expect(screen.getByText(/No BSV wallet detected/)).toBeTruthy(), WAIT);
    await waitFor(() => expect(screen.getByText(/^0[23][0-9a-f]{6}/)).toBeTruthy(), WAIT);

    // ---- OPERATOR: create + deploy the pool -------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Operator$/ }));
    await clickWhenReady(/new market/);
    await clickWhenReady(/deploy pool/);
    await authorizeQueue(/deploy/i);

    // ---- TRADER: sign and place an order ----------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Trade$/ }));
    const card = await waitFor(() => {
      const b = screen.getAllByRole('button').find((e) => e.className.includes('market'));
      if (!b) throw new Error('no market card');
      return b as HTMLElement;
    }, WAIT);
    fireEvent.click(card);

    await waitFor(() => expect(screen.getByText('Order ticket')).toBeTruthy(), WAIT);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    await clickWhenReady(/sign & buy 5 YES/i);
    // A fill means the daemon verified the signature the browser produced — that is the whole point.
    await waitFor(() => expect(screen.getByText(/filled buy 5 YES/i)).toBeTruthy(), WAIT);

    // The position and the receipt both show up for this trader.
    await waitFor(() => {
      const pos = screen.getByText('My position').closest('.card') as HTMLElement;
      expect(within(pos).getByText(/YES 5/)).toBeTruthy();
    }, WAIT);
    await waitFor(() => {
      const rec = screen.getByText('My receipts').closest('.card') as HTMLElement;
      const rows = [...rec.querySelectorAll('.receipt')];
      expect(rows.length, 'no receipt row').toBe(1);
      expect(rows[0].textContent).toMatch(/buy 5 YES/);
    }, WAIT);

    // ---- OPERATOR: settle the batch on chain ------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Operator$/ }));
    await clickWhenReady(/settle batch/);
    await authorizeQueue(/settle/i);

    // ---- AUDIT: does the chain match the receipts the trader signed? ------------------------------------
    await waitFor(() => {
      const audit = screen.getByText('Audit').closest('.card') as HTMLElement;
      expect(within(audit).getByText(/settlements match the signed receipts/)).toBeTruthy();
    }, WAIT);

    // ---- OPERATOR: resolve YES, then pay the winners ----------------------------------------------------
    await clickWhenReady(/resolve YES/);
    await authorizeQueue(/resolve/i);

    // The payout preview must name a winner before "pay winners" is even clickable.
    const winners = await waitFor(() => {
      const c = screen.getByText('Winners').closest('.card') as HTMLElement;
      if (!within(c).queryByText(/sat$/)) throw new Error('no winners yet');
      return c;
    }, WAIT);
    expect(within(winners).getByText(/5 shares/)).toBeTruthy();

    await clickWhenReady(/pay winners/);
    await authorizeQueue(/payout/i);

    // Broadcast, and the trade is paid.
    const paid = await fetch(`${API}/broadcasts`).then((r) => r.json());
    const payout = paid.find((b: any) => /payout/i.test(b.kind));
    expect(payout?.status, JSON.stringify(payout)).toBe('broadcast');
    expect(payout?.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});
