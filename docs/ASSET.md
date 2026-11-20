# Which exchange, which asset

Two decisions determine whether a $10 bot can work at all: the **fee tier** and the
**asset**. Everything else in this repo is detail. This note records both decisions
and the measurements behind them, so they can be re-checked rather than trusted.

All market data below was pulled from the live Binance REST API on **2026-11-20**.

---

## 1. Exchange: Binance spot

The bot talks to Binance spot (`https://api.binance.com`, overridable with
`BINANCE_BASE_URL`). It reads `/api/v3/exchangeInfo` at runtime and takes
`minNotional`, `stepSize` and `tickSize` from the symbol's filters, so it adapts to
any spot pair instead of hard-coding the constraints of one.

Verified live for the two leading candidates:

| | `BTCUSDT` | `ETHUSDT` |
|---|---|---|
| `minNotional` | 5.00 USDT | 5.00 USDT |
| `stepSize` | 0.00001 | 0.0001 |
| `tickSize` | 0.01 | 0.01 |
| best bid / ask | 61,783.59 / 61,783.60 | 1,750.18 / 1,750.19 |
| relative spread | 0.0016 bps | 0.057 bps |

Both clear a $9.70 order roughly **1.9×** over the minimum notional. Spread is
irrelevant at this size — a half-spread on $9.70 is a fraction of a cent. The
**10 bps taker fee is the only real cost**, and it is ~600× larger than the spread.

### Why the fee tier decides everything

The bot sends `MARKET` orders, so it pays the **taker** fee, 0.10% per side at
Binance VIP-0 (0.075% with the BNB discount). A round trip therefore costs 0.20% of
the position. The strategy's backtest made 40 round trips, so at $10:

| Exchange | Taker, entry tier | Round trip | 40 round trips | % of the $10 |
|---|---|---|---|---|
| **Binance spot** (verified) | **0.10%** | 0.20% | **$0.78** | **7.8%** |
| Kraken Pro (lowest figure found) | 0.26% | 0.52% | $2.02 | 20.2% |
| Kraken Pro (common figure) | 0.40% | 0.80% | $3.10 | 31.0% |
| Kraken Pro (highest figure found) | 0.80% | 1.60% | $6.21 | 62.1% |
| Coinbase Advanced (lowest found) | 0.60% | 1.20% | $4.66 | 46.6% |
| Coinbase Advanced (highest found) | 1.20% | 2.40% | $9.31 | 93.1% |

Sources disagree on the exact Kraken and Coinbase entry tiers — the ranges above are
the spread of what the 2026 comparison pages report, and no single one should be
trusted to a decimal. **The conclusion does not depend on which is right**: every
published figure puts the alternatives at 2.6×–12× Binance's rate, and at 40 round
trips that is the difference between losing 8% of the account to fees and losing
half of it.

At $1,000 of capital, a 12× fee difference is an annoyance. At $10 it is the
difference between a strategy that can compound and one that cannot. This is the
single strongest argument for Binance, and it dominates every other consideration.

**The BNB discount is not worth it here.** It saves 2.5 bps per side (about $0.005
per round trip) but requires holding BNB, whose minimum order is $5 — half the
account parked in a second volatile asset to save pennies. Decline it.

### Caveat: Uganda access

Binance is reported as available in Uganda (P2P via MTN MoMo; spot 0.1%), but
restriction reports conflict for the region. **Verify with one manual ~$6 order
before trusting the bot with live money** — the bot's own `paper` mode exercises the
same code path against real market data with no credentials, so the only unknown is
whether the account can actually place the order.

---

## 2. Asset: `BTCUSDT`

Measured over the same 35 daily bars (2026-10-17 → 2026-11-20), i.e. the drawdown
that is still in progress:

| Asset | 35-day return | max drawdown | annualised vol | worst day |
|---|---|---|---|---|
| **BTCUSDT** | **−24.2%** | **−26.5%** | **42.0%** | **−6.29%** |
| ETHUSDT | −27.2% | −29.2% | 56.1% | −8.69% |
| SOLUSDT | −30.3% | −34.3% | 58.0% | −10.67% |

