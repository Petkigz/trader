# The ensemble: regime detection + competition between families

Layers 3 and 4 of [`INTELLIGENCE.md`](INTELLIGENCE.md) — the system deciding *which kind of
strategy this market wants* instead of running one rule forever.

**Verdict, up front: on 3,240 authentic BTC daily candles the ensemble is not a validated
improvement over plain trend following.** It is indistinguishable on Sharpe (t ≈ 0.7), it
lowers drawdown in every span, and its best setting gave up return in two of six. `STRATEGY`
defaults to `trend`, and after this measurement it should stay there. The layer is kept
because the mechanism is sound and the evidence may change on more assets — not because it
won.

```bash
STRATEGY=ensemble npm run backtest -- --csv=data/btc_1d.csv
```

## Three parts

**1. Classify the regime** (`src/strategy/regime.ts`). Two axes, both observable in advance:

- *volatility* — recent (20d) against its own 200d baseline → `calm` / `normal` / `storm`
- *trend* — price versus the long EMA plus the EMA's annualised slope → `up` / `flat` / `down`

**2. Score the families** (`scoreFamilies`). Each family's entry/exit rule is replayed over the
trailing `ENSEMBLE_SCORE_WINDOW` bars; the compounded return of a frictionless position becomes
its score. These numbers are **rank-only** — no fees, because their job is to order two families,
never to report performance.

**3. Select the family with the higher score**, with one override: a volatility storm sends the
bot to cash regardless, since trailing scores describe a market that has already changed.

## The design decision that mattered

The first implementation let **both** families vote on exits — if either wanted out, the bot
exited. That is the safe-looking choice, and it destroyed the strategy (synthetic data):

| Implementation | Trades | Return | Max DD | Sharpe |
|---|---|---|---|---|
| Union of both exit rules | **193** | **−41.8%** | 60.2% | −0.29 |
| **One family owns the trade** | **14** | **+110.2%** | 55.0% | 0.57 |

`meanrev` exits when RSI recovers past 55 — which is most days. So the family that wasn't
selected kept closing trades the selected one had just opened, and it reopened on the next bar.
193 round trips × 0.2% ≈ **39% of the account in fees**, which is the fee floor from the main
README arrived at from the opposite direction.

Fix: **one family owns an open position** — whichever the scores favour. The other has no say
until ownership changes. A chooser must never trap a trade, so the storm override blocks new
entries but never forces an exit.

**An "intelligence" layer that raises trade frequency is self-defeating at $10, no matter how
good the selection is.**

## A knob that could not do anything (found and removed)

The original `ENSEMBLE_TEMPERATURE` was documented as "lower = more decisive switching". It was
a lie, and the tests couldn't see it: a softmax is **order-preserving**, so scaling its
temperature relabels the confidences and never flips the argmax. Selection was
`weights.trend >= weights.meanrev`, which is just `score.trend >= score.meanrev` for every
positive temperature.

The proof is that 90 backtests — 5 windows × 3 temperatures (1, 5, 20) × 6 spans — produced
**byte-identical** results for every temperature within a window. The parameter now no longer
exists; selection is the sign of a plain `edge`, and `meta.edge` reports it. Re-running 12 of
those configurations after the removal reproduced the old numbers **12/12 exactly**, so the
deletion is provably behaviour-neutral.

Lesson worth keeping: a parameter that only changes a *reported* number is a trap, because it
looks like a tuning surface. If a knob doesn't change a decision, delete it.

## Real-data validation

Everything above was measured on a synthetic random walk. That generator has **no volatility
clustering**, which is precisely the structure a regime classifier is supposed to exploit — so
the synthetic win was never evidence that the idea works. Here is the real test.

