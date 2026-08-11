// The five seconds before anyone understands anything (UI-020).
//
// A stranger lands on this app and sees a card with a question and a coloured bar. Nothing on screen
// says what they are looking at, what backing a side costs, or what happens if they are right — and
// in a demo nobody stops to ask, they just nod politely. Three sentences fixes that, and it is the
// cheapest thing in this whole redesign.
//
// It is dismissible and stays dismissed. An explainer that cannot be turned off insults the second
// visit, and one that reappears on every reload is worse than none.
import { useState } from 'react';
import './HowItWorks.css';

const KEY = 'pm.seen.howitworks';

export function HowItWorks({ payoutUnit = 1000 }: { payoutUnit?: number }) {
  const [hidden, setHidden] = useState(() => localStorage.getItem(KEY) === '1');
  if (hidden) return null;

  const dismiss = () => { localStorage.setItem(KEY, '1'); setHidden(true); };

  return (
    <section className="howto" aria-label="How this works">
      <div className="howto-head">
        <h2>Back your view. Get paid if you are right.</h2>
        <button type="button" className="howto-close" onClick={dismiss} aria-label="Dismiss explanation">✕</button>
      </div>

      <ol className="howto-steps">
        <li>
          <span className="howto-num" aria-hidden="true">1</span>
          <div>
            <b>Pick a side</b>
            <p className="tiny muted">
              The bar is the market's own opinion. A YES trading at 620 means the market thinks it is
              about 62% likely.
            </p>
          </div>
        </li>
        <li>
          <span className="howto-num" aria-hidden="true">2</span>
          <div>
            <b>Pay from your own wallet</b>
            <p className="tiny muted">
              You approve the amount in your wallet and it leaves your balance — a real payment on the BSV
              blockchain, which you can look up yourself.
            </p>
          </div>
        </li>
        <li>
          <span className="howto-num" aria-hidden="true">3</span>
          <div>
            <b>Collect if it happens</b>
            <p className="tiny muted">
              Every winning share pays {payoutUnit.toLocaleString()} sat. Buy in at 620 and you make the
              difference; buy in at 300 and you make more, because the market thought you were less likely
              to be right.
            </p>
          </div>
        </li>
      </ol>

      {/* The honest footnote. The price moving as people trade IS the product, not a side effect. */}
      <p className="tiny subtle">
        Prices move with every trade — each bet shifts the odds for the next one. Nothing is bought until you
        approve it in your wallet.
      </p>
    </section>
  );
}
