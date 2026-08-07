import { useState } from 'react';

/**
 * Every transaction this daemon has put on chain, with the FULL txid.
 *
 * The point is verifiability: after spending real money the first thing anyone does is look the transaction up,
 * and a truncated `b3fc3b49…` cannot be pasted into a block explorer. So the id is shown whole, is one click to
 * copy, and links straight to WhatsOnChain. On a local run there is nothing to link to — the transaction was
 * built and Script-verified but never broadcast — and the log says so instead of offering a dead link.
 */
export function TxLog({ broadcasts, isMainnet }: { broadcasts: any[]; isMainnet: boolean }) {
  const [copied, setCopied] = useState<string>('');
  const sent = broadcasts.filter((b) => b.status === 'broadcast' && b.txid);

  const totalFee = sent.reduce((s, b) => s + (b.fee_sats ?? 0), 0);
  const totalSize = sent.reduce((s, b) => s + (b.size_bytes ?? 0), 0);

  async function copy(txid: string) {
    try {
      await navigator.clipboard.writeText(txid);
      setCopied(txid);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  }

  return (
    <div className="card">
      <h3>
        On-chain transactions <span className="dim">({sent.length})</span>
        {sent.length > 0 && (
          <span className="dim tiny">
            {' '}· {(totalSize / 1024).toFixed(1)} KB · {totalFee.toLocaleString()} sat in fees
          </span>
        )}
      </h3>
      {sent.length === 0 ? (
        <p className="dim">Nothing broadcast yet.</p>
      ) : (
        <>
          {!isMainnet && (
            <p className="dim tiny">
              Local run — these were built and Script-verified exactly as on mainnet, but never broadcast, so they
              have no explorer entry.
            </p>
          )}
          <div className="txlog">
            {sent.map((b) => (
              <div key={b.id} className="txrow">
                <div className="txhead">
                  <b>#{b.id} {b.kind}</b>
                  <span className="dim tiny">
                    {b.size_bytes ? `${(b.size_bytes / 1024).toFixed(1)} KB` : '—'} ·{' '}
                    {b.fee_sats ? `${b.fee_sats.toLocaleString()} sat` : '—'} · {b.decided_at ?? ''}
                  </span>
                </div>
                <div className="dim tiny">{b.summary}</div>
                <div className="txid">
                  <code>{b.txid}</code>
                  <button className="link" onClick={() => void copy(b.txid)}>
                    {copied === b.txid ? 'copied ✓' : 'copy'}
                  </button>
                  {isMainnet && (
                    <a href={`https://whatsonchain.com/tx/${b.txid}`} target="_blank" rel="noreferrer">
                      WhatsOnChain ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
