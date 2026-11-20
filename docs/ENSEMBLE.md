# The ensemble: regime detection + competition between families

Layers 3 and 4 of [`INTELLIGENCE.md`](INTELLIGENCE.md) — the system deciding *which kind of
strategy this market wants*, rather than running one rule forever.

Enabled with `STRATEGY=ensemble`. The default remains `trend`, because the evidence below is
encouraging but not sufficient to change a default on synthetic data alone.

```bash
STRATEGY=ensemble npm run backtest -- --years=8
STRATEGY=ensemble ENSEMBLE_SCORE_WINDOW=250 npm run tick
```

## Three parts

**1. Classify the regime** (`src/strategy/regime.ts`). Two axes, both observable in advance:

- *volatility* — recent (20d) against its own 200d baseline → `calm` / `normal` / `storm`
- *trend* — price versus the long EMA, plus the EMA's annualised slope → `up` / `flat` / `down`,
  with a 0–1 strength score

**2. Score the families** (`scoreFamilies`). Each family's own entry/exit rule is replayed over
the trailing `ENSEMBLE_SCORE_WINDOW` bars, and the compounded return of a frictionless position
becomes its score. These numbers are **rank-only** — they exclude fees and slippage because
their job is to order the families, never to report performance.

**3. Select.** Softmax over the scores (`ENSEMBLE_TEMPERATURE`), with one hard override: a
volatility storm sends the bot to cash regardless of what the scores say, because the scores are
trailing and in a storm they describe a market that has already changed character.

## The design decision that mattered

The first implementation let **both** families vote on exits — if either wanted out, the bot
exited. That is normally the safe-looking choice, and it destroyed the strategy:

| Implementation | Trades | Return | Max DD | Sharpe |
|---|---|---|---|---|
| Union of both exit rules | **193** | **−41.8%** | 60.2% | −0.29 |
| **One family owns the trade** | **14** | **+110.2%** | 55.0% | 0.57 |

The mechanism: `meanrev` exits when RSI recovers past 55 — which is *most days*. So the family
that was not selected kept closing trades the selected one had just opened, and the selected one
reopened on the next bar. 193 round trips × 0.2% is roughly **39% of the account in fees**, which
is exactly the fee floor from the main README, arrived at from the opposite direction.

Fix: **the trade is owned by one family** — whichever the scores currently favour. The other
family has no say until ownership changes. A chooser must never trap an open position, so the
storm override blocks new entries but never forces an exit.

This is the most useful thing in this document: **an "intelligence" layer that increases trade
frequency is self-defeating on a $10 account, no matter how smart the selection is.**

## What it measures

Six years of deterministic synthetic data, $10, comparing Sharpe across different history spans
(all ending on the same date):

| Years of history | Trend return | Ensemble return | Trend DD | Ensemble DD | Trend Sharpe | Ensemble Sharpe |
|---|---|---|---|---|---|---|
| 3 | +38.5% | **+120.8%** | 41.8% | 40.2% | 0.46 | **0.91** |
| 4 | +38.5% | **+120.8%** | 41.8% | 40.2% | 0.40 | **0.81** |
| 5 | +38.5% | **+120.8%** | 41.8% | 40.2% | 0.36 | **0.73** |
| 6 | +141.3% | **+151.6%** | 44.8% | 40.2% | 0.61 | **0.67** |
| 7 | **+379.3%** | +291.5% | 49.9% | 42.9% | **0.85** | 0.81 |
| 8 | **+544.7%** | +425.8% | 49.9% | 42.9% | **0.87** | 0.83 |

Read honestly:

- **Drawdown improves in all six spans** (40.2–42.9% vs 41.8–49.9%). This is the consistent,
  repeatable effect.
- **Sharpe improves in four of six**, but the two losses are the *longest* spans.
- **Upside is given up in strong bull runs** (−119 pts at 8 years), because the regulator keeps
  pulling the bot out of a market that is trending cleanly.

That is the same trade the adaptive-sizing layer made: **adaptation here de-risks, it does not
add return.** Two independent mechanisms producing the same conclusion is worth more than either
alone.

## The caveat I have to state

**I chose `ENSEMBLE_SCORE_WINDOW=250` after trying 60, 120, 250 and 500 and keeping the best.**
That is precisely the behaviour [`INTELLIGENCE.md`](INTELLIGENCE.md) warns about, and it means
the 250 figure carries a selection bias I cannot remove by re-running it. The *structural* fix
(one owner) is principled and its effect is unmistakable — 193 → 14 trades. The choice of window
is not, and should be treated as unvalidated.

Two further limits:

- **Synthetic data has no volatility clustering**, which is exactly what a regime classifier is
  supposed to exploit. A random-walk generator can show the mechanics working; it cannot show
  whether regime detection makes money.
- **At $10 the bot can hold one position**, so this selects between families. It cannot blend
  them. True ensemble diversification needs capital for at least two minimum-notional positions.

To validate on real data:

```bash
npm run backtest -- --years=8                                   # trend baseline
STRATEGY=ensemble npm run backtest -- --years=8                 # ensemble
STRATEGY=ensemble ENSEMBLE_SCORE_WINDOW=250 npm run backtest -- --years=8
```

If the ensemble's Sharpe is not higher on **real** data across several spans, keep
`STRATEGY=trend`. It is off by default for exactly that reason.
