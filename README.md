# BSV Prediction Market

A binary prediction market that runs as a **native on-chain UTXO automated market maker** on the BSV
Blockchain. The LMSR pricing lives inside a stateful UTXO smart contract, trades are signed by the trader's
own wallet, batches settle on chain, and an oracle-signed resolution pays winners to one-time BRC-29
addresses.

It has been driven end to end on mainnet: deploy → buy → settle → resolve → pay → claim, plus selling a
position back and being paid the proceeds. See [`docs/VERDICT.md`](docs/VERDICT.md) for the feasibility
findings and [`docs/DEMO.md`](docs/DEMO.md) for which transactions are real and where to look them up.

---

## Run it on a Mac

You need **Node 22+** and **pnpm**. If you have neither:

```bash
brew install node pnpm      # or: nvm install 22 && npm install -g pnpm
```

Then:

```bash
git clone https://github.com/MatiasJF/predictions_market.git && cd predictions_market
pnpm setup      # installs everything and builds the contract — a few minutes, once
pnpm demo       # optional: fill the database with example markets
pnpm dev        # start it
```

Open **<http://localhost:5273>**.

> `127.0.0.1:5273` will look dead — the dev server binds IPv6 only. Use `localhost`.

That's it. **Nothing above touches a real network and nothing costs money.** The daemon defaults to
`PM_NETWORK=local`, where every transaction is built and verified against Bitcoin Script exactly as it would
be on mainnet and then simply not broadcast. No keys, no funds, no configuration.

### What you can do

- **Discover** — swipe through open markets. Right for YES, left for NO; a swipe only picks a side, it never
  spends anything.
- **Markets** — the full list, with the price history of each. Every fill moves the price, because the price
  *is* the bonding curve, not a quoted spread.
- **Positions** — what you hold, and anything you can claim.
- **Operator** — the other half: deploy a market, settle a batch of fills, resolve it, pay the winners. Every
  action that would spend money parks in a sign-off queue and waits for a human to authorize it.

Without a BSV wallet installed the app signs with a **development key held in your browser** and says so.
Orders are still really signed and really verified — it just isn't production custody. Install a BRC-100
wallet (e.g. MetaNet Desktop) and reload to use your own.

---

## Going to mainnet

Optional, deliberate, and it spends real satoshis. You need a funded key.

```bash
cp .env.example .env        # then set PM_NETWORK=mainnet and fill in PM_FUNDING_WIF
pnpm dev
```

Configuration precedence is: an explicit variable on the command line, then `.env`, then the safe default.
So `PM_NETWORK=mainnet pnpm dev` works as a one-off without editing anything.

- `.env` is gitignored and holds **real spending keys**. It is read at runtime only; the database stores
  public keys and references, never secrets. Don't print it, and close it before screen-sharing.
- Costs, measured from real transactions: a deploy is ~51 sat, a settlement ~200 sat, a resolve ~100 sat, a
  payout ~2,200 sat. A whole market lifecycle is a few thousand satoshis.
- Every broadcast still waits for you to authorize it, with the amount stated.

---

## Commands

| | |
|---|---|
| `pnpm setup` | one-time install + contract build. Safe to re-run. |
| `pnpm dev` | daemon + web app together; Ctrl-C stops both |
| `pnpm demo` | seed a database with example markets (refuses to run against mainnet) |
| `pnpm test` | the full suite |
| `pnpm typecheck` | types across every package |

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Exit code 139, or the process dies silently | Node 20. `better-sqlite3`'s native binary segfaults rather than failing cleanly | `nvm use` (Node 22 is pinned in `.nvmrc`), then `pnpm rebuild -r` |
| ~45 tests fail with `NODE_MODULE_VERSION` | native modules built for a different Node | `pnpm rebuild -r` |
| `Cannot find module …/contracts-scrypt/dist/…` | the contract package hasn't been built — its output is gitignored | `pnpm setup` |
| `EADDRINUSE`, or a port is busy | something is already running there | `pnpm dev` checks **both** ports before starting and prints what holds them, with its age. Stop it, or `PM_PORT=8788 PM_WEB_PORT=5274 pnpm dev` |
| The page looks stale after an edit | a stale process, not your code | Check the process **age** first: `ps -o etime= -p $(lsof -ti :8787 \| head -1)`. Anything older than your last change isn't running it. |
| `http://127.0.0.1:5273` doesn't load | the dev server binds IPv6 only | use `http://localhost:5273` |

---

## How it works, briefly

LMSR pricing needs `exp` and `ln`, and Bitcoin Script has neither, nor unbounded loops. The contract stores
`e_yes = exp(qYes/b)·SCALE` and `e_no` as UTXO state, so a fixed-unit buy is a multiplication by a
precomputed constant — pure bigint arithmetic, no transcendental functions, no loop. Off-chain, a pure
integer LMSR implementation (`@pm/lmsr`) is the reference the on-chain state is checked against.

Fills are executed off-chain against a signed receipt and settled in batches, which is what makes it
affordable: a settlement's size is roughly constant no matter how many fills it contains — the marginal cost
of one more fill is about **0.64 bytes**.

Read in this order: [`CLAUDE.md`](CLAUDE.md) → [`docs/STATE.md`](docs/STATE.md) →
[`docs/INDEX.md`](docs/INDEX.md). Decisions and their reasons are in
[`docs/DECISIONS.md`](docs/DECISIONS.md), newest last.

---

## Status

A feasibility spike that grew a working platform on top: off-chain execution with batched settlement, a
receipt-to-payout bridge, real BRC-100 wallet signing, and a web UI for both the trader and the operator.
It is **not** production software — there is no market curation, no order book, no multi-outcome markets,
and the operator is a single trusted party.
