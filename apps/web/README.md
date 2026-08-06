# `@pm/web` — the trader app + operator console

The face on the system. Vite + React + TypeScript, talking only to the daemon's HTTP API (`apps/daemon`).
No backend of its own: every number on screen comes from the daemon, and every on-chain action goes through
the sign-off queue.

## Run it

```bash
# 1. the API (a fresh local run — no mainnet spend)
PM_ENGINE=scrypt PM_NETWORK=local PM_OPERATOR_TOKEN=dev-token pnpm daemon

# 2. the UI
pnpm web        # http://localhost:5273
```

Paste the same `PM_OPERATOR_TOKEN` into the **Operator** tab. Then: *new market* → *deploy pool* → authorize it
in the queue → switch to **Trade**, place an order → back to **Operator** to *settle batch*, check the audit,
*resolve*, and *pay winners*.

Point it at a different API with `VITE_PM_API=http://127.0.0.1:9000`.

## The two halves

**Trade** — market list with live YES/NO prices, then a market: the order ticket (YES/NO, buy/sell, size, live
quote), your position, and your receipts. Placing an order **signs it in the browser** and posts the signature;
the daemon verifies before filling, so a fill only exists if you authorized it. Fills are instant and off-chain
— settlement happens later, in batches.

**Operator** — the **sign-off queue** first: everything that spends money parks there with a plain-English
summary and a sat cost until a human clicks authorize. Then the market lifecycle (deploy / settle / resolve /
pay winners), the audit report (does the chain match the receipts traders signed?), the payout preview, and the
wallet balance.

## Custody: who holds the key

`src/signer/` is the seam, and nothing else in the app knows which side it got:

- **`WalletSigner`** — a real BRC-100 wallet (e.g. MetaNet Desktop) via `@bsv/sdk` `WalletClient`. The private
  key never leaves the wallet. The daemon verifies with `ProtoWallet('anyone')`, so **the server needs no
  wallet and no key** — that is what makes browser signing workable at all.
- **`LocalSigner`** — a development key in the browser, used *only* when no wallet is reachable. The UI shows a
  warning banner when this happens. It is not production custody and the app says so.

Traders never need BSV: they only sign. The operator pays every on-chain fee.

## Honest limits

- The operator token is a shared secret over plain HTTP on loopback. It is a real improvement over the *nothing*
  that came before it, but it is not a reason to expose the daemon to a network — it still binds 127.0.0.1.
- Polling (2–5 s), single operator, no accounts or sessions.
- The acceptance test (`test/ui-journey.test.tsx`) drives the real components in **jsdom**, not a real browser,
  so there is no layout or paint coverage. `WalletSigner` is covered by unit tests, not by a live wallet
  round-trip — no BRC-100 wallet was installed when it was written.

```bash
# run the acceptance test against a live daemon (see "Run it" above)
PM_UI_E2E=1 PM_OPERATOR_TOKEN=dev-token pnpm test:ui
```
