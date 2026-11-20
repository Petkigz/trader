# If it learned: where the information comes from, and how "better" is decided

Two separate questions, often conflated:

1. **How would it get the information?** — the inputs.
2. **How would it know the information made it better?** — the filter.

The second is the hard one. Anyone can wire a parameter to an update rule in an afternoon; that
part is not the difficulty. The difficulty is that a trading system generates so little feedback
that "better" and "lucky" are the same observation. So this document is mostly about the filter.

## 1. Where information would come from

### Channel A — its own trading outcomes

Richest in meaning, thinnest in volume. Every round trip already writes a record (entry price, exit
price, exit reason, realised PnL, hold days, fees), and every tick writes equity and risk state.

| | Measured |
|---|---|
| Round trips in 8.31 years | **33** |
| Per year | 4 |
| Labelled outcomes available per year | 4 |

That is the binding constraint on everything else. At n = 33, the smallest effect statistics can
prove is **R² ≈ 9.6%**; real predictors explain 0.1–1%. So Channel A can only teach the system
things with *very large* effects — "a crash stop would have saved 25%" is learnable; "rule A beats
rule B by 0.1 Sharpe" is not, and no model choice fixes that.

### Channel B — the market, across assets

Dense, free, and already in the repository: `data/real/` (20 crypto assets, 2,500–3,240 days each)
and `data/realclass/` (26 futures across four asset classes, back to 1972).

| | Observations |
|---|---|
| 20 crypto assets × ~2,500 days | ~50,000 daily bars |
| 26 futures × ~9,000 days | ~230,000 daily bars |
| Independent *decisions* they imply | thousands, not 33 |

This is where learning has statistical room. It is also where it was tested and failed: 50
configurations of cross-sectional rotation, median **+29.8%/yr in sample → −3.0% out**
([`CROSSSECTION.md`](CROSSSECTION.md)).

### Channel C — the world outside

Published papers, new indicators, other people's strategies, exchange rule changes. Note what this
actually is: **unlabelled proposals**, not data. A paper is a hypothesis with no evidence attached
that it survives *these* fees, *this* venue and *this* decade.

The only two things that legitimately enter from Channel C without a human:

- **Contract facts** — min notional, lot step, tick size, delistings. Fetched and validated every
  tick (`src/exchange/binance.ts:181`) because being wrong is a rejected order.
- **Price history** — candles, continuously.

Everything else in Channel C is a candidate for Channel B, not a fact.

## 2. How "right" is separated from "wrong"

This is the filter, in the order it has to be applied. Every stage exists because skipping it
produced a wrong answer somewhere in this repository's own history.

**Stage 1 — Write the decision rule before seeing the result.** Pre-registration. The rule names
the metric, the threshold, the sample and the split. Without this, an analyst who looks first is
not testing a hypothesis, they are writing a story about a coincidence. This repo has the receipts:
`ENSEMBLE_SCORE_WINDOW=250` was chosen after trying four windows, which is why
[`ENSEMBLE.md`](ENSEMBLE.md) now says that number carries selection bias it cannot remove.

**Stage 2 — Hold out data the choice never touched.** In-sample selects, out-of-sample judges. The
panel split is 2019–2022 in, 2023–2026 out; for futures, the last 30% of each series. A rule that
only looks good in the half that chose it has been evaluated exactly zero times.

**Stage 3 — Count how many things you tried.** Multiplicity is the silent killer. Test 50
configurations and the best of 50 looks good by construction. The expected maximum R² under a pure
null is **9.18% at n = 40, 1.90% at n = 200, 0.11% at n = 3,400** — so a "significant" result must
beat what the *search itself* would have produced. `expectedMaxZ()` in
`src/research/walkforward.ts` computes this, and `npm run research` refuses to call anything an
edge unless it clears that floor. Its honest verdict on this strategy was **"no edge found."**

**Stage 4 — Ask whether the test could have answered at all.** Minimum detectable effect at n
samples and k parameters is `F / (F + n − k − 1)`. If the claimed improvement is smaller than that,
the experiment cannot distinguish it from noise and the correct output is *inconclusive*, not
*positive*. This single check kills most proposed "learning layers" before they are built — the
effect claimed is smaller than the noise floor, so no amount of cleverness will show up.

