# The cross-section: twenty assets, one survivor

Every claim in this repo before this document rested on one asset. That is the
root cause of every "I'm not confident" in [`INTELLIGENCE.md`](INTELLIGENCE.md)
§4b: 33 trades in eight years cannot separate an edge from luck, and no amount
of cleverness over 33 decisions can be distinguished from noise.

So I built the thing that could actually settle it — a panel of **20 real
assets**, the same fee model, the same risk rules, a pre-registered grid, and a
time split. Then I let it judge the layers.

**What survived:** exactly one mechanism, and it is the oldest one in the
codebase — *be long while the trend is intact, be in cash when it is broken*. It
improves Sharpe in both halves of the sample, on one asset and on twenty. It has
**no fitted parameters**.

**What did not survive:** everything added since. The ensemble is exactly zero
(t = −0.01 across 20 assets). Cross-sectional momentum collapses out of sample:
median −3.0%/yr, and **0 of 50 configurations beat simply holding BTC**.

## The data

`data/real/*.csv` — 20 symbols, daily candles rebuilt from Binance's own
1-minute klines (the same pipeline documented in [`data/README.md`](../data/README.md)):

| Started | Assets |
|---|---|
| 2017 | BTC, ETH, BNB, LTC, NEO |
| 2018 H1 | ADA, ETC, IOTA, ONT, QTUM, TRX, VET, XLM, XRP |
| 2019 | ALGO, ATOM, BCH, DOGE, LINK, THETA |

Spot checks against public reference prices: ETH closed 4,628.78 on 2021-11-10
(ATH intraday 4,868 — matches), ADA's 2021-11-10 high 2.331, LTC 2018-01-01
close 222.61. These are real prices, aggregated correctly.

## Test A — the existing layers, across 20 assets

Single-asset strategy code, unchanged, 2020-01-01 → 2026-11-14 (all 20 assets,
2,510 bars each), $10 per account:

| | Trend | Ensemble | Buy & hold |
|---|---|---|---|
| Median CAGR | 16.2% | 13.4% | **13.0%** |
| Median Sharpe | 0.48 | 0.41 | **0.58** |
| Profitable after fees | 13/20 | — | — |
| Beats buy-and-hold on CAGR | 11/20 | — | — |
| Beats buy-and-hold on Sharpe | 7/20 | — | — |

Ensemble vs trend, paired by asset:

- Sharpe better on **7/20** (sign test p = 0.94), mean difference **−0.001**, t = **−0.01**
- Drawdown better on 10/20, mean difference +0.1 points — a coin flip
- Trades: 27.4 → 18.3

Block bootstrap over the panel (6-month blocks, 2,000 reps, cross-asset
correlation preserved):

| | Mean/month | 95% CI | Annualised |
|---|---|---|---|
| Trend | +3.91% | [−0.06%, +9.68%] | +58.4% |
| Ensemble | +3.40% | [−0.26%, +9.07%] | +49.4% |
| Buy & hold | +5.55% | [−0.92%, +12.69%] | +91.3% |
| Ensemble − trend | −0.51% | [−1.29%, +0.19%] | −5.9% |
| Trend − buy & hold | −1.33% | [−4.55%, +2.43%] | −14.8% |

The ensemble is **precisely nothing**: t = −0.01 on Sharpe, a coin flip on
drawdown, and a difference whose confidence interval straddles zero. Twenty
assets reproduce what one asset suggested, and the one asset's 4/6 result is now
visible for what it was — a small-sample fluke.

The trend core on alts is worse than on BTC: it beats buy-and-hold on returns
11/20 (a coin flip) but loses on Sharpe 13/20, because it gives up the huge
upside of a basket where a few names 50× and it is often in cash.

## Test B — cross-sectional momentum, 50 configurations

The mechanism that *needs* a panel: rank assets by trailing return, hold the top
K, stand aside while BTC is below its EMA200. Pre-registered before looking:
5 lookbacks × 5 holding counts × gate on/off = 50 configs, in-sample
2019-01-01 → 2022-12-31, out-of-sample 2023-01-01 → end.

| | Full | In-sample | **Out-of-sample** |
|---|---|---|---|
| Median CAGR | 3.2% | 29.8% | **−3.0%** |
| Median Sharpe | — | — | 0.25 (equal-weight: 0.41) |
| Configs with positive CAGR | — | — | 22/50 |
| Beat equal-weight | — | — | 17/50 |
| **Beat BTC buy-and-hold** | — | — | **0/50** |

The line that matters: the best in-sample configuration made **87.9%/yr** over
2019–2022 and then **13.7%/yr** out of sample, against 7.0% for doing nothing
clever. Twelve times the in-sample return, half the out-of-sample edge. That is
what a researched parameter looks like from the inside: it is not obviously
wrong, it is just fitted.

`hold > 1` is not even executable at $10 — five positions need $25 of minimum
notional — so those rows are a mechanism demo, not a plan.

## Test C — the survivor, with no parameters to fit

