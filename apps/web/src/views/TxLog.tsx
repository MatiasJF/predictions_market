import { useState } from 'react';
import { Button, Card, EmptyState, Pill, TxLink } from '../ui';

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
    <Card
      title="On-chain transactions"
      subtitle={sent.length > 0
        ? `${(totalSize / 1024).toFixed(1)} KB · ${totalFee.toLocaleString()} sat in fees`
        : undefined}
      aside={<Pill tone="neutral">{sent.length}</Pill>}
      testId="panel-txlog"
    >
      {sent.length === 0 ? (
        <EmptyState icon="◇" title="Nothing broadcast yet"
          hint="Authorized actions appear here with their full transaction id." />
      ) : (
        <>
          {!isMainnet && (
            <p className="tiny muted">
              Local run — these were built and Script-verified exactly as on mainnet, but never broadcast, so they
              have no explorer entry.
            </p>
          )}
          <div>
            {sent.map((b) => (
              <div key={b.id} className="txrow">
                <div className="txhead">
                  <b>#{b.id} {b.kind}</b>
                  <span className="tiny muted">
                    {b.size_bytes ? `${(b.size_bytes / 1024).toFixed(1)} KB` : '—'} ·{' '}
                    {b.fee_sats ? `${b.fee_sats.toLocaleString()} sat` : '—'} · {b.decided_at ?? ''}
                  </span>
                </div>
                <div className="tiny muted">{b.summary}</div>
                <div className="txid-row">
                  <code>{b.txid}</code>
                  <Button variant="link" size="sm" onClick={() => void copy(b.txid)}
                    aria-label={`Copy transaction id ${b.txid}`}>
                    {copied === b.txid ? 'copied ✓' : 'copy'}
                  </Button>
                  <TxLink txid={b.txid} isMainnet={isMainnet} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