The ranking is monotonic on all four measures: ETH ran **1.33×** BTC's realised
volatility and SOL **1.38×**. Daily turnover over the same window was roughly
$0.5–2.1B for BTC, $0.13–1.0B for ETH and $50–370M for SOL.

BTC wins on every axis that matters for an unattended $10 bot:

1. **Lowest volatility of the majors** — measured above, and nothing with a
   meaningful trend history is steadier. Lower vol means the 25% crash stop and the
   30% drawdown breaker fire less often.
2. **Deepest liquidity** — 3–10× the turnover of the alternatives, so a $9.70 market
   order has literally zero price impact.
3. **No delisting or survivorship risk.** The single largest hidden cost in any
   altcoin backtest is that the assets which blew up quietly vanish from the data.
   BTC has no such failure mode.
4. **Only asset with a validated edge.** The 3,383-candle backtest in
   `docs/BACKTEST.md` is BTC-only. Switching `SYMBOL` to anything else runs rules
   that were never measured on that asset — the parameter set (EMA200, ±0.5%
   hysteresis, 25% crash stop) is not transferable as a matter of faith.
5. **Sixteen years of continuous history** for re-validation, versus a few years for
   most alts.

### One real cost of choosing BTC at this size

BTC's lot step is `0.00001`, which at $61,783 is a **$0.62 increment**. A $9.70 order
sizes to 0.00015 BTC = **$9.27**, leaving **$0.43 (4.5%) idle** in USDT. ETH's step
is $0.175 at its current price, so it wastes only $0.07 (0.8%).

This is worth stating precisely because it is the one measure on which BTC is worse:
**a high unit price is mildly hostile to a tiny account.** The money is not lost —
`POSITION_FRACTION` is applied to free cash, so the next entry picks it up — and it
is already inside the backtester's fill model, so the +521% headline accounts for it.
It also shrinks proportionally as the account grows: at $97 of capital the same step
is 0.6%, not 4.5%. Do not optimise for it.

### What "least risky" honestly means

The genuinely least-risky thing to hold is **USDT** — and it earns nothing, so it is
not a candidate: this strategy needs a trend to exist, and a stablecoin pair has
none. Ranking the realistic options:

```
USDT (no return)  <  BTC  <  ETH  <  large-cap alts  <  small alts / memecoins
                  42% vol              56% vol          58%+ vol, delisting risk, −90% common
```

So BTC is the **least risky thing worth trading**, not a low-risk asset. At $10 the
dominant risks are not the asset at all:

1. **Strategy drawdown** — −57% observed on real history, and −26.5% already inside
   the current, unfinished one.
2. **Fee drag** — 7.8% of capital over 40 round trips even at Binance's rate.
3. **Custody** — the exchange holds the coins. This is uninsurable counterparty risk
   that no amount of backtesting addresses.
4. **Operational** — a paused cron or a paused database stops the bot silently. This
   is why `/api/health` exists.

Switching to a "safer" altcoin does not reduce any of these; it increases three of
them.

---

## 3. Rejected: MetaTrader 5 at this size

MT5 is a *platform*, not a venue — you still choose a broker. It is a reasonable target
eventually and a bad one at $10, for structural reasons rather than any failure
of MT5 itself.

**The minimum lot forces leverage.** Every broker's smallest order is 0.01 lots. On
EURUSD that is 1,000 units ≈ **$1,160 notional**, needing only ~$2.32 of margin at
1:500. On a $10 account that is **116× effective leverage**, and it is not optional —
you cannot trade smaller. The consequences, on the smallest position that exists:

| EURUSD move | P&L on 0.01 lot | as % of a $10 account |
|---|---|---|
| 0.3% | $3.48 | **34.8%** |
| 0.6% (a quiet day) | $6.96 | **69.6%** |
| 1.0% (an ordinary day) | $11.60 | **116% — account gone** |

