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
export function useHistories(markets: any[] | undefined, ms = 4000): Record<number, number[]> {
  const [series, setSeries] = useState<Record<number, number[]>>({});
  // Which markets to ask about — NOT their prices. See below.
  const ids = (markets ?? []).map((m) => m.id).join(',');

  useEffect(() => {
    if (!markets?.length) return;
    let live = true;

    const load = () => {
      void Promise.all(markets.map(async (m) => {
        const r = await api.receipts(m.id).catch(() => null);
        return [m.id, yesSeries((r?.receipts ?? []) as Fill[], m.payoutUnit)] as const;
      })).then((pairs) => { if (live) setSeries(Object.fromEntries(pairs)); });
    };

    load();
    // POLLED, not keyed on the price.
    //
    // The first version re-fetched only when a market's `yes_sats` changed, on the reasoning that a
    // new fill always moves the price. It does — but `yes_sats` is a rounded INTEGER, and with a
    // large `b` a one-share buy moves the true price by a fraction of a satoshi. The rounded value
    // stays put, the key stays identical, and the graph never refetches. Reported as "the graphics
    // are not changing with the orders", and it is the same rounding that made CURVE-001 look like
    // a fixed price: 2 shares cost 1,002 sat while both displayed prices read 500.
    const t = setInterval(load, ms);
    return () => { live = false; clearInterval(t); };
  }, [ids, ms]);

  return series;
}