**Stage 5 — Distrust a spike; require a plateau.** A real effect survives small perturbations of
its own parameters. The ensemble's favourite window moved from 250 (synthetic) to 60 (real) — the
definition of a spike. The gate, by contrast, has *no* fitted parameter, which is exactly why its
result was believable enough to go and test on 26 futures markets.

**Stage 6 — Replicate across assets and classes.** One asset is one observation. The crypto panel
said the gate improved Sharpe; the futures panel said it improves drawdown and *lowers* Sharpe
(8/26, t = −2.45). The second test is what moved the confidence rating in
[`INTELLIGENCE.md`](INTELLIGENCE.md) §4b from "moderate–high" to "low".

**Then, and only then, run it in shadow.** Even a challenger that clears all six stages changes
nothing about the live position. It executes in paper mode against its own ledger, promotion is a
pre-registered function of its own out-of-sample record, and demotion is automatic. The point is
that a filter can be fooled once — a champion/challenger arrangement limits what being fooled
costs.

## 3. What the filter cannot do

It controls **false positives, not absence of signal**. Run 50 honest configurations of a genuinely
poor idea and the filter's correct output is "0 of 50 survived", which looks like failure and is
actually the filter working.

It also cannot manufacture sample size. Four decisions a year is four decisions a year, whether the
model is a moving average or a gradient-boosted ensemble. The only way this system ever gets a fair
learning test is by borrowing sample size from the cross-section — which is why the panel exists,
and why the one honest test of learning in this repo was run there, and lost.

## 4. The bare minimum to build

| Piece | Where |
|---|---|
| Shadow execution with its own ledger | paper mode, `src/store/` |
| Panel + in/out split + block bootstrap | `scripts/xsection.ts`, `src/research/stats.ts` |
| Luck floor / multiplicity accounting | `expectedMaxZ`, `npm run research` |
| **Pre-registered promotion rule** | `src/research/challengers.ts` |
| **Challenger registry + demotion** | `ChallengerRegistry`, `data/challengers.json` |

```bash
npm run challenger -- --dir=data/real --replicate=data/realclass
npm run challenger -- --list
```

## 5. What happened when it was switched on

Three challengers, hypotheses written before any result was computed, judged only on
2024-01-01 onwards:

| Challenger | Verdict | Why |
|---|---|---|
| `meanrev-rsi35` | shadow | 26 held-out round trips, floor is 100 |
| `ensemble-w60` | shadow | edge +0.20%/mo sits **inside** the luck bar +0.21%/mo for 2 attempts |
| `trend-ema100` | shadow | cleared every crypto gate (+0.71%/mo vs bar +0.29%/mo) then **failed replication**: −0.7%/yr on 31 non-crypto instruments, 14/31 improved → promotion withdrawn |

**Zero promotions from three attempts**, and the most instructive case is the third. EMA100 passed
the sample floor, beat the multiplicity bar, and improved 50% of crypto assets — on crypto alone it
looked promotable. Stage 6 withdrew it, because the same change made things worse on 31 equity, bond
FX and commodity futures markets. That is precisely the failure this document was written to catch,
caught by the code rather than by my judgement.

### Two mistakes the build itself made

Both were caught by the machinery refusing to behave, not by review:

1. **A naive standard error promoted everything.** Using `sd/√n` across 20 *correlated* assets
   understates the bar by roughly the square root of the correlation — the first run promoted
   `ensemble-w60` and `trend-ema100` outright. Fixed by deriving the standard error from a
   time-block bootstrap over monthly differences, which keeps cross-asset correlation inside the
   interval.
2. **The futures roll filter was applied to crypto.** A blunt ">50% daily move means a contract
   roll" is right for back-adjusted futures and wrong for spot crypto, which genuinely fell 50% in
   a day in March 2020. It silently deleted eight of twenty assets. Now opt-in per panel.

Expect it to promote nothing for a long time. That is the filter doing its job, not the system being
broken.
