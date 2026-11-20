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

## 3. What would change this answer

- **Capital above ~$2,000.** The BNB discount and maker-order strategies start to pay
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
