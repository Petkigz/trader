# The goal, and what it is allowed to change

> "today i made losses and i can continue this tomorrow. it doesn't necessarily have to make 1
> dollar a day, i can make more to fulfill the task faster or to fill up the loss. it needs to know
> how much it's in deficit so it can pull up. also continuing to trade when there are opportunities
> is something it has to know."

This document separates the three requests in that message, because they have very different
answers. One is free. One is dangerous. One is already true.

## 1. Knowing the deficit — built, and worth having

`src/goal.ts` keeps a goal ledger:

```
targetEquity = startEquity + dailyTarget × daysElapsed        (linear, not compounding)
deficit      = max(0, targetEquity − equity)
```

Linear matters. Written as `1.05^days`, a "$1/day" goal secretly becomes a demand for roughly
4,000%/yr, which is the kind of arithmetic that ends with somebody increasing position size until
there is nothing left to increase. As a sum, the goal line is just a number that rises by a dollar
a day, and being behind it is an observable fact rather than a moral failing.

The ledger also reports the two numbers that matter when you are behind:

- `achievedPerDay` — the rate the account has actually managed;
- `daysToCloseAtAchievedRate` — how long the gap takes at that rate, or *never* if the rate is
  negative or zero.

And a `pressure` label that refuses to flatter: `ahead`, `on-track`, `behind`, `deep-behind`, and
`unreachable` — the last one triggered when the required return exceeds 100%/yr, which is already
generous. On a $10 account with a $1/day target, the label is `unreachable` from day one. That is
not pessimism, it is the arithmetic of the request.

The dashboard shows the gap and the day's P&L. Today's loss is visible tomorrow. Nothing is hidden.

## 2. "Pull up to fill the loss" — measured, and refused

This is the part where the honest answer is *no*, and it is not an opinion:

```bash
npm run catchup
```

It runs three readings of the request through the same fill model, on the same 20-asset panel,
starting from $10 with a $1/day line:

| Arm | What it means |
|---|---|
| `opportunity` | trade when the signal fires, no daily target at all (what the bot does) |
| `quota` | stop entering once the day's target is banked |
| `chase-Nx` | size up in proportion to the deficit, capped at N× |

Results, $100 account so that there is actually room to size up (50% deployed):

| Arm | Median final | Worst account | Median max DD | Accounts busted |
|---|---|---|---|---|
| opportunity | $185.00 | $44.53 | 73.0% | 1/20 |
| chase-5x | $182.44 | $11.78 | 84.8% | 4/20 |
| chase-open | $182.44 | $11.78 | 84.8% | 4/20 |

Catching up **does not improve the median and quadruples the number of ruined accounts**. The worst
account goes from $44.53 to $11.78, and the ones that die, die around day 1,140 of ~2,300. That is
the signature of a martingale: it does not buy return, it buys variance, and on a finite account
variance is paid for in ruin.

On the actual $10 account the answer is even simpler. At the live 97% deployment there is no room
to size up at all — a normal entry is already nearly all the cash. And below ~54% deployment a $10
account cannot even place an order, because $10 × 0.5 < the $5 minimum notional. **A $10 account is
structurally all-in. There is no conservative mode to retreat to and no aggressive mode to reach
for.** That is a fact about exchange minimums, not about risk appetite.

So the rule in code is:

```ts
plannedRiskMultiplier(...) -> 1     // always, by construction
```

and a test asserts it. The ledger may change what we know and what we report. It may never change
how much is risked.

## 3. "Trade when there are opportunities, not to a quota" — already true, with a catch

There is no quota anywhere in the engine. No rule stops trading because a target was hit; the only
things that block an entry are the risk rails (halt, drawdown, kill switch) and the absence of a
signal. `planParticipation` takes the goal status and **has no branch on it**. Hitting the target
does not earn a day off, and a loss does not unlock a second attempt. Both are tested.

What the data adds is that "make the best of every opportunity" is not free either:

- the champion is **in the market 38% of the time** — it sits in cash the other 62%, by design,
  because the trend filter exists to stand aside;
- the `quota` arm was indistinguishable from `opportunity` here, because the champion only trades
  about 29 times in 6.3 years. A daily quota cannot interfere with a strategy that trades monthly.

So the lever for "more opportunity" is a *more sensitive strategy*, and that lever has already been
pulled and measured. In the challenger run, the faster variant (`trend-ema100`) took 359 round trips
instead of 211 — more participation — cleared every crypto gate, and was then **withdrawn because it
lost money on 31 non-crypto futures markets**. More trading was available. It was not better.

## What is and is not being claimed

- Claimed: the deficit is visible, per day, in the dashboard and the API.
- Claimed: catching up on size makes outcomes worse, measured five ways.
- Claimed: nothing in the engine trades to a quota.
- Not claimed: that the bot will reach $1/day. On $10 it cannot; the target needs roughly $3,700 of
  capital at the measured rate, or a fundamentally different edge — not a different sizing rule.

The next honest step is not a bigger position after a bad day. It is capital, or a strategy that
beats the champion out of sample. Neither is something a sizing rule can fake.
