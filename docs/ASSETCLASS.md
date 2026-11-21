# Outside crypto: the gate is insurance, not alpha

The strongest claim in this repo after [`CROSSSECTION.md`](CROSSSECTION.md) was that
"be long while the trend is intact, be in cash when it is broken" improved **risk-adjusted
return** — not just drawdown — in six of seven windows on twenty crypto assets.

One asset class is one observation. Crypto's 2019–2026 sample is a single bull–bear–bull cycle,
and a rule that halves drawdown will look like alpha in a sample that contains a −66% year. So
the test was: run the same rule on **equities, government bonds, currencies and commodities**,
where decades of independent history exist.

**Result: half the claim survived, and the more useful half did not.**

- **Drawdown reduction generalises.** Better in **22 of 26** instruments out of sample, median
  improvement **−11.4 points**. This is robust across four asset classes and fifty years.
- **Sharpe improvement does not generalise.** Better in **8 of 26** instruments out of sample
  (t = **−2.45**, i.e. reliably *worse*), and on a diversified basket it beat buy-and-hold but
  **lost to simply holding the ungated basket** in 2010–2024 (Sharpe 0.40 vs 0.68).

The crypto result where the gate improved Sharpe is therefore best read as **one cycle's worth of
evidence**, not a property of the mechanism. What is a property of the mechanism is that it
truncates the left tail. That is what insurance does, and it is worth having — but it is not
alpha, and I should not have called it "risk-adjusted return" on crypto evidence alone.

## The data

`data/realclass/*.csv` — 32 back-adjusted continuous futures series from Rob Carver's
`pysystemtrade` repository (`data/futures/adjusted_prices_csv`):

| Class | Instruments |
|---|---|
| Equity indices | SP500, NASDAQ, DAX, FTSE100, EUROSTX, NIKKEI, HANG, SMI, AEX, RUSSELL, TOPIX |
| Bonds | BUND, US10, US20, GILT, JGB, BTP |
| FX | EUR, GBP, JPY, CHF, AUD, CAD, NZD |
| Commodities | GOLD, SILVER, CRUDE_W, COPPER, CORN, WHEAT, SOYBEAN, GAS_US |

Coverage runs back to **1972** for CHF/CAD, 1975 for gold, 1982 for the S&P 500. This is daily
settlement data, not minute data, so it is cheap to ship (9.7 MB) and the history is long.

**Six series were excluded**: CRUDE_W, GILT, HANG, SOYBEAN, US10, US20. Their published "adjusted"
prices still contain raw contract rolls — SOYBEAN rises 57%, falls 55%, then falls 97% in four
consecutive days; US20 jumps 14× on its first day. A roll artefact is a data error, and repairing
one by rescaling is guesswork, so they were dropped rather than massaged. The detector is
deliberately blunt (any daily move above 50%) so it cannot quietly remove real crashes.

## Test 1 — each instrument against itself

Hold the instrument while it is above its own 200-day EMA, sit in cash otherwise. Paired
comparison, so instrument-specific drift, volatility and contract quirks cancel:

| | Full history | Out of sample (last 30% of each series) |
|---|---|---|
| Sharpe better | 12/26 (t = −0.71) | **8/26 (t = −2.45)** |
| Median Δ Sharpe | −0.02 | **−0.15** |
| Drawdown better | 21/26 | **22/26** |
| Median Δ drawdown | −11.1 pts | **−11.4 pts** |

By class, out of sample: equity 2/10 improve, bonds 0/3, FX 3/7, commodities 3/6. Nothing here
depends on the rebalance frequency — daily, 5-day and 30-day checking all give the same verdict
(Sharpe t between −1.0 and −4.1, drawdown better in 25–28 of 32 including the contaminated
series).

The pattern is legible: **equities and bonds lose Sharpe** because going to cash forfeits an
upward-drifting asset with positive carry, while **FX and commodities roughly break even** because
they mean-revert and their trends are choppier. Crypto was the outlier, not the rule.

## Test 2 — the diversified portfolio version

The literature's version of this mechanism is not long/flat on one asset; it is long/short,
diversified, monthly rebalanced. So I built that too (`allowShort` in
`src/portfolio/xsmom.ts`): equal weight 1/26, sign of the trailing return, gross exposure 100%.

| Window | Variant | CAGR | Sharpe | Max DD |
|---|---|---|---|---|
| 1990–2009 | long/flat, 200d gate | +2.2% | **0.63** | 15.0% |
| | long/flat, no gate | +1.7% | 0.35 | 28.2% |
| | long/short, 90d | +2.4% | 0.51 | 13.7% |
| | equal-weight buy & hold | −3.0% | 0.25 | 32.5% |
| 2010–2024 | long/flat, 200d gate | +1.9% | 0.40 | 16.5% |
| | long/flat, no gate | +4.5% | **0.68** | 18.4% |
| | long/short, 90d | −1.3% | −0.19 | 36.2% |
| | equal-weight buy & hold | −14.5% | 0.02 | 49.8% |
| Full | long/flat, 200d gate | +2.3% | **0.55** | 15.0% |
| | long/flat, no gate | +2.8% | 0.50 | 28.2% |
| | long/short, 90d | +0.7% | 0.17 | 34.7% |
| | equal-weight buy & hold | −0.7% | 0.31 | 32.5% |

Absolute returns are small because this is an unlevered 1/26 allocation with zero return on cash;
the fix in real portfolios is volatility targeting and leverage, which is a different experiment.

Three readings, in order of how much I trust them:

1. **The gate halves drawdown in every window** (28.2% → 15.0%; 32.5% → 15.0%; 18.4% → 16.5%).
   This is the finding I would defend.
2. **It beat buy-and-hold risk-adjusted over the full period** (0.55 vs 0.31) — but that is a
   comparison against a basket that lost money, not evidence of skill.
3. **It lost to simply holding the ungated basket in 2010–2024** (0.40 vs 0.68). In the most
   recent fourteen years of non-crypto data, being out of the market was the wrong choice.

And the honest version of the long/short result: in this unlevered, equal-weight form it did **not**
beat long/flat. Trend following as described in the literature uses volatility-scaled positions and
2–3× gross leverage across 50+ markets; this is a simplified cousin, and it should not be cited as
a replication of those results.

## What this changes about the project

[`INTELLIGENCE.md`](INTELLIGENCE.md) §4b rated "be long only while the trend is intact improves
risk-adjusted return" as **moderate–high** confidence. That was too strong, and the panel outside
crypto is why:

- **Drawdown containment: high confidence.** 22 of 26 instruments out of sample, four asset
  classes, fifty years, and consistent with the crypto panel (−61% vs −77% on BTC).
- **Return or Sharpe improvement: low confidence.** It fails out of sample outside crypto, and the
  crypto success is one cycle.

Which leaves a plainer description of what this system is: **a stop-loss with a good marketing
department.** That is not nothing — drawdown is what kills small accounts, and a rule that
reliably halves it across fifty years and four asset classes is worth running. But it is
insurance, and insurance is a cost you pay for protection, not a source of income.

## Reproduce

```bash
python3 scripts/fetch-assetclass.py           # 32 series from pysystemtrade, ~7 s
node --experimental-strip-types scripts/assetclass.ts --dir=data/realclass --rebalance=30
```

The diversified long/short comparison is `runXsMom` with `allowShort: true`, `hold: 999`,
`requirePositive: false`, `gate: null`.
