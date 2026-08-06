import { api, usePoll } from '../api';

/** Market list with live YES/NO prices. Prices come straight from the on-chain pool state via the daemon. */
export function Markets({ onOpen }: { onOpen: (id: number) => void }) {
  const [markets, err] = usePoll<any[]>(() => api.markets(), []);

  if (err) return <div className="card err">{err}</div>;
  if (!markets) return <div className="card dim">loading markets…</div>;
  if (markets.length === 0) {
    return (
      <div className="card dim">
        No markets yet. Create one from the <b>Operator</b> tab.
      </div>
    );
  }

  return (
    <div className="grid">
      {markets.map((m) => (
        <button key={m.id} className="card market" onClick={() => onOpen(m.id)}>
          <div className="q">{m.question}</div>
          <div className="prices">
            <span className="yes">YES {m.prices.yes_sats}</span>
            <span className="no">NO {m.prices.no_sats}</span>
          </div>
          <div className="dim row">
            <span className={`state ${m.state}`}>{m.state}</span>
            {m.resolution && <span className="pill good">resolved {m.resolution.toUpperCase()}</span>}
            <span>pool v{m.pool?.version ?? '—'}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
