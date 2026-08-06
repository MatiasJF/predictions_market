import { useCallback, useEffect, useRef, useState } from 'react';
// Thin client for the daemon's HTTP API. Operator actions carry the operator token; trader actions don't need
// one (an order is already authenticated by the trader's own signature).
const BASE = (import.meta.env.VITE_PM_API as string | undefined) ?? 'http://127.0.0.1:8787';
const TOKEN_KEY = 'pm.operator.token';

export const operatorToken = {
  get: (): string => localStorage.getItem(TOKEN_KEY) ?? '',
  set: (t: string): void => localStorage.setItem(TOKEN_KEY, t),
};

async function call(method: string, path: string, body?: unknown, operator = false): Promise<any> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (operator) headers['x-pm-operator-token'] = operatorToken.get();
  const res = await fetch(BASE + path, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message ?? `${method} ${path} failed (${res.status})`);
  return json;
}

export const api = {
  health: () => call('GET', '/health'),
  markets: () => call('GET', '/markets'),
  market: (id: number) => call('GET', `/markets/${id}`),
  quote: (id: number, side: string, shares: number) => call('GET', `/markets/${id}/quote?side=${side}&shares=${shares}`),
  receipts: (id: number, trader?: string) => call('GET', `/markets/${id}/receipts${trader ? `?trader=${trader}` : ''}`),
  execPositions: (id: number, trader?: string) => call('GET', `/markets/${id}/exec-positions${trader ? `?trader=${trader}` : ''}`),
  audit: (id: number) => call('GET', `/markets/${id}/audit`),
  payoutPreview: (id: number) => call('GET', `/markets/${id}/payout-preview`),
  broadcasts: (status?: string) => call('GET', `/broadcasts${status ? `?status=${status}` : ''}`),
  balance: () => call('GET', '/wallet/balance'),

  // trader
  submitOrder: (id: number, o: unknown) => call('POST', `/markets/${id}/orders`, o),

  // operator (token-gated)
  createMarket: (m: unknown) => call('POST', '/markets', m, true),
  deploy: (id: number) => call('POST', `/markets/${id}/deploy`, {}, true),
  settle: (id: number) => call('POST', `/markets/${id}/settle`, {}, true),
  resolve: (id: number, outcome: string) => call('POST', `/markets/${id}/resolve`, { outcome }, true),
  payout: (id: number) => call('POST', `/markets/${id}/payout`, {}, true),
  authorize: (bid: number) => call('POST', `/broadcasts/${bid}/authorize`, {}, true),
  reject: (bid: number) => call('POST', `/broadcasts/${bid}/reject`, {}, true),
};

/** Poll a loader on an interval. Returns [value, error, refresh]. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], ms = 2500) {
  const [value, setValue] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const savedLoad = useRef(load);
  savedLoad.current = load;

  const refresh = useCallback(async () => {
    try {
      setValue(await savedLoad.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ms]);

  return [value, error, refresh] as const;
}
