# What "auto-updating" means here

The request that produced this note was a trading system that keeps itself current — "auto
updating to the latest formulas and functions and features, a trading system with
intelligence". That phrase splits into two ideas which look similar and behave nothing alike.
One of them is the reason the bot can run unattended. The other is the most reliable way to
lose an account. This document separates them and says which is implemented.

---

## 1. What the system updates by itself (and should)

These update continuously with no human input, and each one is a real mechanism, not a claim:

| Thing | How | Why it must be automatic |
|---|---|---|
| **Contract rules** | `/api/v3/exchangeInfo` is read every tick; `minNotional`, `stepSize`, `tickSize`, `minQty` come from the exchange, never from the repo | If Binance changes a lot step and the bot has it hard-coded, every order starts getting rejected and the bot dies silently. This is one of the most common ways bots break in year two. |
| **Market data** | Closed candles fetched fresh each tick | A stale candle produces a stale signal. There is an explicit staleness guard: refuse to trade if the newest daily bar is more than 96h old. |
| **Position** | Derived from the exchange balance, not from the database | Wipe the database and the bot rebuilds. The exchange is the source of truth. |
| **Risk state** | High-water mark, drawdown, daily loss, loss streak, halt timers recomputed every tick | The circuit breakers must reflect reality now, not a snapshot. |
| **Clock drift** | `-1021` errors trigger a timestamp re-sync | Signed requests start failing after months otherwise — the classic "my bot just stopped" bug. |

The pattern: **facts about the world update automatically.** Whatever the exchange or the
market says is authoritative, and the bot re-reads it. That is where the real fragility of a
long-running system lives, and it is handled.

## 2. What it deliberately does not update

**Strategy parameters are never re-optimised on live data.** The shipped configuration
(EMA200, ±0.5% hysteresis, 25% crash stop) is fixed. It is not allowed to change itself.

One layer *does* adapt, and the boundary is deliberate: **position size adapts, rules do not.**
[`ADAPTIVE.md`](ADAPTIVE.md) describes the volatility-targeting layer (`ADAPTIVE_SIZING=1`),
which shrinks exposure when measured volatility rises. That is observable in advance and the
mapping is fixed, so it can be tested and reasoned about. Re-optimising the entry and exit
rules on live data cannot be, because the system would be scoring a change on the same data it
fitted the change to.

**No code is fetched and executed at runtime.** This is not caution for its own sake:

- A system that rewrites its own trading logic has no way to know whether the change was an
  improvement or a coincidence — it is optimising against the same data it is judging itself
  on.
- The failure is silent and gradual. It will look like it is working right up until it
  doesn't, and by then it has traded real money on a fitted illusion.
- Downloading code over the network and running it with exchange API keys is a supply-chain
  attack waiting to happen. The bot has **zero runtime dependencies** specifically so there is
  nothing to upgrade, deprecate or hijack.

There is a deeper reason. Profit in trading does not come from having the newest formula. The
things that reliably make a system survive — tight cost control, position sizing, refusing to
trade in bad conditions, honest measurement — have been stable for decades. Anything that
looks like a *new* formula edge is, by definition, something the market has not yet priced;
the moment it is published and adopted it stops working. A bot that chases the latest formula
is chasing the part of the field that decays fastest.

## 3. What it does instead: it lets you search, honestly

Refusing to self-optimise does not mean refusing to learn. It means the learning happens
**offline, with a gate.** That gate is `npm run research`.

```bash
npm run research                     # 8 years of BTCUSDT
npm run research -- --is=500 --oos=250
npm run research -- --csv=data/btc.csv
```

It walks forward through history. For each window it tries every parameter set on the
in-sample slice, keeps the winner, then scores that winner on the **next slice it has never
seen**. Two things make the result trustworthy:

1. **Only out-of-sample numbers count as performance.** The in-sample score is reported for
   context, not as a result.
2. **Every test is counted, and the module reports the score chance alone would have
   produced.** If you try 15 parameter sets, the best of them is expected to look like
   `mean + 2.2 standard deviations` even if none of them has any edge. That is the *luck
   floor*. A winner that does not clear its own luck floor has not been discovered — it has
   been fitted. (`src/research/walkforward.ts`, `expectedMaxZ`.)

A real run on deterministic synthetic data:

```
  best in-sample score              +57.40%
  luck floor (15 sets)              +61.36%   <- below this, a winner is noise
  out-of-sample compounded         +490.48%
  out-of-sample median window        +7.72%
  windows profitable                    60%   (3 of 5)

  VERDICT: no edge found.
```

