# Demo runbook

**Everything below was verified against the live mainnet daemon on 2026-08-12.** Re-run the pre-flight
before the demo; the market table changes as soon as anyone trades.

---

## 1. Pre-flight (do this ~15 minutes before, not 2)

```bash
nvm use                                  # Node 22 is a hard floor, not a preference
curl -s http://127.0.0.1:8787/health     # expect network:mainnet, operator_auth:true
curl -s http://127.0.0.1:8787/wallet/balance
```

Then, and this is the one people skip:

```bash
# Is the thing serving you as new as the code you fixed?
ps -o etime=,command= -p $(lsof -ti :8787 | head -1) | cut -c1-90
ps -o etime=,command= -p $(lsof -nP -iTCP:5273 -sTCP:LISTEN | awk 'NR==2{print $2}')
```

**Check process AGE first, every time.** This project has lost time to a stale process three separate
times — a daemon older than the fix (twice) and, during this very runbook, a five-hour-old daemon
squatting the port so a freshly launched one died of `EADDRINUSE` and every request was silently
answered by the old one. A process that is older than your last change is not running your last change.

Two environment traps worth knowing before they happen in front of people:

- **Vite binds IPv6 only.** `http://127.0.0.1:5273` returns nothing; `http://localhost:5273` and
  `http://[::1]:5273` work. It looks exactly like a dead server and is not one.
- **`EADDRINUSE` is silent from the outside.** The health check passes because *something* is
  answering. Confirm the port belongs to the process you just started.

Pool spendability — the check that decides whether a live trade is even possible:

```bash
for i in 6 8; do curl -s http://127.0.0.1:8787/markets/$i | grep -o '"spendable":[a-z]*'; done
```

All four live pools were `spendable: true` at time of writing.

> **Rule between now and the demo: do not touch the contract source.** A pool is locked by the
> compiled contract that deployed it. Recompiling strands markets #6 and #8 and the UI will correctly
> refuse to trade them ("stale build — unspendable"), which costs a fresh deploy to fix.

---

## 2. What is actually on chain

This matters more than anything else in the demo, because the product's whole claim is *"your bet is a
real transaction on a public ledger"* — and only some of these markets can prove it.

| Market | Receipts | On chain | Use it for |
|---|---|---|---|
| **#9** — BSV block height past 962,000 | 6 | **6** | **the hero.** Every fill, and deploy/settle/resolve/payout, all on chain |
| **#7** — BSV mainnet fees under 0.1 sat/byte | 2 | **2** | a second complete lifecycle |
| **#8** — take a real bet from a stranger | 2 | 1 | **the live trade.** Deployed, spendable, b=20 |
| #1, #2, #3 | 14 / 11 / 9 | 0 | history and visual richness only |
| #4, #5 | 16 / 8 | 0 | history only |
| #6 | 0 | 0 | a clean market, if you want to start from nothing |

Markets #1–#5 were built and **Script-verified** exactly as on mainnet, then deliberately not
broadcast. Their transactions are real in every sense except that nobody paid to publish them, so the
app shows **no explorer link** for them. That is deliberate: a dead WhatsOnChain link implying a
transaction went somewhere it did not is worse than silence.

**So do not click into #1–#5 and promise the audience a receipt.** Show them for the price curve and
the settled history; go to #7 and #8 for proof.

Market #7's full lifecycle, all clickable at `whatsonchain.com/tx/<txid>`:

| Step | txid | Cost |
|---|---|---|
| deploy | `352df1f3c1ebf215ab4f…` | 51 sat |
| buys (2) | `1925b70a…`, `83c82747…` | ~1,000 sat each |
| settle batch | `f7855ab27dfa5912e2e7…` | 200 sat |
| resolve (oracle) | `bd819f41a16940807959…` | 100 sat |
| payout | `64d577746d0026705b2c…` | 2,200 sat |

Market #9's steps, all on mainnet: deploy `1622ccb1cc3554e85625…` (51 sat), settle `d1b037f05d4f0bdf76d0…`
(200 sat), resolve `e14ec39c23b4eef4dfd2…` (100 sat), payout `e8482fba4702e8c23b02…` (8,200 sat), plus six
buy transactions. It also carries a **rejected** deploy in the log, which is worth showing rather than hiding:
the sign-off queue refusing a broadcast is the gate doing its job.

**Two caveats on #9, both known:**

1. **It was resolved before its own question came true.** The market asks about height 962,000 and was resolved
   YES at height 961,909. It becomes true at 962,000 — check `whatsonchain.com` before pointing an audience at
   this particular question, since the demo invites people to go and verify.
2. **Its price history is a sawtooth**, `541 → 582 → 541 → 582 → 541 → 582`, not a trend. Nothing is wrong: at
   `b=12` those are exactly the LMSR prices for a net position of +2 and +4 units. The fills alternated
   YES/NO evenly, so the net position bounced between two values and the price followed it honestly. For a
   rising curve, weight the fills one way — `YES, YES, YES, NO, YES, YES` gives `541, 582, 620, 582, 620, 655`.
   Use **#4** if you want a graph with a shape, and #9 for the proof.