Strip the momentum ranking entirely. Hold an equal-weight basket of everything
while BTC is above its EMA200; hold cash otherwise. Lookback becomes irrelevant
by construction, so there is nothing to tune:

| Window | Window | Gate **off** | Gate **on** |
|---|---|---|---|
| 20 assets | IS 2019–22 | +40.8% / Sh 0.84 / DD 83.6% | **+65.9% / Sh 1.11 / DD 63.9%** |
| 20 assets | OOS 2023–26 | −7.1% / Sh 0.16 / DD 78.0% | **+13.7% / Sh 0.51 / DD 53.7%** |
| 20 assets | Full | +20.6% / Sh 0.64 / DD 83.6% | **+29.1% / Sh 0.74 / DD 64.9%** |
| BTC only | IS 2019–22 | +14.6% / Sh 0.55 / DD 76.6% | **+31.0% / Sh 0.79 / DD 65.2%** |
| BTC only | OOS 2023–26 | +22.4% / Sh 0.69 / DD 53.0% | **+37.3% / Sh 1.06 / DD 26.2%** |
| BTC only | Full | +27.3% / Sh 0.71 / DD 76.6% | +23.6% / Sh 0.70 / **DD 65.2%** |
| BTC+ETH | IS 2019–22 | +22.6% / Sh 0.67 / DD 80.6% | **+52.3% / Sh 1.00 / DD 70.6%** |
| BTC+ETH | OOS 2023–26 | +19.7% / Sh 0.61 / DD 60.3% | **+34.4% / Sh 0.92 / DD 47.6%** |
| BTC+ETH | Full | +30.3% / Sh 0.74 / DD 80.6% | **+33.5% / Sh 0.81 / DD 70.6%** |

Six of the seven market windows improve, the seventh gives up 3.7 points of CAGR
for 11.4 points of drawdown, and **drawdown improves in all seven**. In-sample
and out-of-sample, one asset and twenty, the gate does the same thing: it removes
the worst quarters.

Why this one and not the others: it makes **no prediction**. It is a switch that
reads one state — is the trend intact? — and its payoff comes from truncating
the left tail (2022: BTC −66%). It behaves like insurance: a small cost most
years, a large payoff in crashes. That is exactly the shape that survives
out-of-sample, because it does not depend on an estimate of expected return.

And at $10 it is the only version that is executable: one asset, one decision,
one switch a year.

## Five bugs found while building this

The panel is also a test harness, and it caught things single-asset tests could
never see:

1. **Forward-filling made dead assets look alive.** A delisted symbol showed a
   flat price instead of a gap, so it ranked as "low volatility" rather than
   "gone". Fixed with a freshness mask (`MAX_STALE_BARS`).
2. **The bootstrap kept only the first row of each block**, so every resample
   used months 0, 6, 12, … — a biased subset dressed up as blocks. Its intervals
   were negative while the observed mean was positive, which is how it was
   caught.
3. **The paired-difference panel was built per asset, not per month**, so time
   blocks became whole-asset blocks. It manufactured an interval that excluded
   its own point estimate.
4. **The rebalance schedule was derived from the lookback** — a parameter the
   portfolio wasn't using — so results changed when an irrelevant knob moved.
   The invariant test (hold-everything ⇒ lookback-independent) caught it.
5. **The gate traded before its EMA200 existed**, so the first ~200 days were
   "gated" without a gate, and gated/ungated arms started on different dates.

There is a sixth, conceptual one: the BTC filter was a **silent no-op** when BTC
was absent from the panel. It now throws. Every one of these was silent, and
every one would have biased results in a direction that looked plausible.

> **Followed up in [`ASSETCLASS.md`](ASSETCLASS.md).** The crypto result that the gate improves
> *risk-adjusted return* was tested on 26 non-crypto futures markets and only half survived: the
> drawdown reduction generalises (22/26 out of sample), the Sharpe improvement does not (8/26,
> t = −2.45). Read the gate claim there, not here.

## What this does and does not establish

Established, with a real sample:

- The ensemble adds nothing. Not "a little" — t = −0.01, coin-flip drawdown.
- Cross-sectional rotation does not beat holding BTC out of sample, in any of 50
  configurations.
- The regime gate improves risk-adjusted return out of sample, on 1 and 20 assets,
  in 6 of 7 windows, with no fitted parameters.

Not established:

- That the gate works **in the future**. Two out-of-sample windows from one asset
  class is not a law; it is one consistent observation, and crypto's regime mix
  will change.
- That any of this is an edge over an *index*. BTC buy-and-hold made 41.8%/yr in
  2023–2026; the gated version made 37.3%/yr with half the drawdown. Better
  risk-adjusted, not better return.
- That $10 becomes $300/month. That remains 125× beyond anything measured here.

## Reproduce

```bash
npm run xsection -- --dir=data/real --start=2020-01-01 --window=120
npm run xsmom -- --dir=data/real          # 50-config grid with the IS/OOS split
```

The gate ablation is the `hold=all` rows of the grid, or the same engine with
`requirePositive: false, hold: 999` — the settings under which momentum cannot
affect anything and only the gate is left.