Compare the spot bot, which is unlevered: a $9.27 position moving 2% (BTC's measured
daily vol) is 1.8% of the account. Spot cannot be liquidated because there is no
borrowing; MT5 at $10 will be, eventually, on a day that is not even unusual.

### What that does to the account, simulated

> Reproducible: `npm run venues` (`scripts/venues.ts`, seed 20260101, 20,000 paths). The
> original script behind these figures was never committed, so they are re-derived here —
> 89.0% dead at $10 against the 87.8% previously quoted, same median of $0.00, stress case
> 84.8% against 78% (the earlier stress run zeroed costs as well). Small differences are
> model detail, not disagreement about the conclusion.

20,000 paths, one year, same 56% market exposure for both systems. $10 start.
MT5 is modelled with a fixed 0.01 lot ($1,160 notional, so P&L does not scale down as
equity shrinks), $0.20 per round trip × 12/year, and declared dead once equity falls
below the $2.32 needed to open another 0.01 lot. FX drift set to zero, i.e. generously.
Crypto uses the measured +23.3% CAGR and 42% volatility (the earlier, more conservative
measurement — the re-measurement on authentic candles gave 30.0%, see `docs/BACKTEST.md`).

| | Crypto spot bot | MT5 at $10 |
|---|---|---|
| Median after 1 year | **$11.55** | **$0.00** |
| Mean after 1 year | **$11.76** | $9.57 |
| P(account dead in 1yr) | **0%** (spot cannot be liquidated) | **87.8%** |
| Median day of death | — | **day 11** |
| 25% dead by | — | **day 4** |
| P(doubled) | 0.3% | 11.7% |
| P(10×) | 0.0% | 3.3% |
| Typical daily swing | ±1.2% of equity | **±40% of equity** |

The result survives every assumption I could vary: at 6% annualised FX volatility
(about 40% below the measured proxy) and with **all trading costs set to zero**, MT5
still loses the account 78% of the time, with the same $0.00 median.

Note the mean is *below the $10 you started with* even though 3.3% of paths reach 10×.
That is what an absorbing barrier does: the rare winners are real, but the 88% of paths
that hit zero pay for them and then some. MT5 is not a faster version of the same
strategy — it is a lottery ticket with a small negative expected value.

**Why it fails so fast.** Trend following needs months to express an edge; this
strategy made 40 round trips over 8.7 years. At 116× leverage a move from $10 to the
$2.32 margin floor is a −77% change in equity, which is **less than one third of a
single daily standard deviation**. The account does not need bad luck, just an ordinary
week. The time scale of the strategy and the time scale of the leverage are
incompatible, and no amount of risk management fixes that — a stop-loss cannot act
faster than a gap.

### Where MT5 stops being a lottery ticket

The rejection above is about $10, not about MT5. The same model, swept over account size
(`npm run venues` again), says exactly where the constraint stops binding:

| Equity | Leverage | 1σ day, as % of account | P(dead in 1yr) | Median | |
|---|---|---|---|---|---|
| $10 | 116× | 73.1% | **89.5%** | $0.00 | a quiet day ends it |
| $50 | 23.2× | 14.6% | 55.6% | $0.00 | leverage decides |
| $100 | 11.6× | 7.3% | 24.9% | $96.21 | leverage decides |
| **$276** | **4.2×** | **2.6%** | **0.2%** | $275.47 | **risk per day matches the spot bot** |
| $500 | 2.3× | 1.5% | 0.0% | $498.73 | calmer than spot |
| $1,160 | 1.0× | 0.6% | 0.0% | $1,157.16 | unlevered |
| $5,000 | 0.2× | 0.1% | 0.0% | $5,000.04 | |

### The $100 question, answered properly

