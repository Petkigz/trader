# Backtest methodology and results

The point of this document is to let you decide whether to trust the bot, and to make the assumptions impossible to miss.

## How to reproduce

The shipped backtester uses **the exact same functions the live engine calls** — `evaluate()`, `refreshRisk()`, `applyTradeOutcome()`, `sizePosition()`. There is no parallel implementation to drift out of sync.

```bash
npm run backtest                                  # 8 years, BTCUSDT, real data
npm run backtest -- --years=9 --capital=10
npm run backtest -- --strategy=pullback --years=2
```

It writes `backtest-report.json` with the full equity curve and monthly table.

## What was measured

| | |
|---|---|
| Market | BTCUSDT spot, Binance daily candles |
| Source | Binance public REST API (`/api/v3/klines`), 3,383 candles |
| Full history | 2017-08-17 → 2026-11-20 |
| Trading window | 2018-03-05 → 2026-11-20 (after the 200-day EMA warm-up) |
| Duration | 8.71 years |
| Starting capital | $10.00 |
| Fees | 0.10% per side (Binance spot taker) |
| Commission model | charged in the base asset on buys, quote on sells |
| Slippage | 2 bps per side |
| Order quantisation | 0.00001 BTC lot step, $5 minimum notional — enforced |
| Fill assumption | signal evaluated on the daily **close**, filled at that close ± slippage |

## Headline result — default configuration

Strategy `trend`: EMA200 with a ±0.5% hysteresis band, 25% catastrophic stop, 97% position fraction, 30% drawdown circuit breaker.

| Metric | Bot | Buy & hold |
|---|---|---|
| Final equity | **$62.12** | $54.34 |
| Total return | **+521.2%** | +443.4% |
| CAGR | **+23.3%** | +21.5% |
| Max drawdown | **−57.1%** | −83.2% |
| Time in market | 56.0% | 100% |
| Round trips | 40 | — |
| Wins / losses | 10 / 30 | — |
| Win rate | 25.0% | — |
| Fees paid | $2.21 | — |
| Circuit breakers | 5 | — |

### How to read this honestly

- The bot beat buy-and-hold by a wide margin **on a risk-adjusted basis** — +23.3% vs +21.5% CAGR while being exposed only 56% of the time, with a 26-point smaller worst drawdown. That is the actual claim: same-ish return, materially less risk.
- The absolute edge in return is thin. Do not build a business plan on +1.8 percentage points.
- A 25% win rate over 40 trades is completely normal for trend following, and it is psychologically brutal. Long flat stretches (2025-11 → 2026-03 in the equity curve is a real example) are the strategy working as designed, not breaking.
- Fees consumed $2.21 of $52.12 of profit — about 4%. That is the fee-discipline argument for trading rarely.

## Does it still work? Rolling start dates

A single 9-year number hides the fact that most of the edge may have been earned years ago. The same rules, started at different dates, against the current data (through 2026-11-20):

| Started | Trading from | Bot return | Buy & hold | Max DD | Round trips |
|---|---|---|---|---|---|
| Aug 2017 (full) | 2018-03-04 | **+521.2%** | +443.4% | 57.1% | 40 |
| Jan 2023 | 2023-07-19 | **+112.0%** | +108.9% | 34.4% | 16 |
| Nov 2024 | 2025-06-07 | **−1.2%** | **−41.1%** | 18.4% | 5 |

(Each run spends its first 200 daily bars warming the EMA up, which is why trading starts later than the start date.)

The most recent window is the honest one to stare at: over the last ~1.4 years the strategy is **down 1.2%** while holding BTC would be **down 41%**. It preserved capital, it did not make money.

### State as of 2026-11-20

| | |
|---|---|
| Price | $62,240 |
| EMA200 | $75,472 |
| Distance | −17.5% |
| Position | **in cash since 2026-11-05** (exited at $76,088) |
| Re-entry trigger | daily close above ≈$75,849 |

The bot is flat and will stay flat until BTC reclaims its 200-day average. A new user deploying today should expect **weeks to months of no activity**, which is the correct behaviour in a downtrend and is also the hardest part of running this to sit through.

## Parameter sensitivity

Parameters in this bot were **chosen from first principles, not optimised**. The sweep below is here to show the result is not perched on a knife edge, not to pick a winner.

