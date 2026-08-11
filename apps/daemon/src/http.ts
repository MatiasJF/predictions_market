// Thin HTTP layer over MarketService. Node built-in http, no framework. Read ops answer now; state-changing
// ops enqueue a broadcast. The router only parses/dispatches/serializes — all logic lives in the service.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { MarketService, ServiceError, EngineLimitation } from './service.js';

interface Ctx { method: string; segs: string[]; query: URLSearchParams; body: () => Promise<any>; operator?: boolean }

/**
 * Operator routes SPEND REAL MONEY (they authorize broadcasts). Before the web UI, the only client was a local
 * CLI, so the daemon had no auth at all. Now that a browser page can reach it, these routes require
 * `x-pm-operator-token` to match `PM_OPERATOR_TOKEN`. Trader routes (placing a signed order, reads) stay open —
 * an order is already authenticated by the trader's own signature.
 *
 * Honest limit: a shared secret over plain HTTP on loopback. Adequate for local operation; NOT a reason to
 * expose the daemon to a network (it still binds 127.0.0.1 only).
 */
const OPERATOR_ACTIONS = new Set(['deploy', 'buy', 'sell', 'resolve', 'redeem', 'settle', 'payout', 'proceeds']);
const operatorTokenRequired = (): string => process.env.PM_OPERATOR_TOKEN ?? '';

function assertOperator(ctx: Ctx): void {
  const want = operatorTokenRequired();
  if (!want) return; // unset → open (dev default, matches previous behaviour)
  if (!ctx.operator) throw new ServiceError(401, 'operator token required for this action', 'unauthorized');
}

function mapError(e: unknown): { status: number; body: object } {
  if (e instanceof EngineLimitation) return { status: 501, body: { error: 'engine_limitation', kind: e.kind, message: e.message, pointer: e.pointer } };
  if (e instanceof ServiceError) return { status: e.status, body: { error: e.code ?? 'error', message: e.message } };
  return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : String(e) } };
}

const readJson = (req: IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) reject(new ServiceError(413, 'body too large')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new ServiceError(400, 'invalid JSON body')); } });
  req.on('error', reject);
});

const intParam = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new ServiceError(400, `${what} must be an integer`);
  return n;
};