$100 is the first size where MT5 is not a guaranteed wipeout: ruin falls from 89.5% to **24.6%**,
and the median year is roughly flat ($96.81). That is a real change of category, and it is fair to
ask whether $100 makes MT5 work. Two measurements say no — but for different reasons than at $10.

| At **$100** | Crypto spot | MT5 (0.01 lot) |
|---|---|---|
| Median after 1 year | **$108.21** | $96.81 |
| Mean | **$112.91** | $99.45 |
| P(account dead) | **0.0%** | **24.6%** |
| Median day of death | — | day 145 |
| P(doubled) | 3.0% | 22.7% |
| P(10×) | 0.0% | 0.0% |
| P(+$365 in a year) — the goal | **0.0%** | **0.0%** |
| Worst path | $30.52 | **$0.00** |
| Account is gone on a EURUSD move of | n/a | **8.4%** |

**First reason: $1/day is unreachable with one lot, at any account size.** 0.01 lots is a fixed
$1,160 of notional, so a year of EURUSD movement — a *whole standard deviation* of it — is about
$87. Reaching +$365 needs a **31.5% move in EURUSD**, or 3.1σ of an entire year. That is not a
strategy problem, it is arithmetic: the position cannot get big enough to matter, and making it
bigger means adding lots, which puts the ruin risk straight back. Measured: P(+$365) with one lot
is **0.0%** at $100, $276, $1,000 — and only becomes real when the position scales with equity:

| Equity | Lots (min lots scale) | 1σ/day | P(+$365/yr) | P(dead) |
|---|---|---|---|---|
| $276 | 0.01 | 2.6% | 0.0% | 0.2% |
| $1,000 | 0.01 | 0.7% | 0.0% | 0.0% |
| **$3,650** | **0.03** | 0.6% | **14.6%** | 0.0% |
| $5,000 | 0.04 | 0.6% | 27.5% | 0.0% |
| $10,000 | 0.08 | 0.6% | 56.4% | 0.0% |

$3,650 is where $1/day becomes attemptable — within $34 of the $3,684 the crypto analysis
independently derived. Two different venues, two different models, the same answer, because the
goal is a **return-on-capital** problem and not a venue problem.

**Second reason: at $100 the ruin channel is still open.** The account dies on an 8.4% adverse
EURUSD move. Monthly FX volatility is ~2.9%, so that is about 2.9σ monthly, and roughly a
one-in-four chance over a year — which is exactly what the simulation reports (24.6%). That
probability is a property of the leverage, not of the strategy: no stop-loss changes it, because
the stop is the margin floor.

**$276 is the threshold.** Not because the strategy improves — it does not — but because at
that equity one ordinary EURUSD day costs 2.6% of the account, the same as the spot bot, and
the margin floor is no longer reachable by weather. Below $100 you are not trading an edge,
you are holding a levered bet with a 25–90% chance of ruin. Above ~$1,160 the position is
unlevered and MT5 is simply a calmer venue for the same trend rule.

So the path to a second venue is the same path as everything else in this repo: **grow the
account first**. At $276 the same 0.01 lot that destroys a $10 account becomes the correctly
sized position. Nothing else needs to change.

### If the goal is "10× your money in a month" instead

The natural response to all of the above is "then I'll use the venue with more leverage". MT5
does offer far more of it: a 1:500 broker lets a $10 account hold ~4 micro lots ($4,640
notional, 464× effective), with no 60-day ramp like Binance's. So it is worth asking which
venue actually gives the better odds of turning $10 into $300 within a month. Simulated,
60,000 paths, full compounding, FX drift set to zero:

| Venue | Effective leverage | P(reach $300) | P(wiped out) | Median |
|---|---|---|---|---|
| MT5, 1 micro lot | 116× | 0.00% | 76.5% | $0.00 |
| MT5, 2 micro lots | 232× | 0.01% | 85.5% | $0.00 |
| MT5, 4 micro lots (1:500 max) | 464× | **2.49%** | **89.5%** | $0.00 |
| **Binance BTC, 125× ceiling** | 125× | **8.90%** | 91.1% | $0.00 |

