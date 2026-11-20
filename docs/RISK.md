# The safety rails: what they cost and what they catch

The brief comes with a worry that is entirely reasonable — *if a learning layer changes behaviour
and gets it wrong, we lose money we can't spare.* This document measures what the existing safety
rails actually do, because the same question applies to them: **does each one earn its keep?**

Short answer: **at daily frequency, almost none of them fire.** The thing that gets the account out
of the market is the trend exit itself, not the breakers on top of it.

## How often it trades at all

This is not a day-trading bot and never was:

| | Measured (BTC, 8.31 years, $10) |
|---|---|
| Round trips | **33** |
| Per year | 3.97 |
| Per day | **0.011** — one decision every ~92 days |
| Average hold | 52.4 days |
| Time in the market | 56.9% |
| Fees paid, cumulative | $3.30 on a $10 account |
| Annual fee drag | 4 round trips × 0.24% ≈ **1.0% of equity per year** |

At four trades a year, fees are a rounding error. That is deliberate: the 193-trade churn measured
in [`ENSEMBLE.md`](ENSEMBLE.md) lost 39% of the account to fees, which is why trade frequency is
treated as a first-class constraint rather than a consequence.

## The loss distribution

Every fill from the full-history backtest (`BACKTEST_TRADE_LOG=1000`), paired into round trips:

| | Value |
|---|---|
| Trades | 33 (10 winners, 23 losers) |
| Win rate | 30.3% |
| **Average loser** | **−4.64%** |
| Median loser | −3.81% |
| Worst loser | −10.20% |
| Average winner | +57.2% |
| Best winner | +317.8% |
| **Longest losing streak** | **5** |

The shape is the whole strategy in one line: **23 small losses pay for 10 large wins.** A 30% win
rate means roughly two out of every three trades lose, and any run of them looks like failure while
it is happening. The longest streak hit exactly 5 — the halt threshold — once in 8.3 years.

## What the account can absorb

On $10 with a 97% position fraction (so $9.70 at risk), and no leverage, so the floor is zero:

| Scenario | Equity after |
|---|---|
| Typical loser (−4.6%) | $9.55 |
| Worst observed loser (−10.2%) | $9.01 |
| Worst **possible** trade: crash stop at 25% from entry | $7.57 |
| The observed 5-loss streak (−27.4% compounded) | $7.26 |
| The measured maximum drawdown (61%) | $3.90 |

Nothing here can produce a margin call or a negative balance: it is spot, long-only, one position.
The realistic worst case is **losing about 60% of $10 at some point**, which the backtest says
happened once in eight years and which the drawdown section of the README already warns about.

## Do the rails earn their keep?

Each rule switched off in turn, across the **20-asset panel**, 2020-2026, same code and fee model.
Paired against the baseline, per asset:

| Rule disabled | Median Δ CAGR | t | Assets improved | Median Δ drawdown |
|---|---|---|---|---|
| Crash stop (25%) | +0.0% | −1.25 | 0/20 | +0.0 pts |
| 5-loss halt (pause 7d) | +0.0% | 0.44 | 8/20 | +0.0 pts |
| 30% drawdown breaker | −0.1% | −1.33 | 10/20 | +0.5 pts |
| 8% daily stop | +0.0% | — | 0/20 | +0.0 pts |
| **All of them** | −0.3% | −1.20 | 8/20 | +0.9 pts |

**No rail is statistically distinguishable from doing nothing** (every |t| < 1.7), and two of them
never fired at all:

- **The crash stop fired once in 20 assets over seven years.** The EMA exit has usually already
  closed the position before price falls 25% *from entry*.
- **The 8% daily stop never fired.** On daily candles the exit rule acts first.

The 5-loss halt is the interesting one: on one asset it cut 29 trades down to 8 — a 3.6× change in
behaviour — with **no measurable change in outcome.** That is exactly the failure mode we fear from
a learning layer: different behaviour, indistinguishable result.

**This does not mean the rails are useless.** It means daily-bar backtests cannot see them work.
The crash stop and daily stop exist for intraday gaps — a 15% candle-down through the exit rule —
and this dataset only records one price per day. They are cheap insurance against an event the
backtest is blind to. What the ablation *does* establish is that they should never be credited with
the strategy's returns.

## What this means for adding a learning layer

The instinct behind the question is right, and the measurements sharpen it:

1. **The account survives bad streaks already.** Five losses in a row costs ~27% and the bot stays
   solvent by construction. A learner that adds a sixth kind of loss is not the threat.
2. **The real risk is behavioural churn without measurable benefit** — the 5-loss halt changing
   trade counts 3.6× for nothing, the ensemble halving trade counts for t = −0.01. Both are
   harmless only because they are small.
3. **So the honest design is a shadow-mode challenger**: it changes nothing about the live
   position, costs nothing, and can only be promoted by a rule fixed in advance. That is the
   version of "learning" that cannot cause the loss this question is worried about.

The rails stay. They are cheap, they cap the worst case by construction, and their failure mode is
inert rather than expensive — which is more than can be said for most things that trade.