/** Resolve a request to a JSON result (or throw). Kept separate from the transport for easy unit testing. */
export async function route(svc: MarketService, ctx: Ctx): Promise<unknown> {
  const { method, segs, query } = ctx;
  const p0 = segs[0];

  // `network` matters to a UI: on mainnet every authorize spends real satoshis, and a page that doesn't say so
  // is a footgun. `operator_auth` lets a client tell "no token needed" from "your token is wrong".
  if (method === 'GET' && segs.length === 1 && p0 === 'health') {
    return {
      ok: true,
      service: 'pm-daemon',
      network: process.env.PM_NETWORK ?? 'mainnet',
      engine: svc.engineName,
      operator_auth: operatorTokenRequired().length > 0,
    };
  }

  if (p0 === 'markets') {
    if (method === 'POST' && segs.length === 1) return svc.createMarket(await ctx.body());
    if (method === 'GET' && segs.length === 1) return svc.listMarkets();
    const id = intParam(segs[1], 'market id');
    if (method === 'GET' && segs.length === 2) return svc.getMarket(id);
    if (method === 'GET' && segs.length === 3 && segs[2] === 'quote') {
      return svc.quote(id, query.get('side') ?? '', intParam(query.get('shares') ?? '1', 'shares'));
    }
    if (method === 'GET' && segs.length === 3 && segs[2] === 'positions') return svc.positions(id);
    if (method === 'GET' && segs.length === 3 && segs[2] === 'receipts') return svc.listReceipts(id, query.get('trader') ?? undefined);
    if (method === 'GET' && segs.length === 3 && segs[2] === 'exec-positions') return svc.execPositions(id, query.get('trader') ?? undefined);
    if (method === 'GET' && segs.length === 3 && segs[2] === 'audit') return svc.auditMarket(id); // CONC-003a
    if (method === 'GET' && segs.length === 3 && segs[2] === 'payout-preview') return svc.payoutPreview(id);
    // FUND-001: how a winner claims their money into their own wallet. Trader-facing and read-only — it hands
    // back the derivation a winner needs to internalize a payout that has already been made to them.
    if (method === 'GET' && segs.length === 3 && segs[2] === 'payouts') {
      return svc.payoutClaims(id, query.get('trader') ?? undefined);
    }
    // …and the prepared `internalizeAction` call for one winner. Separate because it fetches the merkle-proved
    // transaction from the network, so it runs when someone claims rather than on every poll.
    if (method === 'GET' && segs.length === 3 && segs[2] === 'claim') {
      return svc.payoutClaim(id, query.get('trader') ?? '', (query.get('kind') as any) ?? undefined);
    }
    // FUND-001 step 7b: what this market owes sellers, and whether it has paid. Readable by anyone — a trader
    // should be able to see the platform's debt to them without asking the operator.
    if (method === 'GET' && segs.length === 3 && segs[2] === 'debts') return svc.sellDebts(id);
    if (method === 'POST' && segs.length === 3) {
      const body = await ctx.body();
      if (OPERATOR_ACTIONS.has(segs[2] ?? '')) assertOperator(ctx);
      switch (segs[2]) {
        case 'deploy': return svc.enqueueDeploy(id);
        case 'buy': return svc.enqueueBuy(id, body.side, Number(body.shares ?? 1));
        case 'sell': return svc.enqueueSell(id, body.side, Number(body.shares ?? 1));
        case 'resolve': return svc.enqueueResolve(id, body.outcome);
        case 'redeem': return svc.enqueueRedeem(id, body.side, Number(body.shares ?? 1));
        // FUND-001: quote a buy and get a one-time destination to pay it to. Trader-facing, so it is NOT
        // operator-gated — but it spends nothing, it only prices and derives.
        case 'payment-intent': return svc.createPaymentIntent(id, body);
        case 'orders': return svc.submitOrder(id, body); // off-chain instant fill (CONC-001), now paid for
        case 'settle': return svc.enqueueSettle(id); // batch settlement → sign-off queue (CONC-002)
        case 'payout': return svc.enqueuePayout(id); // pay winners on-chain (PAYOUT-001)
        // FUND-001 step 7b: pay sellers what the market owes them, out of the stake pot.
        case 'proceeds': return svc.enqueueProceeds(id);
      }
    }
  }

  if (p0 === 'broadcasts') {
    if (method === 'GET' && segs.length === 1) return svc.listBroadcasts(query.get('status') ?? undefined);
    const id = intParam(segs[1], 'broadcast id');
    if (method === 'GET' && segs.length === 2) return svc.getBroadcast(id);
    if (method === 'POST' && segs.length === 3 && segs[2] === 'authorize') { assertOperator(ctx); return svc.authorize(id); }
    if (method === 'POST' && segs.length === 3 && segs[2] === 'reject') { assertOperator(ctx); return svc.reject(id); }
  }

  // Side-effect-free "is my token accepted?". Without this the only way to find out is to attempt a real spend
  // and read a 401 — which is exactly how a user discovers it at the worst possible moment.
  if (p0 === 'operator' && method === 'GET' && segs[1] === 'check') {
    assertOperator(ctx);
    return { ok: true, required: operatorTokenRequired().length > 0 };
  }

  if (p0 === 'wallet' && method === 'GET' && segs[1] === 'balance') return svc.walletBalance();

  throw new ServiceError(404, `no route for ${method} /${segs.join('/')}`);
}

/** CORS for the local web UI only (the Vite dev server / a local preview). Never a wildcard. */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const ok = !!origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok
    ? {
        'access-control-allow-origin': origin!,
        'access-control-allow-headers': 'content-type, x-pm-operator-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
      }
    : {};
}

export function createHandler(svc: MarketService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);
    const cors = corsHeaders(req.headers.origin);

    if ((req.method ?? '') === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const want = process.env.PM_OPERATOR_TOKEN ?? '';
    const got = String(req.headers['x-pm-operator-token'] ?? '');
    const ctx: Ctx = {
      method: req.method ?? 'GET', segs, query: url.searchParams, body: () => readJson(req),
      operator: want.length > 0 && got === want,
    };
    try {
      const result = await route(svc, ctx);
      const json = JSON.stringify(result ?? null, null, 2);
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(json);
    } catch (e) {
      const { status, body } = mapError(e);
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(body, null, 2));
    }
  };
}

/** Start the daemon. Binds 127.0.0.1 ONLY (never exposes the wallet to the network) — Golden Rule 6 / ADR-010. */
export function startServer(svc: MarketService, port = 8787, host = '127.0.0.1'): Server {
  const server = createServer(createHandler(svc));
  server.listen(port, host);
  return server;
}