Note what happened there: out-of-sample it made +490%, and the harness **still** refuses to
call it an edge, because the winner did not beat what 15 attempts produce by luck. That
strictness is the entire product. A tool that reported only the +490% would be the thing that
costs you money.

The rule this enforces: **search as much as you like, but count your searches.** That is not a
limitation of the harness, it is the only way a search can mean anything.

## 4. Intelligence, concretely

The word does not describe a system that rewrites itself. In this repo it means the bot:

- refuses to size an order it cannot fund (min-notional and lot-step checks before every entry);
- refuses to act on stale data;
- reduces its own risk after losses instead of averaging down;
- never blocks an exit, including when the kill switch is on;
- assumes the exchange balance is right and the database might be wrong;
- reports its own limitations, including a backtest that contradicts the sales pitch.

Judgement under constraint is intelligence. Adapting a formula until the numbers look good is
how that judgement gets destroyed.

## 4a. How much intelligence is actually possible

The ceiling is not set by how sophisticated the model is. It is set by **how many learning
opportunities exist**, and this strategy produces very few: 40 round trips in 8.7 years, or
**4.6 decisions per year.**

Minimum `R²` that could be *proved* at 95% confidence (F-test, `R² = F/(F + n − k − 1)`):

| Observations | 1 predictor | 3 predictors |
|---|---|---|
| **40** (this strategy's trades) | **9.18%** | 6.74% |
| 200 | 1.90% | 1.31% |
| 3,400 (every daily bar) | 0.11% | 0.08% |
| 40,000 (every 4h bar) | 0.01% | 0.01% |

Honest predictors of daily returns explain **0.1%–1%** of variance. So with 40 events, a
learned edge would need to be 10–100× stronger than anything real in order to be
distinguishable from luck. **Any model fitted to 40 trades is unfalsifiable by construction** —
which is exactly why it will look excellent in-sample and fail live.

The obvious escape — use more bars — runs into the fee floor:

| Frequency | Events in 8.7y | Fee drag/yr | Provable `R²` | Verdict |
|---|---|---|---|---|
| Daily trend (shipped) | 40 | 0.9% | 9.18% | fees fine, no statistical power |
| Weekly | 452 | 10.4% | 0.85% | **the only workable frontier** |
| Daily | 3,175 | 73.0% | 0.12% | fees dominate |
| 4-hourly | 19,053 | 438.0% | 0.02% | impossible |

**The sample size that intelligence needs sits at a frequency where the fees eat the account.**
That is the whole constraint, and it is why the shipped system is deliberately simple: a simple
rule with no fitted parameters can survive on 40 observations, while a clever rule with twelve
of them cannot.

Ranked by what can honestly be built:

| Layer | Verifiable at $10? | Status |
|---|---|---|
| Risk and execution discipline | yes — mechanically | built |
| Adaptive exposure (vol targeting) | yes — measurable | built, [`ADAPTIVE.md`](ADAPTIVE.md) |
| Regime switching between strategy families | partly — few independent regimes | **built**, [`ENSEMBLE.md`](ENSEMBLE.md) |
| Online ensemble weighting of sub-strategies | partly — allocation adapts without fitting a signal | **built**, [`ENSEMBLE.md`](ENSEMBLE.md) |
| Learned signal model / meta-labelling | **no** — 40 events | would be unfalsifiable |
| LLM-in-the-loop sentiment | **no** — not backtestable, unproven at daily horizon | possible, not advisable |
| Self-rewriting strategy logic | **no** — see §2 | refused |

The one route that could legitimately unlock a learned model is **pooling across many assets**
(fifty pairs × three thousand days ≈ 150,000 observations) to learn general crypto dynamics,
then applying the model to BTC. That is real statistics rather than numerology, and it is the
only version of "learned intelligence" worth attempting in this repo.

## 4b. How much confidence each claim deserves

Asked directly: *am I confident in its intelligence?* **No.** Not "mostly, with caveats" — the
adaptive layers have not earned confidence, and the reason is structural rather than a missing
feature. Here is the graded ledger, so the word "intelligence" is not doing unpaid work.

| Claim | Confidence | Why |
|---|---|---|
| Runs unattended for months | **High** | Stateless ticks, atomic locking, reconciliation, 138 passing tests |
| "Be long only while the trend is intact" reduces drawdown | **High** | 22 of 26 non-crypto instruments out of sample, four asset classes, fifty years, median −11 points — [`ASSETCLASS.md`](ASSETCLASS.md) |
| The same rule improves risk-adjusted *return* | **Low** | Fails outside crypto (8/26 out of sample, t = −2.45); the crypto win is one cycle, not a law |
| Caps worst drawdown vs holding | **High** | −61% vs −77% on BTC; drawdown better in 7/7 crypto windows and 22/26 futures |
| Adaptive sizing improves risk-adjusted return | **Low** | Cuts drawdown 61% → 53% and return 784% → 478%: de-risking, not edge |
| Beats buy-and-hold on return | **Low** | +784% vs +767% on BTC; on 20 assets, trend beats holding on only 11/20 |
| Ensemble selection adds intelligence | **None** | 20 assets: Sharpe better on 7/20, t = −0.01, drawdown a coin flip |
| Cross-sectional rotation adds intelligence | **None** | 0 of 50 configurations beat BTC out of sample; median −3.0%/yr |
| High-frequency trading is unviable at $10 | **High** (a *negative*) | 39% of the account lost to fees in the measured churn |

Two arithmetic reasons the upper rows can't rise on this evidence:

**The decisions are too few to prove anything.** 33 round trips in 8.3 years is 4 decisions a
year. For a single predictor at n = 33, the smallest effect that is statistically provable is
R² ≈ **9.6%**. Real market predictors explain 0.1–1%. So a genuine edge would be sitting an
order of magnitude below the noise floor on a single asset — which is why the panel in
[`CROSSSECTION.md`](CROSSSECTION.md) was built, and why it is now the only evidence that counts.

**The six spans are not six experiments.** They are nested subsets of one price series sharing
the same final bar, so they are almost perfectly correlated. Four Sharpe wins out of six has a
sign-test p of **0.34** — a coin flip with better marketing. Twenty assets settled it: 7/20,
t = −0.01.

**The panel settled the rest.** Cross-sectional momentum, 50 configurations, an in-sample and an
out-of-sample half: the median configuration made 29.8%/yr in sample and −3.0%/yr out, and none
of the 50 beat simply holding BTC. The one mechanism that improved both halves — the trend gate —
does so with no fitted parameters, which is why it is the only row above that earns more than
"low".

What I *am* confident in is the negative work, because negative results don't need a large
sample to be real: the union-of-exits churn, the fee floor, the temperature knob that could not
switch anything, `meanrev` losing in all six spans, and the parameter that changed its optimum
when the data changed. Those are mechanical facts, and they are where most of this system's
actual value has come from.

What would move the second column now:

1. **Forward paper trading.** Every result here is still a backtest. The harness supports it; only
   time substitutes for it.
2. **A reason for the crypto gap.** The gate improved Sharpe on crypto and degraded it on futures.
   Either crypto's crashes are violent enough that insurance pays for itself, or 2019–2026 was a
   lucky cycle. Separating those two needs more cycles, not more code.
3. **A second family that doesn't lose money.** Selection between a winner and a loser can only
   reduce exposure, which is exactly what the measurements show.

The honest description, after 20 crypto assets and 26 non-crypto instruments: **a stop-loss with
a good marketing department.** Knowing when to be out of the market reliably halves drawdown
across four asset classes and fifty years — that part survives everything — but it does not
reliably improve return, and the version of it that looked like alpha in crypto was one cycle.

Insurance is worth running. It is still a cost, not an income.

## 5. Where the multi-venue idea actually stands

The `Exchange` interface means a new venue is one adapter and nothing else in the engine
changes — roughly 150 lines. That is why the Binance adapter is cleanly separable.

**MetaTrader is not a like-for-like swap, and this is the honest blocker:** an MT5 EA executes
inside the MetaTrader terminal. There is no HTTP endpoint and no cron trigger, so an MT5
adapter cannot be called from Vercel the way `/api/tick` is. It requires a Windows VPS running
around the clock (~$10–15/month) — which is more than a $10 account can ever earn. See
[`ASSET.md`](ASSET.md) §3 for why that matters at this size, and §"If the goal is 10× your
money in a month" for the measured odds.

So the sequencing is: the same strategy logic, one venue at a time, starting with the one that
costs nothing to host. A second venue becomes interesting when the account can absorb a VPS.

---

## Summary

| | Auto-updates | Why |
|---|---|---|
| Exchange contract rules | **yes** | they change without warning |
| Market data | **yes** | stale data is wrong data |
| Risk state, position | **yes** | must reflect reality now |
| Strategy parameters | **no** | self-optimising is self-deceiving |
| Position size (vol targeting) | **yes** | `ADAPTIVE_SIZING=1`, see [`ADAPTIVE.md`](ADAPTIVE.md) |
| Code / "latest formulas" | **no** | supply chain + guaranteed overfit |
| Edge validation | **yes, offline** | `npm run research`, with a luck floor |