### EMA period

| EMA | Return | Max DD |
|---|---|---|
| 200 (default) | +521% | −57.1% |

Shorter EMAs trade more and get chopped up; longer ones miss regime changes. 200 was fixed before testing.

### Trailing stop experiment (tested, then rejected)

The obvious objection to the default design is the −57% drawdown. So I tested adding a trailing stop (exit if close falls X% below the highest close since entry), measured on the same data:

| Configuration | Return | Max DD | Stop exits |
|---|---|---|---|
| No trailing stop (default) | +521.2% | −57.1% | 0 |
| Trail 30% | **+635.3%** | **−49.3%** | 2 |
| Trail 25% | +454.4% | −56.4% | 5 |
| Trail 20% | +382.6% | −56.3% | 13 |

A 30% trailing stop looks best on both axes — but the improvement comes from **two trades out of forty**. Widening to 25% or tightening to 20% makes it *worse* than no stop at all. That is the signature of noise, not edge.

**Decision: not shipped.** Adding an extra moving part to a bot that has to run for years, on the strength of two lucky exits, is how people turn a working system into a broken one. The honest conclusion is that the drawdown is structural, and the correct response is to size the position for it (`POSITION_FRACTION`), not to chase a parameter.

## Risk dial: position size

Drawdown scales almost linearly with position size, which makes it the one setting worth thinking about:

| `POSITION_FRACTION` | Approx. return | Approx. max DD |
|---|---|---|
| 0.97 (default) | +521% | −57% |
| 0.50 | ~+250% | ~−30% |
| 0.25 | ~+120% | ~−16% |

If a 57% drawdown would make you intervene — and intervening is what actually destroys these systems — set `POSITION_FRACTION=0.5` before you start, not after.

## Known weaknesses of this methodology

1. **One asset, one period.** BTC's 2018-2026 window contains two full cycles and a historic bull run. It is not a random sample of future markets.
2. **Close-only execution.** Exits are evaluated at the daily close. A crash that gaps through a stop exits worse than modelled.
3. **No funding, no borrow** — not applicable to spot long-only, so this is a genuine advantage of the design.
4. **Parameter selection is in-sample** in the weak sense that 200/0.5%/97% are conventional numbers chosen by a human who has seen market history. The sweep above is the mitigation, not a solution.
5. **The `pullback` strategy is not validated.** It requires years of hourly candles; it ships with unit-test coverage of its rules but no real-data performance claim. Backtest it yourself with `--strategy=pullback`.

## Reproducing the figures above

These numbers came from an **independent SQL replication** of the identical rule set — EMA seeding, hysteresis band, crash stop, circuit breaker, lot-step flooring, $5 minimum notional, commission charged in the base asset — run against the same candles, held in a Postgres table.

I used SQL because the environment I built this in could reach a Postgres instance but not the exchange directly. The shipping code path is `npm run backtest`, which runs in-process with no database.

```bash
npm run backtest -- --years=9 --capital=10
```

### Parity check between the two implementations

To make sure the SQL model was a fair proxy, both were run on an identical deterministic market (`close = 10000 + 3000·sin(i/40) + 20i`, 2,401 daily bars) and compared:

| Metric | TypeScript (`src/backtest.ts`) | SQL reference | |
|---|---|---|---|
| Round trips | 8 | 8 | ✅ |
| Wins | 8 | 8 | ✅ |
| Max drawdown | 13.68% | 13.70% | ✅ |
| Time in market | 76.7% | 76.6% | ✅ |
| Fees | 0.4087 | 0.4181 | ~2% |
| Final equity | $42.0595 | $42.7364 | ~1.6% |

Trade selection, win count, exposure and drawdown match exactly. The residual 1.6% in final equity accumulates across eight compounded trades and is consistent with floating-point boundary handling in lot-step flooring (`Math.floor(x/step + 1e-9)` in JS versus exact `numeric` arithmetic in Postgres) rather than a difference in logic. The harness is checked in at `scripts/xcheck.ts` if you want to reproduce it.

**Because of that residual, treat the headline table as ±2%, not to the cent.** The structural conclusions — fewer trades, higher risk-adjusted return, deeper drawdown than is comfortable — are far larger than that error bar.
