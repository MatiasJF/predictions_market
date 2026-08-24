---
name: lesson
description: Capture a hard-won finding into docs/LESSONS.md so it is not rediscovered. Invoke when something surprised you — a symptom that pointed at the wrong cause, a tool behaving differently than documented, a test that passed while wrong, money moving unexpectedly, or a fix that needed a second attempt. Also invoke at the end of a session that hit any of those. Any subagent may call it.
---

# Capture a lesson

`docs/LESSONS.md` is the project's distilled memory of what has actually gone wrong. It is only worth having
if it grows, and only worth reading if it stays sharp. This skill adds to it without letting it bloat.

## When this applies

Add an entry when something **surprised** you:

- a symptom that pointed at the wrong cause
- a tool that behaved differently from its documentation
- a test that passed while testing nothing, or failed for an environmental reason
- money that moved, was stranded, or was nearly lost
- a fix that turned out to be half right

**Do not** add routine work, or anything the code already states plainly. This file dies the day it fills
with things everyone already knew. When in doubt, ask: *would this have saved someone an hour?* If not,
leave it out.

## Steps

**1. Check whether it is already there.** Search first — an existing entry made sharper beats a near-duplicate:

```bash
grep -n -i "<a distinctive word from the symptom>" docs/LESSONS.md
```

If a related entry exists, **strengthen it**: add the new symptom, or the second instance, or the cost. A
lesson that has now bitten twice should say so — recurrence is the strongest argument a lesson has.

**2. Pick the section.** §1 the three things that lie · §2 environment/toolchain · §3 BSV and the chain ·
§4 money-path safety · §5 product surface · §6 tests that lied · §7 CSS · §8 working method. If it fits none,
say so rather than forcing it — a new section is cheap.

**3. Write it symptom first.** The symptom is what the next person will have in front of them; the cause is
what they cannot see. Table sections take a row; prose sections take a short bolded claim and two or three
sentences.

- **Lead with what you would actually see**, verbatim where possible — the exact error string, the wrong
  number, the thing that looked fine.
- **Then the cause**, in one sentence.
- **Then the rule**, phrased so it can be applied before the symptom appears.
- **Include the cost** when there was one: satoshis, hours, or "found by mutation testing".
- Include a real identifier — txid, token name, file, flag — where it makes the entry checkable.

Match the surrounding voice: plain, specific, no hedging, no exclamation. State what happened.

**4. Verify the claim before writing it down.** A wrong lesson is worse than none — it sends the next person
somewhere confidently useless. If it is an API behaviour, hit the API. If it is a tool flag, run it. If it
could not be verified, **say so in the entry** and name what would settle it.

**5. Update the KB per Golden Rule 1** — `docs/STATE.md` if it changes the current picture, `docs/DECISIONS.md`
if a decision was made. `LESSONS.md` is the distilled layer, not a replacement for either.

## Format

Table row:

```markdown
| `258: txn-mempool-conflict` on the FIRST broadcast | WoC lists outputs that are already spent, with no flag | verify each candidate against `/tx/{txid}/{vout}/spent` |
```

Prose entry:

```markdown
**BEEF ancestry stops at the first proven transaction.** It does not run to the genesis of the market. This
file claimed otherwise and imposed a ten-minute wait on every payout claim; the walk is one level deep.
Verified against mainnet: 160.5 KB assembled from parents vs 80.2 KB with its own proof.
```

## Anti-patterns

- Restating the fix without the symptom — nobody searches for a fix they do not know they need.
- "Be careful with X." Say what goes wrong and how you would notice.
- Adding an entry for a bug that was simply your own typo.
- Letting a section grow past what someone will read before starting work. If a section sprawls, merge the
  weakest entries rather than appending forever.
