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

## 2a. Assuming it profits: does it cover the losses? — mostly yes, and fast

Fair correction to §1: measuring on day one makes the label a verdict instead of a starting
state. The question that matters is what happens *once the account is earning*.

```bash
npm run recover -- --dir=data/real
```

Drawdown episodes of 5% or more, champion strategy, 20 assets, 2020→now:

| Measure | Value |
|---|---|
| Drawdowns of 5%+ | 197 |
| Covered within 90 days | 171 (87%) |
| Covered within a year | 174 (88%) |
| Still open at the end of the record | 20 |
| Median time to regain the lost high | **6 days** |
| Longest single stretch under water | **1,085 days** |
| Median share of days 5%+ below a high | 98% |

So the intuition is right on this point: **losses are covered by continuing to trade at normal
size, and usually quickly.** Six days of median recovery is ordinary. The 1,085-day stretch is the
one to remember, because it is the case where "tomorrow" is three years away.

What is *not* true is that a deficit can be pulled up by earning more. And there is now an exact
reason why.

## 2b. Escape velocity: why a dollar target can't be caught from below

Growth per day is `equity × dailyRate`. A +$1/day line advances by exactly $1/day. So the line only
stops outrunning the account when:

```
equity × dailyRate > $1        →        equity > 1 / dailyRate   ("escape velocity")
```

At the measured 30%/yr, that threshold is **$1,392**. Below it, each day adds less than the line
does, so the gap widens — not because the bot is unlucky, but because $10 cannot generate a dollar
a day. Above it, the surplus compounds and the line stops mattering.

That reshapes §1's harsh label. "Unreachable" is not a claim that the goal is impossible for
everyone; it is a statement that **this balance is below escape velocity**. The ledger now reports
the threshold, whether the account is past it, and how long reaching it would take:

- accounts past the threshold after 6.3 years: **0/20**
- median final equity: **$18.17**, i.e. **$1,373 short**
- median years to reach the threshold at each asset's own achieved rate: **16** (best asset, 63%/yr,
  needs $750 and still ends far below it)

There is one more nuance worth stating precisely: growth compounds, so a positive rate *does*
eventually beat a linear line — around 88 years out for a 9%/yr account starting near $20. That is
why `daysToCloseGap` reports "not within 30 years" rather than "never". The distinction matters
because "never" invites argument and "88 years" does not.

## 2c. Does it grow every day, or only every few years? — in bursts

```bash
npm run growth -- --dir=data/real
```

Champion, 20 assets, 2020→now:

| | |
|---|---|
| Up days | 19% |
| Down days | 20% |
| Flat days (in cash, no position) | **61%** |
| Days that account for the entire net gain | **4 out of ~2,300 (0.2%)** |
| Best 1% of days, as a multiple of the final gain | **2.6×** (the rest gave some back) |
| Median wait between new highs | 1 day |
| 90th percentile wait | 16 days |
| Worst wait | **1,386 days (3.8 years)** |

By calendar year (median asset): 2020 +7.1%, 2021 +59.8%, 2022 −8.3%, 2023 +2.3%, 2024 +39.0%,
2025 −18.3%, 2026 −7.1%.

So: **not every day, and not reliably every four years either.** The money arrives in a handful of
days per year — four days out of 2,300 in the median asset account for the whole gain — and the gaps
between those days are unpredictable, up to nearly four years. That is the honest shape of a trend
follower, and it explains why "make it back tomorrow" is a coin flip rather than a plan: tomorrow is
flat 61% of the time, and the days that pay cannot be scheduled.

## 2d. "If only $3 is left, does it know it needs $12?" — it does now

Two separate gaps were being conflated, and only one was visible before:

- **Against the goal line** — reported in the dashboard's Goal gap card.
- **Against the peak it once had** — now reported in dollars. Going $15 → $3 means
  `dollarsToRegainPeak = 12`, and `pctToRegainPeak = 400%`, because those are wildly different
  things to ask of an account. The peak is taken from the recorded equity curve and is **never
  re-based**; the risk rails re-base after a circuit breaker so the bot can resume, and that
  re-basing is exactly what would otherwise erase the memory of the loss.

And a harder problem sits underneath: **at $3 the bot cannot trade at all.** The exchange minimum is
$5 and the bot never deploys its whole balance, so one minimum order needs
`$5 / 0.97 = $5.15` of equity. Below that the bot is not paused, it is *stuck*: every signal is
unactionable and no amount of waiting or cleverness changes that. It used to log a warning and keep
saying "ready" on the dashboard. Now:

- `risk.blockReason = "below_min_notional"` instead of silently retrying;
- `status.capital` reports the minimum tradeable balance, the shortfall, and a plain message;
- the dashboard shows a red banner: *"below the exchange minimum: 3.00 USDT cannot place a 5 USDT
  order. Needs 2.15 more to trade again."*

The dollars are the point. A $12 gap on a $3 balance is not a $12 problem, it is a +400% problem,
and the second number is the one that should decide anything.

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
- Claimed, with data: 88% of 5%+ drawdowns were recovered, median 6 days.
- Not claimed: that the bot will reach $1/day. At the measured median rate it needs about $1,400 of
  capital to be at escape velocity at all, and $3,700 to earn $1/day on average — or a fundamentally
  different edge. Not a different sizing rule.

The next honest step is not a bigger position after a bad day. It is capital, or a strategy that
beats the champion out of sample. Neither is something a sizing rule can fake.
