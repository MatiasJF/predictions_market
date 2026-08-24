# Lessons — what has actually gone wrong here, and what it cost

`DECISIONS.md` is the chronological record of *why things are the way they are*. This file is the opposite
shape: **distilled, categorised, and written to be read before you start**, so a mistake made once is not
made again by whoever comes next — human or agent.

Every entry is real. Each names the symptom you would actually see, because the symptom is almost never
the cause, and the cost is usually the hour spent looking in the wrong place.

**Adding to this file is part of Definition of Done.** See [§9](#9-keeping-this-file-alive).

---

## 1. The meta-lesson: three things that lie

Most of the hours lost on this project went to trusting a signal that was confidently wrong. All three
recur, so check them in this order before debugging anything:

**1. A running process is not your code.** Check its **age** before believing anything it says:

```bash
ps -o etime= -p $(lsof -ti :8787 | head -1)
```

Anything older than your last change is not running your last change. This cost time on **five** separate
occasions: a daemon older than the fix (twice), a five-hour-old daemon squatting a port so a fresh one died
of `EADDRINUSE` while the old one answered every request, a wedged dev server, and finally 15 orphaned
daemons from previous sessions found still running, the oldest up 1 day 23 hours.

**2. A passing health check proves something is answering — not that it is yours.** `EADDRINUSE` is silent
from outside. The port is open, `/health` returns `ok`, and you are talking to a process you did not start.

**3. A green test suite proves a test ran, not that it tested anything.** Three tests here passed while
asserting nothing (§6). Mutation-test anything you rely on.

And the converse: **a red suite is not proof the code is broken.** 107 tests failed here because the shell
had defaulted to Node 20 — the code was untouched and fine. Before debugging a mass failure, check what is
running it.

---

## 2. Environment and toolchain

| Symptom | Cause | Fix |
|---|---|---|
| Process dies with **exit 139**, no error | `better-sqlite3`'s native binary **segfaults** on Node 20 instead of failing cleanly | Node 22 is a hard floor (`.nvmrc`). Check the version *first* |
| Many tests fail, `NODE_MODULE_VERSION 127 … requires 115` | native modules are built per Node ABI. **Read it in the right direction**: it names the *binding's* version first, so it sounds like the binding is stale — but `requires 115` means the **runtime** is Node 20. Rebuilding is the wrong fix | Check `node -v` **before** `pnpm rebuild -r`. A shell without `nvm use` silently gives Node 20 |
| Bindings vanish for no reason | a `pnpm install` in a **sibling clone** disturbed the shared store | `pnpm rebuild -r` |
| `pnpm setup` does something unexpected | **`setup` is a built-in pnpm command** — it configures pnpm, not your project | `pnpm run setup`. `run` is never wrong |
| A flag you passed is ignored | `pnpm --filter X dev -- --port N` never reaches the tool; the `--` survives as a literal | pass config by **environment variable**, not argument |
| Daemon restarts ~1×/second, logging `change in ./../../node_modules/…` | `tsx watch` excludes `node_modules` **relative to its own root**; the pnpm store is two levels above `apps/daemon`, so the whole dependency tree was watched | explicit `--exclude` (`--ignore` is deprecated in tsx 4.23) |
| `http://127.0.0.1:5273` looks dead | the dev server binds **IPv6 only** | use `localhost` or `[::1]` |
| Daemon on the right network with the **right keys** and **zero markets** | a *relative* `PM_DB_PATH` resolved against the CWD, which `pnpm --filter` sets to `apps/daemon` — so it created `apps/daemon/data/x.db` | relative paths now resolve against the repo root |
| A `.env` edit has no effect | `tsx` watches source, **not** `.env` | restart |
| Fresh clone: `Cannot find module …/contracts-scrypt/dist/…` | that package builds to **gitignored** output and is outside the pnpm workspace (sCrypt's ts-patch needs a flat `node_modules`) | `pnpm run setup` |

**Config precedence is command line → `.env` → safe default.** It was not always: `.env` said
`PM_NETWORK=mainnet` for weeks and *the daemon never read it* — only WIF names were pulled from that file,
and the network came from a hardcoded fallback that happened to agree. Changing that fallback silently
flipped a configured mainnet daemon to local. **A default that agrees with the config file hides the fact
that the config file is never read.**

---

## 3. BSV and the chain

**WhatsOnChain's `/address/{addr}/unspent` returns outputs that are already spent.** Not merely lagging —
observed returning an output *confirmed in a block fifty blocks earlier* and long since spent, with **no
`isSpentInMempoolTx` flag**. Any sane coin selector prefers a large confirmed output, so it picks the worst
one available and the node answers `258: txn-mempool-conflict`. Verify every candidate against
`/tx/{txid}/{vout}/spent` (200 = spent, 404 = free) before offering it. Cache "spent" forever — spending is
irreversible.

**`Missing inputs` and `txn-mempool-conflict` are double-spend symptoms, not signing failures.** They mean
the output you are spending does not exist, or something already spends it. Look at the UTXO, not the
signature.

**"Can this be spent" is two questions.** `poolSpendable()` answered *"can this build produce a valid
unlocking script"* — a question about **code**. It said nothing about whether the output **exists**. One
word covered both, so the console offered actions on markets whose transactions were never broadcast, and
the only way to find out was to authorize a broadcast and watch it fail.

**BEEF ancestry stops at the first proven transaction.** It does not run to the genesis of the market. This
file claimed otherwise and imposed a ten-minute wait on every payout claim; the walk is **one level deep**,
because a payout's inputs are already mined. Verified against mainnet: 160.5 KB assembled from parents vs
80.2 KB with its own proof, and `verify()` returns true on real headers.

**BRC-29 has a direction, and getting it backwards is silent.** `deriveDestination(payer, recipient)` derives
the **counterparty's** key — for paying someone. `deriveOwnDestination(own, counterparty)` uses BRC-42
`forSelf: true` — for **being paid**. Using the first where the second belonged paid every trader's stake to
the trader's own address: 16,440 sat, unusable, with no error anywhere.

**Paying winners needs one output covering payout + ~50,000 sat of headroom.** A wallet made of dust can show
a healthy total and still fail to pay.

**Unconfirmed change is spendable** — chain through it rather than waiting for a block.

**`@bsv/wallet-toolbox` runs `dotenv.config({ override: true })` at import time.** Merely importing it
re-reads `.env` and **overwrites the running process's environment**. Snapshot and restore around the import,
or a UI whose job is preventing accidental spends changes its mind about which network it is on because a
winner clicked a button.

---

## 4. Money-path safety, learned the expensive way

| What happened | Cost | Rule it produced |
|---|---|---|
| A transient rejection burned an already-paid intent | 1,002 sat | Distinguish **transient** from **final**. Leave the intent pending and retry |
| A retry minted a *new* intent for the same order | double charge | Reuse the intent; a retry must be **free** |
| Wallet signed 3 payments, only 1 was broadcast | stranded funds | The daemon publishes it itself, after validating |
| Sells were bounded by the **pool**, not the seller's position | naked short | Bound by holdings **before** any state is computed |
| Balance summed unspent outputs while a spend was pending | showed 405,270 vs a real 198,615 | `confirmed + net unconfirmed`; show pending separately |
| A cached verdict from before the artifact loaded | wrong spendability | Never cache a verdict computed without its inputs |

**A rejected transaction pays no fee.** Failed broadcasts cost nothing — say so, rather than letting someone
think they have burned money.

**The gate belongs where the amount is.** A standing "MAINNET — real money" banner on every screen is an
alarm nobody reads. The per-spend slider that names the exact amount is the thing that works.

---

## 5. Product surface: what "done" hides

**Script-verified is not broadcast.** Transactions built on `PM_NETWORK=local` are real in every sense
except that nobody paid to publish them. Showing an explorer link for one would lead to a 404 while implying
the money went somewhere. **Silence is honest; a dead link is not.**

**A demo's most attractive screen may be the one that can prove least.** The richest markets here (14, 11, 9
receipts) have **zero** transactions on chain; the honest one has six. Know which is which before pointing
an audience at it.

**Perfectly alternating inputs produce a perfectly alternating graph.** A price history that looked broken —
`541, 582, 541, 582…` — was exactly correct: fills alternated YES/NO evenly, so the net position bounced
between two values. Check the maths before calling it a bug, and weight the fills if you want a curve.

---

## 6. Tests that lied

Every one of these **passed**, which is why they are here.

- **`tokens.test.ts` tested nothing.** It located CSS blocks with `indexOf(selector)`, and the file opens with
  a comment that *quotes every selector it describes* — so each lookup matched the prose, parsed from the
  wrong offset, and compared the light palette against itself. Five green tests, zero coverage. Found by
  deliberately breaking a value and watching the suite stay green.
- **A specificity contract compared against the wrong selector.** The global rule is a selector list; the test
  took `.split(',').pop()` — which is `textarea` at (0,0,1). A lone class beats that, so it passed on
  known-broken CSS.
- **A component test needed a live daemon.** `surface.test.tsx` renders `App`, which shows a "cannot reach the
  daemon" card instead of the header when the health poll fails. It passed only while a daemon happened to be
  running. Since `pnpm run setup` runs the suite, a newcomer could watch setup fail on a component test with
  nothing to do with the network.

**Rules:**
1. **Mutation-test every check you rely on** — break the thing, watch it go red, put it back. If it stays
   green the test is decoration.
2. **Verify in both directions.** Fixing a watcher, confirm it *stopped* watching `node_modules` **and still**
   restarts on source. A watcher that stopped watching is worse than the bug.
3. **Hermetic by default.** A unit test that needs a server is not a unit test.
4. **Identify elements by role/label/testid, never by CSS class** — or a restyle rewrites the test that was
   supposed to catch the restyle.

---

## 7. CSS that silently loses

**Specificity beats intent.** `base.css` styles `input[type="search"]` — **(0,1,1)**. The component reset was
`.searchbar-input` — **(0,1,0)**. The reset *never applied*; the field kept the global fill, border and radius
nested inside its own pill. Valid CSS, present rule, clean build, and only visible by looking.

**Never restate `position` for an element that positions itself.** A stacking-order rule set
`position: relative` on `.tabbar`, which is `position: fixed` and becomes a desktop rail via a media query
setting only `top`/`left`/`width`. It fell into normal flow and collapsed to the bottom of the page. Clean
typecheck, clean tests, clean build.

**Contrast is arithmetic, not taste.** A row reported as invisible measured **3.03:1** — under the 4.5 floor,
at a size with no large-text exemption. Nobody caught it in review because *a palette looks fine until you
ask it for a number*. The check that followed immediately found a second token failing even the 3:1
decorative floor, unreported.

**Never the smallest type at the quietest colour.** Two reports in a row were that exact pair.

**A negative `z-index` under a `backdrop-filter` leaves unpainted rectangles.** A blurred element sampling a
backdrop outside its own stacking context; it repaints on scroll or click, which is exactly how it gets
reported.

---

## 8. Working method

- **Verify by doing the thing.** The onboarding docs were validated by `git clone`-ing into a temp directory
  and running them. That found four blockers reading could not: no engine in a clone, the seeder dying
  without keys, a port flag that did nothing, and defaults pointing a first-timer at mainnet. A guide written
  from the code would have shipped all four.
- **Your own test can mask the bug you are testing for.** The first fresh-clone run passed `PM_API` explicitly
  — masking the wrong default it was meant to catch.
- **`git add -A` sweeps what you did not look at.** It committed a 900 KB unrelated `.docx` and an unrelated
  daemon fix into a UI commit whose message claimed "no money-path change".
- **Don't chain a push behind `&&` after a test command that doesn't fail the shell.** A failing suite was
  pushed because `vitest`'s output was printed, not gated. **This then happened a second time**, in the very
  commit that first wrote this rule down — 107 failures, pushed. Writing a rule down is not the same as
  building a gate; if it must not ship broken, the check has to be something that *stops* the push. **Now
  it is one**: `.githooks/pre-push` runs typecheck and the suite and refuses on failure. It selects Node 22
  itself, because the gate that reports a false red is the one that teaches people to pass `--no-verify`,
  and it skips documentation-only pushes for the same reason.
- **Restore a deliberately-broken file with `git checkout --`, not a hand-rolled copy.** Testing that the
  hook blocks meant breaking a test on purpose; the backup captured a *different* file than the one edited,
  so restoring silently overwrote a real test file with another's contents. The tell was the suite passing
  with 305 tests instead of 292 — a green run with the wrong number is still a wrong run. Git already has
  the backup.
- **State the limits of your evidence.** Some fixes here were diagnosed by reading because no browser in the
  environment renders the app. Say which those are, and what the fallback is if the fix does not hold.
- **A follow-up "still happening" usually means the diagnosis was half right.** The mempool-conflict fix
  tracked what *this process* had spent — useless for the first broadcast of a fresh process, which is
  exactly where it still failed.

---

## 9. Keeping this file alive

This file is only worth having if it grows. **Adding to it is part of Definition of Done**, alongside
`STATE.md` and `DECISIONS.md` (Golden Rule 1).

**Add an entry when — and only when — something surprised you**: a symptom that pointed at the wrong cause,
a tool that behaved differently than documented, a test that passed while wrong, or money that moved
unexpectedly. Routine work does not belong here; this file dies the day it fills with things everyone
already knew.

Use **`/lesson`** (`.claude/skills/lesson/`), which any session or subagent can invoke. It enforces the
format, checks for an existing entry to strengthen instead of duplicating, and keeps the wording in the
house style: **symptom first, cause second, rule last.**

Before starting non-trivial work, read §1 and whichever section covers what you are about to touch. Agents
working in this repository inherit it through `CLAUDE.md`'s read order.
