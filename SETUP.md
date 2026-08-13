# Setting this up on your Mac

You should have been sent a **`.env` file separately**. It holds real spending keys, so it is not in the
repository and never will be. Everything else is here.

Total time: about ten minutes, most of it waiting for `pnpm setup`.

---

## 1. Install Node and pnpm

You need **Node 22 or newer**. Not optional — on Node 20 a native database module *segfaults the process*
instead of failing with an error, which is a confusing hour if you skip this.

```bash
node -v          # if this says v22 or higher, you already have it
```

If not:

```bash
brew install node pnpm
```

No Homebrew? Any of these work instead:

```bash
# with nvm (this repo pins its version in .nvmrc)
nvm install 22 && nvm use

# pnpm, once Node is present — pick one
corepack enable pnpm       # built into Node 22
npm install -g pnpm
```

Check both: `node -v` and `pnpm -v`.

---

## 2. Get the code and build it

```bash
git clone https://github.com/MatiasJF/predictions_market.git
cd predictions_market
pnpm setup
```

`pnpm setup` installs dependencies, rebuilds native modules for your Node version, and compiles the on-chain
contract. **The contract build is the slow part** and it downloads a compiler on first run. It ends by running
the test suite; you should see it pass. Safe to run again any time.

---

## 3. Put the `.env` in place

Copy the file you were sent into the **root of the repository** — the same folder as `package.json`:

```bash
cp ~/Downloads/.env .            # from wherever you saved it
ls -la .env                      # confirm it is there
```

It must be named exactly `.env`. It is already listed in `.gitignore`, so you cannot commit it by accident.

**Handling it:** it contains private keys that control real money. Don't paste it into chat, email, a ticket,
or an AI assistant; don't open it while screen-sharing; delete the copy in `~/Downloads` once it is in place.

---

## 4. Run it

```bash
pnpm dev
```

Open **<http://localhost:5273>**.

> Use `localhost`. `http://127.0.0.1:5273` will look dead — the dev server only listens on IPv6.

`Ctrl-C` stops both the daemon and the app together.

**`.env` is not watched.** If you change it, restart `pnpm dev`.

---

## 5. First run: it will be empty, and that is expected

The database is not part of the repository, so you start with **no markets**. Create your own from the
**Operator** tab: give it a question, a liquidity setting (`b`) and a payout per winning share, then
**new market** → **deploy pool** → authorize it on the slider.

### Funding

The operator wallet pays for deploys, settlements, resolutions and payouts. The **Operator** tab shows its
balance and, under it, **the funding address — click to copy**.

**Send BSV to that address and it is picked up automatically.** There is no import or registration step: the
engine reads that address's unspent outputs at the moment it builds a transaction, so a payment is usable as
soon as the network has seen it. Unconfirmed funds count.

Some guidance from real runs:

- **Send it in one chunk rather than many small ones.** Paying winners looks for a single output big enough to
  cover the payout plus about 50,000 sat of headroom, so a wallet made of dust can have a healthy total and
  still fail to pay out.
- Costs, measured on mainnet: deploy ~51 sat, settle a batch ~200 sat, resolve ~100 sat, pay winners ~2,200
  sat. **50,000–100,000 sat is a comfortable starting balance** for a lot of experimenting.
- Traders pay their own stakes from their own wallets. This balance is the operator's costs only.

### Trading

Without a BSV wallet installed, the app signs with a **development key held in your browser** and says so.
Orders are genuinely signed and verified — it just isn't real custody, and a development key holds no funds,
so it cannot buy. Install a **BRC-100 wallet** (MetaNet Desktop) and reload to trade with your own money.

---

## This is connected to mainnet

The `.env` you were given sets `PM_NETWORK=mainnet`. Every authorization spends **real satoshis**.

- Nothing is broadcast without you. Every spending action parks in a **sign-off queue** and waits for you to
  slide to confirm, with the amount shown.
- The operator token in `.env` gates those actions. Paste it into the Operator tab once; your browser
  remembers it.
- A claim goes to a one-time address only your key can unlock.

If you would rather practise for free first, run **`PM_NETWORK=local pnpm dev`**. Everything works identically
— transactions are built and verified against Bitcoin Script exactly as on mainnet — and nothing is broadcast,
so it costs nothing. Use a separate database for it so you don't mix the two:

```bash
PM_NETWORK=local PM_DB_PATH=data/practice.db pnpm dev
```

---

## Two things not to do

- **Don't recompile the contract while you have live markets.** A deployed pool is locked by the exact
  contract build that created it. Rebuild it and every existing market becomes unspendable — the app will say
  so rather than failing halfway, but the only fix is deploying fresh markets.
- **Don't run two daemons against the same database on two machines.** They would both try to spend the same
  outputs and the second one fails with `Missing inputs`. One database, one daemon.

---

## When something goes wrong

| What you see | What it is | What to do |
|---|---|---|
| Exit code 139, or it dies with no message | Node 20 — the database module segfaults | `nvm use` then `pnpm rebuild -r` |
| `NODE_MODULE_VERSION` errors, many tests failing | native modules built for a different Node | `pnpm rebuild -r` |
| `Cannot find module …/contracts-scrypt/dist/…` | the contract was not built | `pnpm setup` |
| Port already in use | something is still running | `pnpm dev` refuses and tells you what holds it and for how long. Stop it, or `PM_PORT=8788 PM_WEB_PORT=5274 pnpm dev` |
| `http://127.0.0.1:5273` won't load | the dev server is IPv6-only | use `http://localhost:5273` |
| The app says it can't reach the daemon | the daemon stopped | the message includes the command to restart it |
| Zero markets on a machine that had some | the daemon opened a different database | check `PM_DB_PATH` in `.env`; relative paths resolve from the repo root |
| The daemon restarts over and over, naming files in `node_modules` | `tsx` was watching the whole dependency tree — it only excludes `node_modules` under its own folder, and the pnpm store sits above it | fixed in the repo: `git pull` |
| A page looks stale after an edit | usually a stale process, not your code | check its **age**: `ps -o etime= -p $(lsof -ti :8787 \| head -1)`. Older than your change means it isn't running your change. |
| `payment: transaction … not on the network yet` | propagation lag | press again — the quote is still valid and you will not be charged twice |

---

## What this actually is

A binary prediction market where the pricing runs inside a stateful Bitcoin UTXO contract. Trades are signed
by the trader's own wallet, executed off-chain against a signed receipt, and settled in batches — which is
what makes it cheap, because a settlement is roughly the same size no matter how many fills it contains. An
oracle-signed resolution pays winners to derived one-time addresses.

More detail: [`README.md`](README.md) for the project overview, [`docs/DEMO.md`](docs/DEMO.md) for a walk-through
and which transactions are real, [`docs/DECISIONS.md`](docs/DECISIONS.md) for why things are the way they are.