**MT5 is the worse vehicle for this, despite having 3.7× the leverage.** The reason is that
leverage multiplies an edge, and EURUSD majors have **essentially zero long-run drift** — so
there is nothing to multiply but variance. BTC, for all its faults, carries a measured
positive drift (+23.3%/yr), which is why the *less* leveraged venue wins on the number that
matters. A driftless asset plus leverage is a coin flip with fees attached.

**MT4 changes none of this.** It is the same instrument (EURUSD), the same ~zero drift and
the same 0.01-lot floor, so the odds are the same ~2.5% — the platform version was never the
variable. If anything MT4 is now the weaker choice: MetaQuotes has been retiring it, several
brokers no longer create **new** cent accounts on MT4 at all (a cent account is the one
feature that genuinely helps a small balance, by removing the forced 116× leverage), and some
remaining MT4 cent accounts set a **0.1-lot** minimum — ten times coarser than MT5's 0.01.

Both rows are still ~90% total loss, so this is a comparison of two bad bets, not a
recommendation of the better one. What the table does establish is that the platform choice
does not rescue the plan: no venue turns $10 into $300 a month reliably, and the one with the
biggest leverage numbers is the one that helps least.

**The cost per round trip is ~10× worse.** Standard/micro accounts — the only tier
that accepts a $10 deposit — quote spreads from 0.7–1.2 pips with no commission.
1 pip on a 0.01 lot is $0.10, so a round trip costs about **$0.20, or 2.0% of equity**,
against the spot bot's 0.2%. The cheap ECN tiers (0.1 pip + $3/round lot ≈ $0.04 total)
require $300+ minimum deposits, so they are not available at this size. The cost only
becomes comparable to spot around **$100 of equity**, and negligible around $1,000.

**There is no serverless option, so the infrastructure costs more than the account.**
An MT5 EA runs *inside the MetaTrader terminal*. There is no cron and no HTTP trigger;
the terminal must be running continuously, which means a Windows VPS at roughly
$10–15/month. On a $10 account the hosting bill exceeds any conceivable return by two
orders of magnitude, which makes the strategy structurally unprofitable before the
first trade. (The crypto bot's cron + free Postgres is $0, which is why $10 is viable
there at all.) On top of that, a trend strategy holds for weeks and pays overnight
swap/financing on the notional — a cost spot crypto does not have.

**If you want to pursue MT5 anyway,** the one thing that makes a small account workable
is a **cent account** (balance denominated in cents, so $10 = 1,000 cents and 0.01 lots
carries the risk of 0.0001 lots). Several brokers offer these with $5–$50 minimums. That
fixes the leverage problem but not the VPS problem.

**Running both** is technically fine — they are independent systems. But at $10 of
*combined* capital you cannot split it: $5 each fails BTC's $5 minimum notional and
leaves nothing for MT5 margin. Practical sequencing is crypto-spot now (costs nothing,
needs no VPS), MT5 later once capital makes the minimum lot and the hosting bill
proportionally small — realistically around **$1,000+**, which is also where the MT5
minimum deposit narratives stop being about $10 brokers.

## 4. What would change this answer

- **Capital above ~$1,000.** The BNB discount and maker-order strategies start to pay
  for themselves, and multi-asset diversification becomes possible.
- **A cheaper venue with a real order book and comparable fees.** Nothing found in
  2026 beats 0.10% for an entry-tier retail taker.
- **A validated backtest on another symbol.** `npm run backtest -- --symbol=ETHUSDT`
  is the honest test; until it is run and survives, ETH is a guess.

## Reproduction

The measurements are one-liners against the public API:

```bash
# filters, spread, sizing
curl 'https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT'
curl 'https://api.binance.com/api/v3/ticker/bookTicker?symbols=["BTCUSDT","ETHUSDT"]'
# the 35 closes used above
curl 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=35'
```

Then annualise the standard deviation of daily log returns by `√365`.
