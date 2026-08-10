// @vitest-environment jsdom
//
// UI-001 acceptance test — the whole trader/operator journey driven THROUGH THE UI.
//
// This renders the real React app (real api client, real signer, real views) into jsdom and clicks the actual
// buttons. It is not a headless Chrome: there is no layout or paint here. What it does prove is that every
// screen wires to the daemon correctly and that the journey a user actually walks — create → deploy → sign an
// order → settle → audit → resolve → pay winners — works end to end with a human authorizing each broadcast.
//
// UI-010 STAGE 0 — this test is the CONTRACT the redesign has to satisfy.
//
// It used to find elements by CSS class (`closest('.card')`, `querySelectorAll('.queue')`,
// `className.includes('market')`), which made it a test of the stylesheet as much as of the app. Rewriting the
// UI and its only regression test together would have proved nothing, so the selectors were moved to roles,
// labels and explicit test ids FIRST, and proved green against the unchanged UI. Everything below is now
// indifferent to how the app looks — which is the point, and which is why the next restyle is free.
//
// Rules for anyone editing this file: identify things the way a user or a screen reader would (role + name),
// or by an explicit `data-testid` that names the THING and not its appearance. Never by class.
//
// It needs a live daemon, so it skips unless one is running:
//   PM_PORT=8799 PM_NETWORK=local PM_ENGINE=scrypt PM_OPERATOR_TOKEN=<tok> pnpm --filter @pm/daemon dev
//   PM_UI_E2E=1 VITE_PM_API=http://127.0.0.1:8799 PM_OPERATOR_TOKEN=<tok> pnpm vitest run apps/web/test/ui-journey.test.tsx
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
  const health = await fetch(`${API}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  daemonUp = health !== null;

  // This test creates markets and AUTHORIZES BROADCASTS. Against a mainnet daemon that spends real satoshis on
  // every run. The default port is the one an operator's real daemon also uses, so refuse rather than trust the
  // environment to be pointed somewhere harmless.
  if (health && health.network === 'mainnet') {
    throw new Error(
      `REFUSING TO RUN: ${API} is a MAINNET daemon. This test authorizes broadcasts and would spend real money. ` +
      'Start a local daemon (PM_NETWORK=local) on another port and set VITE_PM_API to it.',
    );
  }
  localStorage.setItem('pm.operator.token', TOKEN);
});
afterEach(() => cleanup());

/** Click the button whose accessible name matches, once it exists and is enabled. */
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

/** A named panel of the UI. `data-testid` names the thing, never its styling. */
const panel = (name: string): HTMLElement => screen.getByTestId(`panel-${name}`);

/**
 * Pending rows in the sign-off queue, selected by the KIND of broadcast rather than by matching a regex against
 * the row's rendered text — the kind is data, the text is presentation.
 */
function queueRows(kind: string): HTMLElement[] {
  return [...panel('signoff').querySelectorAll(`[data-testid="queue-row"][data-kind="${kind}"]`)] as HTMLElement[];
}

/** Authorize what's sitting in the sign-off queue — the human gate every on-chain action passes through. */
async function authorizeQueue(kind: string) {
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

/**
 * Place a PAID buy through the API, the way a funded wallet would: quote an intent, build a transaction paying
 * it, submit both. jsdom has no wallet, so this stands in for the approval step only — the daemon still
 * verifies the payment before it fills, exactly as it would for a real trader.
 */
async function fundedBuyViaApi(units: number): Promise<void> {
  const { LockingScript, PrivateKey, Transaction } = await import('@bsv/sdk');
  const { signOrder } = await import('@pm/execution');

  const marketId = ((await fetch(`${API}/markets`).then((r) => r.json())) as any[]).at(-1).id;
  // Use the SAME key the browser is using, so the fill belongs to the app's own identity and the position /
  // receipts panels light up. LocalSigner keeps it in localStorage, and this test runs in jsdom.
  const wif = localStorage.getItem('pm.dev.trader.wif');
  if (!wif) throw new Error('no dev trader key in localStorage — did the app initialise?');
  const w = PrivateKey.fromWif(wif);
  const trader = w.toPublicKey().toString();

  const intent = await fetch(`${API}/markets/${marketId}/payment-intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trader, side: 'yes', action: 'buy', units }),
  }).then((r) => r.json());

  const tx = new Transaction();
  tx.addOutput({ lockingScript: LockingScript.fromHex(intent.locking_script), satoshis: intent.satoshis });

  const nonce = Date.now();
  const fields = { marketId, trader, side: 'yes' as const, action: 'buy' as const, units: BigInt(units), nonce };
  const res = await fetch(`${API}/markets/${marketId}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      trader, side: 'yes', action: 'buy', units, nonce,
      sig: signOrder(w.toWif(), fields), sigScheme: 'ecdsa',
      intentId: intent.intent_id, paymentTx: tx.toHex(),
    }),
  });
  if (!res.ok) throw new Error(`funded buy failed: ${JSON.stringify(await res.json())}`);
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
    //
    // REGRESSION (reported 2026-08-06): the console used to default to markets[0] — the OLDEST market — and
    // "new market" did not select what it had just created. Against a DB with prior markets that silently
    // pointed every operator action at the wrong market: "deploy pool" looked broken (the old market already
    // had a pool) and settle/resolve acted on a stale one. Creating a second market must move the selection.
    //
    // Counts are RELATIVE to what was already there. This used to assert "there is now exactly 1 market",
    // so the journey only passed against a virgin database and failed on its second run — useless for a test
    // that has to be re-run after every stage of a redesign. Hence the baseline, taken before the first click.
    const marketCount = async () => ((await fetch(`${API}/markets`).then((r) => r.json())) as any[]).length;
    const started = await marketCount();

    fireEvent.click(screen.getByRole('button', { name: /^Operator$/ }));
    await clickWhenReady(/new market/);
    await waitFor(async () => expect(await marketCount()).toBe(started + 1), WAIT); // first create landed
    await clickWhenReady(/new market/);
    const newest = await waitFor(async () => {
      const after = (await fetch(`${API}/markets`).then((r) => r.json())) as any[];
      expect(after.length, 'second market not created yet').toBe(started + 2);
      return Math.max(...after.map((m) => m.id as number));
    }, WAIT);
    await waitFor(() => {
      // By ROLE and name, not by label text alone: the panel is now a landmark also called "Market",
      // so a bare label query is ambiguous. This says which THING is meant — the selector — which is
      // how a screen-reader user would reach it too.
      const sel = screen.getByRole('combobox', { name: /market/i }) as HTMLSelectElement;
      expect(Number(sel.value), 'console must target the market it just created').toBe(newest);
    }, WAIT);

    await clickWhenReady(/deploy pool/);
    await authorizeQueue('deploy');

    // ---- TRADER: sign and place an order ----------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Trade$/ }));
    const card = await waitFor(() => {
      const [first] = screen.getAllByTestId('market-card');
      if (!first) throw new Error('no market card');
      return first as HTMLElement;
    }, WAIT);
    fireEvent.click(card);

    await waitFor(() => expect(panel('order')).toBeTruthy(), WAIT);
    fireEvent.change(screen.getByLabelText(/^shares$/i), { target: { value: '5' } });

    // FUND-001 changed what this step means. A buy is now a real payment, and the dev key jsdom falls back to
    // holds no funds — so the UI must REFUSE, clearly, rather than trade for free. That refusal is the correct
    // behaviour and is asserted here; a funded buy needs a real wallet and is covered by the mainnet run.
    expect(
      within(panel('order')).getByText(/development key holds no funds/i),
      'an unfunded browser must be told it cannot buy',
    ).toBeTruthy();
    await clickWhenReady(/pay & buy 5 YES/i);
    await waitFor(() => expect(screen.getByText(/cannot pay for a bet/i)).toBeTruthy(), WAIT);

    // Fund the fill through the API instead, so the rest of the journey (settle → audit → resolve → payout)
    // is still driven end to end. This is the same two-step the browser performs, minus the wallet.
    await fundedBuyViaApi(5);

    // The position and the receipt both show up for this trader.
    await waitFor(() => {
      expect(within(panel('position')).getByText(/YES 5/)).toBeTruthy();
    }, WAIT);
    await waitFor(() => {
      const rows = within(panel('receipts')).getAllByTestId('receipt-row');
      expect(rows.length, 'no receipt row').toBe(1);
      expect(rows[0]!.textContent).toMatch(/buy 5 YES/);
    }, WAIT);

    // ---- OPERATOR: settle the batch on chain ------------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Operator$/ }));
    await clickWhenReady(/settle batch/);
    await authorizeQueue('settle');

    // ---- AUDIT: does the chain match the receipts the trader signed? ------------------------------------
    await waitFor(() => {
      expect(within(panel('audit')).getByText(/settlements match the signed receipts/)).toBeTruthy();
    }, WAIT);

    // ---- OPERATOR: resolve YES, then pay the winners ----------------------------------------------------
    await clickWhenReady(/resolve YES/);
    await authorizeQueue('resolve');

    // The payout preview must name a winner before "pay winners" is even clickable.
    const winners = await waitFor(() => {
      const c = panel('winners');
      if (!within(c).queryByText(/sat$/)) throw new Error('no winners yet');
      return c;
    }, WAIT);
    expect(within(winners).getByText(/5 shares/)).toBeTruthy();

    await clickWhenReady(/pay winners/);
    await authorizeQueue('payout');

    // Broadcast, and the trade is paid.
    const paid = await fetch(`${API}/broadcasts`).then((r) => r.json());
    const payout = paid.find((b: any) => /payout/i.test(b.kind));
    expect(payout?.status, JSON.stringify(payout)).toBe('broadcast');
    expect(payout?.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});
