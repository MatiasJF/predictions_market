// "See it on the chain" (UI-018).
//
// The whole claim of this product is that a bet is a real transaction on a public ledger. A user who
// cannot go and look at their own transaction has to take that on trust, which is the one thing a
// blockchain product should never ask for. So wherever the app knows a txid, it offers the link.
//
// IT RENDERS NOTHING OFF MAINNET, and that is the point rather than an omission: a `local` run builds
// and Script-verifies the identical transaction and then deliberately does not broadcast it, so an
// explorer link would lead to a 404 and quietly imply the transaction went somewhere it did not.
// Silence is honest; a dead link is not.
import './TxLink.css';

export function TxLink({
  txid, isMainnet, label = 'View on WhatsOnChain', compact,
}: { txid?: string | null; isMainnet: boolean; label?: string; compact?: boolean }) {
  if (!txid || !isMainnet) return null;
  return (
    <a
      className={`txlink${compact ? ' is-compact' : ''}`}
      href={`https://whatsonchain.com/tx/${txid}`}
      target="_blank"
      rel="noreferrer"
      // The visible text may be an abbreviation; the name a screen reader announces should not be.
      aria-label={`${label} — transaction ${txid}`}
      title={txid}
    >
      <span aria-hidden="true" className="txlink-icon">◈</span>
      <span>{compact ? `${txid.slice(0, 8)}…` : label}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}
