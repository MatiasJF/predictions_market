import { useEffect, useState } from 'react';
import { api, usePoll } from './api';
import { LocalSigner } from './signer/localSigner';
import { WalletSigner } from './signer/walletSigner';
import type { Signer } from './signer';
import { Markets } from './views/Markets';
import { Market } from './views/Market';
import { Operator } from './views/Operator';
import { Discover } from './views/Discover';
import { Positions } from './views/Positions';
import { Button, Callout, Card, Pill, TabBar } from './ui';
import { effectiveTheme, useTheme } from './theme';
import './App.css';

type Tab = 'discover' | 'markets' | 'positions' | 'operator';

/**
 * Primary navigation. A bottom bar on a phone, a rail on a desktop — see chassis.css; the markup is
 * identical either way. Four destinations is the ceiling for a tab bar and we are exactly at it.
 */
const TABS = [
  { value: 'discover' as const, label: 'Discover', icon: '◈' },
  { value: 'markets' as const, label: 'Markets', icon: '◉' },
  { value: 'positions' as const, label: 'Positions', icon: '◎' },
  { value: 'operator' as const, label: 'Operator', icon: '⚙' },
];

export function App() {
  const [signer, setSigner] = useState<Signer | undefined>();
  const [identity, setIdentity] = useState<string>('');
  const [walletAvailable, setWalletAvailable] = useState<boolean | undefined>();
  const [tab, setTab] = useState<Tab>('discover');
  const [marketId, setMarketId] = useState<number | undefined>();
  const [health, healthErr] = usePoll<any>(() => api.health(), [], 5000);
  const [theme, setTheme] = useTheme();
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
      <main className="wrap">
        <h1>BSV Prediction Market</h1>
        <Card tone="danger" title="Cannot reach the daemon.">
          <p className="small">Start it with:</p>
          <pre className="code-block">PM_ENGINE=scrypt PM_NETWORK=local pnpm --filter @pm/daemon dev</pre>
          <p className="tiny muted">{healthErr}</p>
        </Card>
      </main>
    );
  }

  const shown = effectiveTheme(theme);

  return (
    <div className="app-shell has-tabbar">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <div className="row grow">
            <span className="brand">BSV Prediction Market</span>
            {/*
              The network badge is the most important pixel on the page. On mainnet every authorize
              spends real satoshis, so it is stated as danger, in words, with an icon — never by
              colour alone, which is unreadable on a projector and to a colour-blind viewer.
            */}
            {network && (
              isMainnet
                ? <Pill tone="danger" icon="⚠">MAINNET · real money</Pill>
                : <Pill tone="neutral" icon="○">{network} · nothing is broadcast</Pill>
            )}
          </div>

          <nav className="row" aria-label="Utilities">
            {/*
              Three states, not two: "follow the system" is a real choice, so cycling returns to it
              rather than stranding the user in whichever mode they last tapped.
            */}
            <Button
              variant="link" tone="neutral" size="sm"
              aria-label={`Theme: ${theme ?? 'system'}. Switch.`}
              title={`Theme: ${theme ?? 'following your system'}`}
              onClick={() => setTheme(theme === null ? (shown === 'dark' ? 'light' : 'dark') : theme === 'dark' ? 'light' : null)}
            >
              {theme === null ? '◐ auto' : theme === 'dark' ? '● dark' : '○ light'}
            </Button>
          </nav>
        </div>
      </header>

      <main className="wrap stack">
        {isMainnet && (
          <Callout tone="danger" title="This daemon is pointed at MAINNET.">
            Authorizing anything in the Operator tab spends <b>real satoshis</b> and cannot be undone. To
            experiment safely, restart the daemon with <code>PM_NETWORK=local</code> — it builds and verifies
            the same real Script but broadcasts nothing.
          </Callout>
        )}

        {walletAvailable === false && (
          <Callout tone="warning" title="No BSV wallet detected — using a development key held in this browser.">
            Orders are still signed and verified, but this is <b>not production custody</b>. Install a BRC-100
            wallet (e.g. MetaNet Desktop) and reload to sign with your real wallet.
          </Callout>
        )}

        <div className="identity">
          <Pill tone={signer?.kind === 'wallet' ? 'positive' : 'warning'} icon={signer?.kind === 'wallet' ? '✓' : '⚑'}>
            {signer?.kind === 'wallet' ? 'real wallet' : 'dev key'}
          </Pill>
          <code className="truncate" title={identity}>{identity ? `${identity.slice(0, 24)}…` : 'connecting…'}</code>
          {signer?.kind === 'local' && (
            <Button variant="link" size="sm" onClick={() => { LocalSigner.reset(); location.reload(); }}>
              new dev trader
            </Button>
          )}
          {health && <span className="tiny subtle"> · daemon ok</span>}
        </div>

        {/*
          A market opened from any tab takes over the content area, and closing it returns you to the
          tab you came from. Keeping `marketId` outside the tab state is what makes that work without
          a router.
        */}
        {marketId !== undefined ? (
          <Market id={marketId} signer={signer} identity={identity} onBack={() => setMarketId(undefined)} />
        ) : (
          <>
            {tab === 'discover' && <Discover signer={signer} onOpen={setMarketId} />}
            {tab === 'markets' && <Markets onOpen={setMarketId} signer={signer} />}
            {tab === 'positions' && <Positions identity={identity} onOpen={setMarketId} />}
            {tab === 'operator' && <Operator network={network} authRequired={health?.operator_auth === true} />}
          </>
        )}
      </main>

      <TabBar value={tab} onChange={(t) => { setMarketId(undefined); setTab(t); }} tabs={TABS} />
    </div>
  );
}
