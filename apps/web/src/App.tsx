import { useEffect, useState } from 'react';
import { api, usePoll } from './api';
import { LocalSigner } from './signer/localSigner';
import { WalletSigner } from './signer/walletSigner';
import type { Signer } from './signer';
import { Markets } from './views/Markets';
import { Market } from './views/Market';
import { Operator } from './views/Operator';

type Tab = 'trade' | 'operator';

export function App() {
  const [signer, setSigner] = useState<Signer | undefined>();
  const [identity, setIdentity] = useState<string>('');
  const [walletAvailable, setWalletAvailable] = useState<boolean | undefined>();
  const [tab, setTab] = useState<Tab>('trade');
  const [marketId, setMarketId] = useState<number | undefined>();
  const [health, healthErr] = usePoll<any>(() => api.health(), [], 5000);
  const network: string | undefined = health?.network;
  const isMainnet = network === 'mainnet';

  // Prefer a REAL wallet; fall back to a dev key only if none is reachable (and say so, loudly).
  useEffect(() => {
    void (async () => {
      const ok = await WalletSigner.available();
      setWalletAvailable(ok);
      const s: Signer = ok ? new WalletSigner() : new LocalSigner();
      setSigner(s);
      setIdentity(await s.identityKey());
    })();
  }, []);

  if (healthErr) {
    return (
      <div className="wrap">
        <h1>BSV Prediction Market</h1>
        <div className="card err">
          <b>Cannot reach the daemon.</b>
          <p>Start it with:</p>
          <pre>PM_ENGINE=scrypt PM_NETWORK=local pnpm --filter @pm/daemon dev</pre>
          <p className="dim">{healthErr}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <header>
        <h1>
          BSV Prediction Market
          {network && (
            <span className={`net ${isMainnet ? 'live' : 'safe'}`}>
              {isMainnet ? 'MAINNET · real money' : `${network} · nothing is broadcast`}
            </span>
          )}
        </h1>
        <nav>
          <button className={tab === 'trade' ? 'on' : ''} onClick={() => setTab('trade')}>Trade</button>
          <button className={tab === 'operator' ? 'on' : ''} onClick={() => setTab('operator')}>Operator</button>
        </nav>
      </header>

      {isMainnet && (
        <div className="card danger">
          <b>This daemon is pointed at MAINNET.</b>
          <p className="dim">
            Authorizing anything in the Operator tab spends <b>real satoshis</b> and cannot be undone. To
            experiment safely, restart the daemon with <code>PM_NETWORK=local</code> — it builds and verifies the
            same real Script but broadcasts nothing.
          </p>
        </div>
      )}

      {walletAvailable === false && (
        <div className="card warn">
          <b>No BSV wallet detected — using a development key held in this browser.</b>
          <p className="dim">
            Orders are still signed and verified, but this is <b>not production custody</b>. Install a BRC-100
            wallet (e.g. MetaNet Desktop) and reload to sign with your real wallet.
          </p>
        </div>
      )}

      <div className="ident">
        <span className={`pill ${signer?.kind === 'wallet' ? 'good' : 'dev'}`}>
          {signer?.kind === 'wallet' ? 'real wallet' : 'dev key'}
        </span>
        <code title={identity}>{identity ? `${identity.slice(0, 24)}…` : 'connecting…'}</code>
        {signer?.kind === 'local' && (
          <button className="link" onClick={() => { LocalSigner.reset(); location.reload(); }}>
            new dev trader
          </button>
        )}
        {health && <span className="dim"> · daemon ok</span>}
      </div>

      {tab === 'trade' &&
        (marketId === undefined ? (
          <Markets onOpen={setMarketId} />
        ) : (
          <Market id={marketId} signer={signer} identity={identity} onBack={() => setMarketId(undefined)} />
        ))}

      {tab === 'operator' && <Operator network={network} authRequired={health?.operator_auth === true} />}
    </div>
  );
}
