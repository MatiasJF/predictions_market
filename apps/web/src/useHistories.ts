import { useEffect, useState } from 'react';
import { api } from './api';
import { yesSeries, type Fill } from './ui';

/**
 * YES-price history for several markets at once.
 *
 * One request per market, because the daemon reports receipts per market and there is no aggregate
 * endpoint. That is a real cost and it is stated rather than hidden: it is bounded by how many
 * markets are on screen, it runs once per market rather than on the 2.5s poll, and the alternative
 * was inventing an API in a styling ticket.
 */
export function useHistories(markets: any[] | undefined): Record<number, number[]> {
  const [series, setSeries] = useState<Record<number, number[]>>({});
  const key = (markets ?? []).map((m) => `${m.id}:${m.prices?.yes_sats}`).join(',');

  useEffect(() => {
    if (!markets?.length) return;
    let live = true;
    void Promise.all(markets.map(async (m) => {
      const r = await api.receipts(m.id).catch(() => null);
      return [m.id, yesSeries((r?.receipts ?? []) as Fill[], m.payoutUnit)] as const;
    })).then((pairs) => { if (live) setSeries(Object.fromEntries(pairs)); });
    return () => { live = false; };
    // Re-fetch when a price moves, which is exactly when the history has gained a point.
  }, [key]);

  return series;
}
