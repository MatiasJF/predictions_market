// UI-001 — operator-token gating on the HTTP router.
//
// Before the web UI the only client was a local CLI, so the daemon had no auth: ANY caller that could reach
// 127.0.0.1:8787 could authorize a broadcast and spend the funding wallet. Once a browser page can talk to it,
// that is no longer acceptable. These tests pin the boundary: money-spending routes require the token, trader
// and read routes do not, and an unset token keeps the old open behaviour for local dev.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type Db } from '@pm/persistence';
import { MockEngine } from '@pm/engine';
import { MarketService, ServiceError } from '../src/service.js';
import { route } from '../src/http.js';

const TOKEN = 'test-operator-token';

function ctx(method: string, path: string, operator: boolean, body: unknown = {}) {
  return {
    method,
    segs: path.split('/').filter(Boolean),
    query: new URLSearchParams(),
    body: async () => body,
    operator,
  };
}

let db: Db;
let svc: MarketService;
const prev = process.env.PM_OPERATOR_TOKEN;
const prevNet = process.env.PM_NETWORK;

beforeEach(async () => {
  process.env.PM_OPERATOR_TOKEN = TOKEN;
  db = openDb(':memory:');
  migrate(db);
  svc = new MarketService(db, new MockEngine());
  await svc.createMarket({ question: 'Will X happen?', bUnits: 1000 });
});
afterEach(() => {
  if (prev === undefined) delete process.env.PM_OPERATOR_TOKEN;
  else process.env.PM_OPERATOR_TOKEN = prev;
  if (prevNet === undefined) delete process.env.PM_NETWORK;
  else process.env.PM_NETWORK = prevNet;
});

/** The routes that move money. Each must refuse an unauthenticated caller. */
const MONEY_ROUTES: [string, string][] = [
  ['POST', '/markets/1/deploy'],
  ['POST', '/markets/1/settle'],
  ['POST', '/markets/1/resolve'],
  ['POST', '/markets/1/payout'],
  ['POST', '/broadcasts/1/authorize'],
  ['POST', '/broadcasts/1/reject'],
];

describe('operator token gating', () => {
  it.each(MONEY_ROUTES)('rejects %s %s without the token', async (method, path) => {
    await expect(route(svc, ctx(method, path, false))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('rejects before doing any work — nothing is queued by a refused call', async () => {
    await expect(route(svc, ctx('POST', '/markets/1/deploy', false))).rejects.toBeInstanceOf(ServiceError);
    const queued = await route(svc, ctx('GET', '/broadcasts', false));
    expect(queued).toEqual([]);
  });

  it('lets a token-bearing operator through', async () => {
    const r = (await route(svc, ctx('POST', '/markets/1/deploy', true))) as any;
    expect(r.broadcast_id).toBeGreaterThan(0);
    expect(r.status).toBe('pending');
  });

  it('leaves reads and trader routes open — an order carries its own signature', async () => {
    await expect(route(svc, ctx('GET', '/markets', false))).resolves.toBeInstanceOf(Array);
    await expect(route(svc, ctx('GET', '/markets/1', false))).resolves.toMatchObject({ id: 1 });
    await expect(route(svc, ctx('GET', '/broadcasts', false))).resolves.toBeInstanceOf(Array);
    await expect(route(svc, ctx('GET', '/wallet/balance', false))).resolves.toBeDefined();
    // An unsigned order is refused by the EXECUTION layer, not by the operator gate — a different 4xx, never 401.
    await expect(route(svc, ctx('POST', '/markets/1/orders', false, { trader: 'x' })))
      .rejects.not.toMatchObject({ status: 401 });
  });

  it('with PM_OPERATOR_TOKEN unset, operator routes stay open (documented dev default)', async () => {
    delete process.env.PM_OPERATOR_TOKEN;
    const r = (await route(svc, ctx('POST', '/markets/1/deploy', false))) as any;
    expect(r.broadcast_id).toBeGreaterThan(0);
  });

  // Reported by a user: clicking "deploy" on a token-protected mainnet daemon returned a bare 401 with no way
  // to tell a missing token from a wrong one. This endpoint lets a client find out BEFORE attempting a spend.
  it('/operator/check confirms a good token and refuses a bad one, without side effects', async () => {
    await expect(route(svc, ctx('GET', '/operator/check', true))).resolves.toMatchObject({ ok: true, required: true });
    await expect(route(svc, ctx('GET', '/operator/check', false))).rejects.toMatchObject({ status: 401 });
    // ...and checking must never queue anything.
    expect(await route(svc, ctx('GET', '/broadcasts', false))).toEqual([]);
  });

  // A client that can't tell mainnet from local will happily authorize a real spend thinking it's a dry run.
  it('/health names the network, engine and whether a token is required', async () => {
    process.env.PM_NETWORK = 'local';
    const h = (await route(svc, ctx('GET', '/health', false))) as any;
    expect(h).toMatchObject({ ok: true, network: 'local', operator_auth: true });
    expect(h.engine).toBeTypeOf('string');

    delete process.env.PM_OPERATOR_TOKEN;
    expect(((await route(svc, ctx('GET', '/health', false))) as any).operator_auth).toBe(false);
  });

  it('a wrong token is not a valid token', async () => {
    // `operator` is computed in createHandler as (want.length > 0 && got === want); a mismatch lands here as false.
    await expect(route(svc, ctx('POST', '/markets/1/deploy', false))).rejects.toMatchObject({ status: 401 });
  });
});