Market #8 also carries `182c453eee8f8310ab85…` — a **sell**, where the market paid the seller 499 sat
of proceeds to a one-time address. Worth showing: it is the leg most prediction-market demos skip.

---

## 3. The path

**Open on the finished story, then make one live.** Cold-clicking a live trade first means the first
thing the audience sees is a wallet dialog.

1. **Discover** — swipe through. This is the shape of the product.
2. **A market with history** (#1 or #4) — the price bar and the sparkline. Point out that every fill
   moved the price: that is the bonding curve, not a quoted spread. No explorer links here; don't
   offer any.
3. **Market #9** — finished, and every one of its six fills verifiable along with deploy, settle, resolve
   and payout. Open one receipt's WhatsOnChain link in a second tab. This is the moment the claim is proven.
   (#7 is a second, smaller example if you want one.)
4. **Market #8, live** — buy 1–2 shares from a real BRC-100 wallet. Your wallet raises its own
   approval with the amount; that is the only ceremony, deliberately (a second confirm in the app
   would just teach people to dismiss confirmations).
5. **Operator console** — the sign-off queue. Settle the batch you just created. The slider is the
   gate, and it names the exact amount.
6. **Positions → claim.** Safe to do live: since UI-023 a claim no longer waits for the payout to be
   mined — the proof is assembled from the payout's already-mined parents. Verified against mainnet: the
   assembled BEEF is 160.5 KB against 80.2 KB once mined, and passes `verify()` on real WhatsOnChain headers.

Costs, from measured mainnet transactions: a buy ~1,000 sat, a settle batch 200 sat, resolve 100 sat,
payout 2,200 sat. Against **172,884 sat** confirmed, a full live lifecycle is comfortably affordable.
Marginal cost per additional fill in a settlement is **0.64 bytes ≈ 0.06 sat** (ECON-001) — the real
ceiling is `MAX_PAYOUTS = 8` winners, not fees. Irrelevant unless a demo market ends with more than 8.

---

## 4. Talking points that are true

- The LMSR pricing runs in a **stateful UTXO covenant**, verified by Bitcoin Script. Every trade is
  checked by the network, not by a server you have to trust.
- **Settlement size is roughly constant** regardless of how many fills it contains — that is what the
  0.64 bytes/fill number means, and it is the scaling argument.
- Payouts go to **BRC-29 derived one-time addresses**. The operator cannot pay the wrong person and
  cannot reuse an address.
- The operator **never holds trader keys**. Orders are signed by the trader's own wallet and verified
  by the daemon.

---

## 5. Failure modes, and what to say

| If this happens | Why | Do this |
|---|---|---|
| **Claim fails with "cannot be proved yet"** | Transient — the payout has not propagated far enough for its parents to be fetched. | Press again in a moment. **It no longer waits for a block** (UI-023), so a live claim in the same session is fine. |
| Wallet approval never appears | MetaNet Desktop not running or not focused | Alt-tab to it. The app is idle until you approve; nothing is lost. |
| "payment: transaction … is not on the network yet" | Propagation lag | Press again. **The quote is still valid and you will not be charged twice** — the intent is reused (MAINNET-012). |
| "This pool cannot be spent by the current build" | The contract was recompiled after that market was deployed | Use a different market. Do not recompile mid-demo. |
| A page looks stale | Vite HMR, or a stale process | Hard reload. Then check process age (§1). |
| Daemon unreachable | It died, or you are on the wrong port | The app says so on its own screen with the restart command. |

---

## 6. Before you screen-share

`.env` at the repo root holds **`PM_FUNDING_WIF` and `PM_SEQUENCER_WIF`** — real spending keys. Close
that file in your editor, and don't `cat` it or run anything that prints the environment. The daemon
reads them at runtime; nothing in the UI or the database ever exposes them (the DB stores public keys
and references only), so the only way they reach a screen is if a person puts them there.

---

## 7. Reset / rehearse for free

The full journey can be driven end to end with **no mainnet spend at all**, against a local daemon —
it builds and Script-verifies every transaction and simply does not broadcast:

```bash
PORT=8811   # pick one nothing is listening on, and verify that
PM_PORT=$PORT PM_NETWORK=local PM_ENGINE=scrypt PM_OPERATOR_TOKEN=dev PM_DB_PATH=/tmp/rehearse.db \
  pnpm --filter @pm/daemon dev

PM_UI_E2E=1 VITE_PM_API=http://127.0.0.1:$PORT PM_OPERATOR_TOKEN=dev \
  pnpm vitest run apps/web/test/ui-journey.test.tsx
```

That test clicks the real buttons through create → deploy → signed order → settle → audit → resolve →
pay winners. It **refuses to run against a mainnet daemon**, by design, since it authorizes broadcasts.
Last run: **passed in 15.6s** against the current UI.
