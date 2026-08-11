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
import { Button, Callout, Card, Icon, Pill, TabBar } from './ui';
import { effectiveTheme, useSurface, useTheme } from './theme';
import './App.css';

type Tab = 'discover' | 'markets' | 'positions' | 'operator';

/**
 * Primary navigation. A bottom bar on a phone, a rail on a desktop — see chassis.css; the markup is
 * identical either way. Four destinations is the ceiling for a tab bar and we are exactly at it.
 */
const TABS = [
  { value: 'discover' as const, label: 'Discover', icon: <Icon name="compass" size={20} /> },
  { value: 'markets' as const, label: 'Markets', icon: <Icon name="layers" size={20} /> },
  { value: 'positions' as const, label: 'Positions', icon: <Icon name="wallet" size={20} /> },
  { value: 'operator' as const, label: 'Operator', icon: <Icon name="settings" size={20} /> },
];

export function App() {
  const [signer, setSigner] = useState<Signer | undefined>();
  const [identity, setIdentity] = useState<string>('');
  const [walletAvailable, setWalletAvailable] = useState<boolean | undefined>();
  const [tab, setTab] = useState<Tab>('discover');
  const [marketId, setMarketId] = useState<number | undefined>();
  const [health, healthErr] = usePoll<any>(() => api.health(), [], 5000);
  const [theme, setTheme] = useTheme();
  const [surface, setSurface] = useSurface();
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
      {/* Something for the blur to work on. Inert, behind everything, glass mode only. */}
      <div className="ambient" aria-hidden="true" />
      <header className="topbar">
        <div className="wrap topbar-inner">
          <div className="row grow">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true" />
              BSV Prediction Market
            </span>
            {/*
              A connection state, not a warning (UI-021). This badge was red and said "MAINNET · real
              money", with a matching red banner underneath. The operator's instruction was to drop
              both, and it is right for a product: everyone using this knows the money is real, and an
              alarm that fires on every screen forever is an alarm nobody reads.

              The caution did not disappear, it moved to where it means something. The sign-off queue
              still names the exact amount and still requires the slider, because that gate is about a
              specific spend at a specific moment rather than a standing condition. Either way the
              state is stated in words with an icon, never by colour alone — colour alone is
              unreadable on a projector and to a colour-blind viewer.
            */}
            {network && (
              isMainnet
                ? <Pill tone="positive" icon={<Icon name="check" size={13} />}>mainnet connected</Pill>
                : <Pill tone="neutral">{network} · nothing is broadcast</Pill>
            )}
          </div>

          <nav className="row" aria-label="Utilities">
            {/*
              Three states, not two: "follow the system" is a real choice, so cycling returns to it
              rather than stranding the user in whichever mode they last tapped.
            */}
            <button
              type="button" className="iconbtn"
              aria-label={`Theme: ${theme ?? 'following your system'}. Switch.`}
              title={`Theme: ${theme ?? 'following your system'}`}
              onClick={() => setTheme(theme === null ? (shown === 'dark' ? 'light' : 'dark') : theme === 'dark' ? 'light' : null)}
            >
              <Icon name={theme === null ? 'settings' : theme === 'dark' ? 'circle' : 'globe'} size={16} />
            </button>
            <button
              type="button" className="iconbtn"
              aria-label={`Surface: ${surface}. Switch.`}
              title={surface === 'glass' ? 'Frosted surfaces' : 'Solid surfaces'}
              onClick={() => setSurface(surface === 'glass' ? 'solid' : 'glass')}
            >
              <Icon name={surface === 'glass' ? 'layers' : 'circle'} size={16} />
            </button>
          </nav>
        </div>
      </header>

      <main className="wrap stack">
        {walletAvailable === false && (
          <Callout tone="warning" title="No BSV wallet detected — using a development key held in this browser.">
            Orders are still signed and verified, but this is <b>not production custody</b>. Install a BRC-100
            wallet (e.g. MetaNet Desktop) and reload to sign with your real wallet.
          </Callout>
        )}

        {/*
          Who you are and what you are connected to, on every page (UI-022).

          This row was a pill, a bare <code> and a `tiny subtle` fragment sitting straight on the page
          wash with nothing behind them — the same "not seen" problem as the market fact row, in the
          one place that answers "am I signed in as the right wallet?". Each fact now sits on its own
          surface at readable contrast, and says what it is: the key is labelled `identity`, not left
          as an unexplained hex string.
        */}
        <div className="identity">
          <Pill tone={signer?.kind === 'wallet' ? 'positive' : 'warning'} icon={signer?.kind === 'wallet' ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />}>
            {signer?.kind === 'wallet' ? 'real wallet' : 'dev key'}
          </Pill>
          <span className="meta-chip" title={identity}>
            identity <b className="mono truncate">{identity ? `${identity.slice(0, 16)}…` : 'connecting…'}</b>
          </span>
          {health && (
            <span className="meta-chip">
              <Icon name="check" size={12} /> daemon ok
            </span>
          )}
          {signer?.kind === 'local' && (
            <Button variant="link" size="sm" onClick={() => { LocalSigner.reset(); location.reload(); }}>
              new dev trader
            </Button>
          )}
        </div>

        {/*
          A market opened from any tab takes over the content area, and closing it returns you to the
          tab you came from. Keeping `marketId` outside the tab state is what makes that work without
          a router.
        */}
        {marketId !== undefined ? (
          <Market id={marketId} signer={signer} identity={identity} isMainnet={isMainnet}
              onBack={() => setMarketId(undefined)} />
        ) : (
          <>
            {tab === 'discover' && <Discover signer={signer} onOpen={setMarketId} isMainnet={isMainnet} />}
            {tab === 'markets' && <Markets onOpen={setMarketId} signer={signer} isMainnet={isMainnet} />}
            {tab === 'positions' && <Positions identity={identity} onOpen={setMarketId} />}
            {tab === 'operator' && <Operator network={network} authRequired={health?.operator_auth === true} />}
          </>
        )}
      </main>

      <TabBar value={tab} onChange={(t) => { setMarketId(undefined); setTab(t); }} tabs={TABS} />
    </div>
  );
}
