// Thin HTTP layer over MarketService. Node built-in http, no framework. Read ops answer now; state-changing
// ops enqueue a broadcast. The router only parses/dispatches/serializes — all logic lives in the service.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { MarketService, ServiceError, EngineLimitation } from './service.js';

interface Ctx { method: string; segs: string[]; query: URLSearchParams; body: () => Promise<any> }

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

  if (method === 'GET' && segs.length === 1 && p0 === 'health') return { ok: true, service: 'pm-daemon' };

  if (p0 === 'markets') {
    if (method === 'POST' && segs.length === 1) return svc.createMarket(await ctx.body());
    if (method === 'GET' && segs.length === 1) return svc.listMarkets();
    const id = intParam(segs[1], 'market id');
    if (method === 'GET' && segs.length === 2) return svc.getMarket(id);
    if (method === 'GET' && segs.length === 3 && segs[2] === 'quote') {
      return svc.quote(id, query.get('side') ?? '', intParam(query.get('shares') ?? '1', 'shares'));
    }
    if (method === 'POST' && segs.length === 3) {
      const body = await ctx.body();
      switch (segs[2]) {
        case 'deploy': return svc.enqueueDeploy(id);
        case 'buy': return svc.enqueueBuy(id, body.side, Number(body.shares ?? 1));
        case 'sell': return svc.enqueueSell(id, body.side, Number(body.shares ?? 1));
        case 'resolve': return svc.enqueueResolve(id, body.outcome);
        case 'redeem': return svc.enqueueRedeem(id, body.side, Number(body.shares ?? 1));
      }
    }
  }

  if (p0 === 'broadcasts') {
    if (method === 'GET' && segs.length === 1) return svc.listBroadcasts(query.get('status') ?? undefined);
    const id = intParam(segs[1], 'broadcast id');
    if (method === 'GET' && segs.length === 2) return svc.getBroadcast(id);
    if (method === 'POST' && segs.length === 3 && segs[2] === 'authorize') return svc.authorize(id);
    if (method === 'POST' && segs.length === 3 && segs[2] === 'reject') return svc.reject(id);
  }

  if (p0 === 'wallet' && method === 'GET' && segs[1] === 'balance') return svc.walletBalance();

  throw new ServiceError(404, `no route for ${method} /${segs.join('/')}`);
}

export function createHandler(svc: MarketService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);
    const ctx: Ctx = { method: req.method ?? 'GET', segs, query: url.searchParams, body: () => readJson(req) };
    try {
      const result = await route(svc, ctx);
      const json = JSON.stringify(result ?? null, null, 2);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json);
    } catch (e) {
      const { status, body } = mapError(e);
      res.writeHead(status, { 'content-type': 'application/json' });
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
