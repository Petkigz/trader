# Adaptive sizing: the intelligence layer

`src/strategy/adaptive.ts` — the bot changing its own behaviour in response to the market,
with no human in the loop and no config edit.

Enabled with `ADAPTIVE_SIZING=1`. Off by default so the documented backtest stays exactly
reproducible.

---

## What it does

Standard volatility targeting, which is what discretionary and systematic funds actually use:
**hold risk roughly constant instead of holding position size constant.**

A fixed `POSITION_FRACTION` commits the same money whether the market is quiet or violent, so
the account silently takes more risk in violent weeks — exactly when it can least afford to.
The adaptive layer measures recent volatility and scales the position against it:

```
realised  = annualised sd of daily log returns over VOL_WINDOW (default 20) days
baseline  = the same over VOL_BASELINE_WINDOW (default 200) days
scale     = clamp(TARGET_VOL / realised, MIN_SCALE, MAX_SCALE)
regime    = storm  if realised >= STORM_VOL_MULTIPLE (2.0) x baseline   -> extra x0.5
            calm   if realised <= CALM_VOL_MULTIPLE  (0.7) x baseline
fraction  = clamp(POSITION_FRACTION x scale, 0, min(1, POSITION_FRACTION x MAX_SCALE))
```

So when volatility doubles, the position halves — automatically, on the next tick.

### Three constraints that make it safe

1. **`MAX_SCALE` defaults to 1.** The layer can shrink a position but not enlarge one. Leaning
   in is how a drawdown becomes a wipeout. Raise it if you want full two-sided vol targeting.
2. **It reads volatility, not recent profit.** Volatility is a stable property of a market.
   Recent wins are mostly noise, and sizing up after three good trades is the behaviour that
   empties accounts.
3. **It never touches the entry or exit rules.** Those stay fixed and backtestable. Only *how
   much* is committed to a signal adapts — see the boundary drawn in
   [`INTELLIGENCE.md`](INTELLIGENCE.md) §2.

The function is pure: same candles + same config → same answer, which is why the backtester
and the live engine share it (`src/backtest.ts` and `src/engine.ts` both call
`adaptiveFraction`). Header discipline: no lookahead — the backtester passes
`daily.slice(0, i + 1)`, i.e. only closed bars.

## What it measured

Six years of deterministic synthetic data, $10 start, 17 trades in the static run:

| Config | Return | Max drawdown | Sharpe | Trades |
|---|---|---|---|---|
| **Static (baseline)** | **+141.3%** | **44.8%** | **0.61** | 17 |
| target 60%, maxScale 1 | +124.4% | 44.8% | 0.59 | 17 |
| target 40%, maxScale 1 | +92.8% | 36.9% | 0.57 | 15 |
| target 30%, maxScale 1 | +72.7% | 32.4% | 0.58 | 14 |
| target 60%, maxScale 2 | +118.9% | 46.5% | 0.57 | 18 |

Read honestly: **adaptation bought drawdown reduction and paid for it with return, roughly
one-for-one. It did not improve risk-adjusted performance.** Sharpe is flat (0.57–0.59) against
a static 0.61, and leaning in (`MAX_SCALE` > 1) made things marginally worse.

That is the normal result, not a bug. On an unlevered spot strategy already sized at 97% of
cash there is essentially **one degree of freedom: deploy less.** There is no room to be more
aggressive without borrowing, and the layer is deliberately not allowed to borrow.

## The caveat that matters

**Synthetic data is the worst possible test bed for volatility targeting.** The generator
produces independent daily draws — it has *no volatility clustering*. Real markets cluster:
violent days follow violent days, and that persistence is exactly the mechanism vol targeting
exploits. A flat Sharpe on i.i.d. data is what you would expect even if the technique works
perfectly on real markets.

So the table above settles the *mechanics* (it engages, it de-risks, it is stable) and does
**not** settle whether it makes money. That needs real history:

```bash
npm run backtest -- --years=8 --capital=10                          # baseline
ADAPTIVE_SIZING=1 npm run backtest -- --years=8 --capital=10        # adaptive
ADAPTIVE_SIZING=1 TARGET_VOL=0.3 npm run backtest -- --years=8      # tighter target
```

Compare `maxDrawdownPct` and `sharpe` in the two reports. If the adaptive Sharpe is not higher
on real data, leave it off — it is costing you return for nothing.

## Why this and not "self-optimising"

This adapts *exposure*. It does not adapt *rules*, and it does not rewrite itself. The
distinction is drawn in [`INTELLIGENCE.md`](INTELLIGENCE.md): a system that re-optimises its
own entry/exit logic on live data cannot tell an improvement from a coincidence, because it is
judging the change on the same data it fitted it to. Adapting the size of a bet against
measurable volatility has none of that problem — volatility is observable in advance, and the
rule mapping it to position size is fixed.