**Data:** `data/btc_1d.csv` — 3,240 daily candles built from Binance's own 1-minute klines,
2018-01-01 → 2026-11-14, no gaps (see that file's README for provenance). Every span ends on the
same date and includes 250 warm-up bars.

| Span | Trend ret | Ens ret | Trend DD | **Ens DD** | Trend Sharpe | Ens Sharpe | Trades | Fees |
|---|---|---|---|---|---|---|---|---|
| 3y | +114.1% | +116.1% | 36.7% | **27.0%** | 0.87 | **0.93** | 13 → 11 | — |
| 4y | **+105.3%** | +75.4% | 36.3% | **26.9%** | **0.68** | 0.60 | 19 → 16 | — |
| 5y | +104.3% | **+121.4%** | 39.4% | **34.3%** | 0.59 | **0.66** | 22 → 18 | — |
| 6y | +416.6% | **+544.1%** | 60.8% | **55.7%** | 0.85 | **0.96** | 28 → 21 | — |
| 7y | **+445.6%** | +331.1% | 60.8% | **55.5%** | **0.78** | 0.72 | 32 → 28 | — |
| 8y | +840.2% | **+890.3%** | 61.0% | **55.8%** | 0.85 | **0.89** | 33 → 25 | — |

Ensemble at its best window (`ENSEMBLE_SCORE_WINDOW=60`).

- **Drawdown: better in 6 of 6.** The consistent effect, worth 8–10 points.
- **Sharpe: better in 4 of 6**, mean 0.79 vs 0.77. Per-span differences are
  +0.06, −0.08, +0.07, +0.11, −0.06, +0.04 → mean +0.023, **t ≈ 0.7**. Indistinguishable from
  zero, and the spans overlap almost entirely, so the effective sample is smaller than six.
- **Trades: fewer in every span** (25 vs 33 at 8y). This is the one unambiguous, mechanically
  necessary win: lower fees.

### The window is noise, and I can prove it

`ENSEMBLE_SCORE_WINDOW=250` was chosen on synthetic data — where the first version of this
document admitted it carried selection bias. On real data the ranking inverts: the sweep over
all 15 combinations of window and temperature gives

| Window | Sharpe wins vs trend | Median Sharpe | Median DD |
|---|---|---|---|
| **60** | **4/6** | 0.80 | 44.9% |
| 500 | 1/6 | 0.72 | 54.2% |
| 250 | 1/6 | 0.65 | 44.0% |
| 750 | 0/6 | 0.68 | 50.4% |
| 120 | 0/6 | 0.56 | 49.9% |
| *trend* | — | *0.82* | *50.1%* |

The window that wins on synthetic data (250) is nearly the worst on real data; the window that
wins on real data (60) was mid-pack on synthetic. A parameter whose optimum moves when the
sample changes isn't a parameter, it's noise. **The default stays at 120 precisely because 60
won on the data I just measured** — switching it now would be fitting to the test set, the same
error in a smaller box.

## What this means

Two independent adaptation mechanisms — volatility-targeted sizing
([`ADAPTIVE.md`](ADAPTIVE.md)) and family selection — have now both landed in the same place:
**they reduce risk, not return.** Sizing costs return (8y: +784% → +478%) and cuts drawdown
(61.0% → 53.4%). Selection costs a little return in two spans and cuts drawdown everywhere.
Neither manufactures the daily income the brief asks for, and the ceiling in
[`INTELLIGENCE.md`](INTELLIGENCE.md) §4a says why: 33 round trips in 8.3 years is 4 decisions a
year, and no amount of cleverness over 4 decisions a year can be distinguished from luck.

What *would* change the verdict, in order of value:

1. **More assets.** Pool 20–50 pairs, score the families on each, and the same comparison gains
   the cross-section of independent samples the ceiling section asks for. This is the only route
   that can turn a t ≈ 0.7 into a real answer.
2. **A second family that makes money.** `meanrev` loses in every span tested (−11.7% to −20.8%),
   so selection is a choice between a winner and a loser; the ensemble's only job is damage
   control. Fix the family first.
3. **Deeper history or intraday data** — but the fee floor makes intraday a non-starter at $10.

Until one of those lands, `STRATEGY=trend` is the honest default.

## How to reproduce

```bash
# full history, both strategies
npm run backtest -- --csv=data/btc_1d.csv --strategy=trend    --out=/tmp/t.json --quiet
STRATEGY=ensemble ENSEMBLE_SCORE_WINDOW=60 \
  npm run backtest -- --csv=data/btc_1d.csv --strategy=ensemble --out=/tmp/e.json --quiet

# the span table: slice the CSV to the last N*365+250 rows, keeping the header,
# converting `date` to epoch-milliseconds, then run both strategies per slice.
# The sweep is the same loop over ENSEMBLE_SCORE_WINDOW in {60,120,250,500,750}.
```

`data/README.md` documents how the candle file itself is rebuilt from Binance minute data.
