# Autopilot Trader

A crypto trading bot built for one specific, awkward brief: **run on $10, look after itself, and never need a human**.

Long-only spot. One position at a time. No leverage, no margin, no liquidation, no API keys required to start. Zero runtime dependencies, zero build step, runs on a serverless cron and a free Postgres.

```
$10  ──►  daily trend filter  ──►  buy / hold / sell  ──►  $88.41   (real BTC, 2018-2026)
```

---

## Where the market is right now — 20 Nov 2026

Verified against live Binance data on the day this was written:

| | |
|---|---|
| BTC price | **$62,240** |
| All-time high | $124,659 (6 Oct 2025) |
| Down from ATH | **−50.1%** |
| Last 30 days | −26.0% |
| Last 12 months | −28.2% |
| 200-day EMA | $75,472 |
| Price vs EMA200 | **−17.5%** |

**If you deploy this today, it will sit in cash and do nothing.**

The bot moved to cash on **5 Nov 2026** at $76,088 and has not re-entered. It will buy again only when the daily close climbs back above **≈$75,849**. Until then every tick logs a hold and the equity line stays flat.

That is the strategy doing its job — it is a bear market and the bot is not buying into it. Over the last ~1.4 years of live-equivalent trading:

| | Bot | Buy & hold |
|---|---|---|
| Since Jun 2025 | **−1.2%** | **−41.1%** |
| Max drawdown | 18.4% | — |

Flat while BTC fell 41%. Whether that reads as success depends entirely on what you expected. **If you need to see activity to believe it is working, this strategy will frustrate you.** Doing nothing is the product.

---

## Read this first: what it can and cannot do

**It can run unattended indefinitely.** That claim is about *uptime*, and the architecture genuinely delivers it: stateless ticks, self-reconciliation against the exchange, atomic locking, circuit breakers that re-arm instead of dying.

**It cannot promise profit.** No bot can. What follows is the honest accounting, not a pitch.

### Measured on real BTC history

Run on 3,240 real daily BTCUSDT candles (2018-01-01 → 2026-11-14, 8.31 years), starting with $10. The candles in `data/btc_1d.csv` are rebuilt from Binance's own **1-minute** klines, so this run is reproducible offline and verifiable against public reference prices:

| | This bot | Buy & hold |
|---|---|---|
| Ended with | **$88.41** | $86.75 |
| Total return | **+784%** | +767% |
| CAGR | **+30.0%** | +29.4% |
| Max drawdown | **−61%** | −77% |
| Time in the market | 57% | 100% |
| Round trips | 33 | — |
| Win rate | 30% | — |
| Fees paid | $3.30 | — |

> **Revision, 20 Nov 2026.** An earlier version of this table reported $62.12 / +521% / −57% from a different candle pull. That pull came from an endpoint that returned prices inconsistent with the exchange's own ticker (`bookTicker` said 61,783 while the klines said 77k→61.8k). The figures above are measured on authentic minute-aggregated data. The headline went **up**, and the claim went **down**: the bot now barely beats buy-and-hold on return (+784% vs +767% instead of +521% vs +443%), and the real result is the drawdown — 61% instead of 77% while being in the market 57% of the time. That is the only thing here that survived a change of data source.

Read that win rate again: **it wins 1 trade in 4**. Trend following is supposed to look like that — a few large winners pay for many small losses. If a 25% win rate would make you turn the bot off during a losing streak, do not run it.

And notice the drawdown: **−57%**. The risk system caps *new* risk (it tripped 5 circuit breakers over that period) but it cannot protect an open position from a crash. On $10 that means watching it drop to ~$4.30 at some point. That is the real cost of the 23% CAGR.

### The uncomfortable math of $10

$10 is not a small account, it is a *structurally different* account, and three exchange rules dominate everything:

1. **Minimum order size.** Binance rejects spot orders under **$5 notional**. A $10 account can hold exactly one position. Forget grid bots and portfolio strategies — they mathematically cannot exist here.
2. **Lot-size quantisation.** BTC's smallest step is 0.00001 BTC ≈ **$0.62**. On a $9.70 order that is up to 6% of your position that cannot be deployed. The bot handles this by spending only what quantises cleanly and leaving the dust as cash — but it means you are usually ~96% invested, not 100%.
3. **Fees are a fixed tax on activity.** 0.1% per side means a round trip costs 0.2%. A strategy that trades 3× a week burns ~30% of the account per year in fees alone. This is the single biggest reason most retail bots lose money, and it is why this one trades **~4 times a year** instead.

Total profit over 8.7 years: **about $52**, or roughly **$6/year**. That is what $10 does. The bot is not the money — it is the machine. Point it at $1,000 and the same 23% CAGR is ~$230/year with the same code and the same risk controls.

Put per-day, the number is the one worth internalising before you deploy:

| Period | Expected return on $10 |
|---|---|
| Per year | $2.33 |
| Per month | $0.19 |
| Per week | $0.045 |
| **Per day** | **$0.0064 — two-thirds of a cent** |
| Per day *in market* | $0.011 |

**Do not read that as "it earns a fraction of a cent every day".** It does not. The bot is in cash 44% of the time and trades about 4 times a year, so the honest day-by-day answer is: **most days $0.00, in long unbroken stretches, then a jump of a few dollars when a trade closes.** There is no daily grind to watch, and any dashboard that suggests otherwise is noise. A single round trip costs $0.019 — about **3.4 days** of average return — which is why the strategy shops for four big moves a year instead of many small ones.

This is also why the bot can be genuinely unattended: there is nothing to react to on a day-to-day basis. If you find yourself checking it daily, you will be watching nothing happen, and that is the design working as intended.

### What capital would actually pay $10 a day

$10/day is $3,650/year. Divides out to:

| Assumed annual return | Capital required |
|---|---|
| **30.0%** (the re-measured backtest) | **$12,180** |
| 23.3% (the earlier, lower measurement) | $15,665 |
| 15% (edge weaker than history) | $24,333 |
| 10% | $36,500 |

The top row is the optimistic one — it assumes eight years of one asset's history repeat, in the best eight years crypto has had. Size from the 10–15% rows instead and treat 30% as the ceiling.

**$300/month is $10/day**, so it is the same table. $1/day is a tenth of it: **$1,200 at 30%, $1,545 at 23.3%**. Run the arithmetic for any target yourself:

```bash
npm run target                # $30/month, which is $1/day
npm run target -- --income=300
```

Read as a *rate*, the target at small capital is not demanding, it is arithmetically impossible — and the constraint is the same at every broker:

| Capital | Return needed for $300/month | vs the strategy's best year on record (+59.8%, 2021) |
|---|---|---|
| $10 | 36,000%/yr | **602×** |
| $100 | 3,600%/yr | **60×** |
| $1,000 | 360%/yr | **6×** |
| $3,636 | 99%/yr | 1.7× — needs its best year, every year |
| $12,180 | 30%/yr | within the measured range |

### When does it pay? The compounding schedule

```bash
npm run schedule                 # from $10, $100, $1,000
npm run schedule -- --start=100
```

The mechanism is exactly what it sounds like: the balance compounds, and income rises with the
balance, so the number does not stay at $300/month once the capital has grown. What is not
negotiable is the date. At the **realised** 9.9%/yr — the rate the rule actually delivered across
20 assets with costs, drawdowns and busts counted — income arrives at:

| Target | Balance needed | $10 start | $100 start | $1,000 start |
|---|---|---|---|---|
| **$1/day** | $3,636 | **62 years** | 38 years | 14 years |
| **$300/mo** | $36,364 | **87 years** | 62 years | 38 years |

At the single-asset backtest's 23.3%/yr those become 24 / 13 / 2 years for $1/day and 35 / 24 / 13
years for $300/month. At 30%/yr: 18 / 9 / 1 and 27 / 18 / 9.

### What "$1/day" looks like day by day

```bash
npm run daily                    # at $3,636, the capital $1/day needs at 9.9%
```

"$1/day" is an **average** — $360 a year. Measured on the real rule across 20 assets, 56,338 asset-days, at that capital:

| | |
|---|---|
| Days that produced exactly **$0.00** | **59.3%** |
| Days that gained $1 or more | 19.8% |
| Days that lost $1 or more | 20.7% |
| Median day | **$0.00** |
| 10th–90th percentile day | **−$84 to +$85** (±2.3% of equity) |
| Longest stretch with no change | **672 days** |
| Best / worst single day | +$14,105 (DOGE, +388%) / −$1,710 (LINK, −47%) |

So to average $1/day you have to sit through swings of roughly **85× the daily goal**, and three days in five pay nothing at all. It is four jumps a year with long silences between them, not a wage.

**If "$1 every calendar day" is the requirement rather than "$1/day on average", no capital and no setting delivers it** — a trend rule is in cash most of the time by design. Only an instrument that pays continuously can: a 4%/yr deposit yields $1/day on **$9,125**, with certainty and with no upside.

**Does a bigger balance earn a better rate?** Measured, over the same 6.3 years: $10 → $18.17
(1.82×, 9.9%/yr) and $100 → $185.00 (1.85×, 10.1%/yr). Ten times the capital produced ten times the
dollars and two-tenths of a point of rate. The only genuine scale effect is friction — a $5 minimum
order and a 0.2% fee cost a $10 account several points a year and a $10,000 account almost nothing —
and that is already inside the 9.9%. **Capital moves the date, not the rate.**

These figures assume the average return every year with no losing ones. The record has 19% losing
years, a −61% peak-to-trough drawdown, and 1 in 20 assets finishing below its start.

### Setting the target the bot reports against

```bash
GOAL_MONTHLY_TARGET=300     # $300/month; overrides GOAL_DAILY_TARGET
```

With that set, every `/api/status` and the dashboard show what the target actually costs — the
capital it needs at each *measured* rate, how far the account is, and how long its own achieved
rate would take to close the gap:

```
$300/month needs $15,451 at 23.3%/yr. You hold $10.00 (0.06% of the way),
which pays $0.01/day; at your achieved rate it takes 34 years.
```

That is a report, not a plan the bot can act on. Nothing on the trading path imports the goal
ledger — a test fails if the engine, strategy or risk rails ever do — so a deficit can never become
a reason to size up. Recovering a shortfall with bigger positions is a martingale, and `npm run
catchup` measures how fast that ends.

### How far it can be pushed

```bash
npm run ceiling
```

Kelly says the most leverage this edge could ever justify is **1.32×** (drift ÷ variance = 23.3% ÷ 0.42²). There is no leverage path in the code today — spot only, position fraction below 1 — so the reachable maximum is the unlevered edge itself:

| Leverage | Median year | P(margin call) |
|---|---|---|
| 1.0× | +16% | 0.0% |
| **1.3×** (Kelly) | +21% | 0.1% |
| 3× | +53% | 11.5% |
| 5× | +68% | 31.1% |
| 10× | **−100%** | 57.4% |

Past ~5× the *median* path is a wiped account even though the mean looks spectacular — leverage fattens the right tail faster than it lifts the typical outcome. A 10× account that survives makes a fortune; more than half of them do not survive.

So "pushing it to the maximum" means **~31%/yr at Kelly-optimal leverage, not 3,650%**. The requirement of 36.5×/yr has precedent in **0.32%** of 55,358 rolling asset-years — essentially one bull run, in 2020-21, on assets you would have had to pick in advance.

The largest single month any of the 20 assets has ever had is **+1,074%** (DOGE), which is why the target *feels* reachable — as a one-off event it is not impossible. As a rate sustained every month it is 3,600% a year, and the best the strategy has ever done across 20 assets is 59.8%.

**There is no capital level at which this pays $10 every day.** At $15,665 what you actually get, over one year:

| Outcome | One year | Per day |
|---|---|---|
| 5th percentile (bad year) | **−$2,561** | −$7.02 |
| 25th percentile | +$821 | +$2.25 |
| Median | +$3,663 | +$10.04 |
| 75th percentile | +$6,966 | +$19.08 |
| 95th percentile (good year) | +$12,793 | +$35.05 |

Two things follow, and both are awkward:

- **You lose money in ~19% of years, regardless of capital.** More capital does not make a losing year less likely — it makes it bigger.
- At $15,665 the yearly standard deviation (≈$3,681) is **as large as the expected gain** (≈$3,650), so it takes about **4 years** before the result is statistically distinguishable from luck. Anyone reporting a 12-month track record on this strategy is reporting noise.

So the honest framing: $15,665 of this strategy is roughly a $3,650/year income with a ±$3,700 annual swing, delivered in a handful of lumps, with a one-in-five chance of a negative year. That is an investment, not a salary — do not build a budget on it.

### Why there is no "aggressive mode" that fixes this

The obvious request is a version that trades harder and makes real money on $10. It does not
exist, and it is worth writing down why so the repo cannot be misread.

To earn **$1/day on $10 is 10% per day.** Compounded, that is $174 in a month, $53,130 in
ninety days and $1.3×10¹⁶ in a year. The best track record in the history of investing —
Renaissance Medallion, ~66%/year — is **0.14% per day**. Ten percent a day is roughly **72×
that**, sustained, by a $10 account on a public exchange. Nothing about venue, strategy or
leverage changes the arithmetic; a system that could do it would not need to sell itself.

MT5 is not implemented as a venue, and that is a measurement rather than an omission — see
[`docs/ASSET.md`](docs/ASSET.md) §3, reproducible with `npm run venues`. At $10 the smallest
order that exists (0.01 lots ≈ $1,160 notional) leaves an account 116× levered with an 89%
chance of ruin within a year. At $100 ruin falls to **24.6%** and the median year is flat, so $100
is the first size that is not a guaranteed wipeout — but the goal is still arithmetic away: one lot
can move about $87 in a year, so +$365 needs a 31.5% EURUSD move. MT5 is sane at **$276** and
$1/day becomes attemptable at **$3,650**, where the position scales (0.03 lots) — but none of that
matters until there is an edge: on the seven currency series in `data/realclass`, the bot's own rule
earns **+1.02%/yr** median over full history and **−1.43%/yr** over the last 30%, with 0/7 currencies
positive in the recent sample (`npm run fx:edge`). A second venue is a research problem first.

What leverage *does* buy is bigger daily numbers. On a $10 MT5 account at the minimum
0.01 lot, **40% of days gain more than $1** — against ~0% for this bot, whose daily swing is
12 cents. That is a genuine advantage on that one metric, and it is exactly why the pitch is
tempting. It comes with **40% of days losing more than $1**, 10% losing more than $5, and a
median one-year outcome of **$0.00** (see [`docs/ASSET.md`](docs/ASSET.md) §3). Big days are
volatility. Daily income is edge. Leverage converts the first into more of itself and turns
the second into a coin flip that eventually loses.

The binding constraint is capital, not the platform. $1/day needs **$1,567** at the measured
23.3%, or **$3,650** at a more conservative 10%. Ten dollars is 150–365× short of that, and
no configuration of any bot closes a gap of that shape. What closes it is contributions:

| Saved per month | Time to $1/day | You contributed | The bot earned |
|---|---|---|---|
| $10 | 6.2 years | $760 (48%) | $812 (52%) |
| $20 | 4.2 years | $1,010 (63%) | $597 (37%) |
| $50 | 2.1 years | $1,260 (80%) | $309 (20%) |
| $100 | 1.2 years | $1,410 (89%) | $175 (11%) |

Savings do the work early; compounding does it late. Any plan that promises the reverse is
selling something.

### The fee floor caps how often any $10 bot can trade

There is a second, harder barrier to "daily income" that has nothing to do with skill. At
0.1% per side, every round trip costs 0.2% of the position. Multiply by how often you trade:

| Trades per year | Annual fee drag | Gross return needed to net 10%/yr |
|---|---|---|
| ~4.6 (this bot) | 0.9% | 10.9% |
| 12 (monthly) | 2.4% | 12.4% |
| 52 (weekly) | 10.4% | 20.4% |
| **365 (daily)** | **73.0%** | **83.0%** |

A daily-trading bot on Binance does not need to be clever — it needs to beat a **73%/year
headwind from fees alone**, before it earns a single cent. On smaller or worse venues the
figure is several times higher. This is why the strategy here trades ~4.6 times a year and
waits in cash 44% of the time: it is not timidity, it is the only frequency band where costs
do not swamp the edge. **Any "daily income" method has to clear this table first,** and at $10
that table is the binding constraint long before the strategy is.

### What would actually break it

- The exchange delisting the pair, or exiting your country
- Binance changing its API or minimums (the adapter would need a small update)
- You giving the API key withdrawal permission and the key leaking
- Parameters re-tuned to look good on a backtest (overfitting is the real risk here, not bugs)

---

## How it works

```
                    ┌──────────────────────────────────────────────┐
   Vercel cron ────►│  POST /api/tick                              │
   (or GitHub       │                                              │
    Actions)        │  1. acquire Postgres lock   ─┐               │
                    │  2. load state               │               │
                    │  3. read exchange balance    │  idempotent   │
                    │  4. reconcile position       │  stateless    │
                    │  5. refresh risk bookkeeping │               │
                    │  6. fetch closed candles     │               │
                    │  7. evaluate strategy        │               │
                    │  8. market buy / sell        │               │
                    │  9. persist + log           ─┘               │
                    │ 10. release lock                             │
                    └───────┬──────────────────────┬───────────────┘
                            │                      │
                   ┌────────▼────────┐    ┌────────▼─────────┐
                   │ Supabase        │    │ Binance / paper  │
                   │ state + ledger  │    │ exchange         │
                   └────────┬────────┘    └──────────────────┘
                            │
                   ┌────────▼────────┐
                   │ /api/status     │──► dashboard, /api/health,
                   │ read-only       │    Telegram alerts,
                   └─────────────────┘
```

Every tick is a complete, self-contained decision. There is no long-running process, no in-memory state to corrupt, no queue to drain. **If a tick crashes halfway, the next one repairs everything by reading the real balance from the exchange.**

### The five properties that make "unattended" true

1. **The exchange is the source of truth.** The position is derived from the actual account balance, not from a local flag. Wipe the database and the bot rebuilds its cost basis from the trade ledger and carries on.
2. **Idempotent by construction.** Signals are functions of *closed* candles. Running twice for the same candle produces a hold, not a second order.
3. **Atomic lock.** A single Postgres row decides who runs. Two schedulers firing at once → the second one is a no-op. A crashed tick self-releases after 180 seconds via TTL.
4. **Degrade, don't die.** Every risk limit *pauses* the bot for a period and then re-arms. A circuit breaker that permanently disables the bot would break the core requirement.
5. **Exits are never blocked.** Risk controls only prevent *new* risk. If you flip the kill switch, the bot still manages its way out of any open position.

---

## The strategy

Two long-only strategies ship. `trend` is the default because it is the one that survives unattended for years.

### `trend` — the default

> Be long while BTC's daily close is above its 200-day EMA. Otherwise hold cash.

- **Entry:** daily close > EMA200 × 1.005
- **Exit:** daily close < EMA200 × 0.995 (the 0.5% band on each side is hysteresis — it stops whipsawing around the line)
- **Catastrophic stop:** exit if price falls 25% below entry, whatever the EMA says
- **Frequency:** ~4 round trips per year

This is the oldest, most durable anomaly in markets: trend persistence. It is boring on purpose. Boring is what compounds when nobody is watching.

### `pullback` — optional, higher frequency

> Buy short-term oversold dips, but only while the daily trend is up.

- **Entry:** daily close > EMA200 **and** 1-hour RSI(14) < 30
- **Exit:** take profit at max(2%, 1.0 × ATR), stop at max(3%, 1.5 × ATR), or 72-hour time exit
- **Frequency:** several trades per month

Faster and more engaging, but far more exposed to fees and whipsaw. **It is not validated on real data in this release** — backtest it yourself with the command below before trusting it.

*Switch with `STRATEGY=pullback`.*

### Why long-only spot, forever

A spot position can never be liquidated. The worst case is that you own an asset worth less than you paid — you never get a margin call, never get force-sold at the bottom, never owe money. That single property is what makes "runs indefinitely without me" a claim someone can actually stand behind.

---

## Risk system

| Limit | Default | What happens |
|---|---|---|
| Max drawdown | 30% below peak | Pause entries `HALT_DAYS`, **re-base the peak**, resume at normal size |
| Max daily loss | 8% | Pause until 00:00 UTC |
| Consecutive losses | 5 | Pause `HALT_DAYS` |
| Position size | 97% of cash | One position, no pyramiding |
| Kill switch | `KILL_SWITCH=true` | Block entries, still allow exits |

The re-basing detail matters. A naive drawdown breaker permanently disables the bot the first time it trips, which fails the brief. This one stands down for a week, forgets the old peak, and starts again.

**Position size is your main risk dial.** At 97% you get the numbers above. At `POSITION_FRACTION=0.5` you roughly halve both the return and the −57% drawdown. If a 57% drawdown would make you intervene, lower it before you start.

---

## Quick start (no keys, no risk)

```bash
npm install          # only dev dependencies (TypeScript types)
npm test             # 90 tests
npm run tick         # one paper tick against live prices
npm run status       # what happened
node scripts/dev-server.ts   # dashboard on http://localhost:3000
```

Paper mode uses **real** Binance prices and real fees and slippage — it is a forward test, not a simulation. Let it run for a week and you will see exactly what live would have done.

```bash
npm run backtest                                   # 8 years of BTC, real data
npm run backtest -- --strategy=pullback --years=2
npm run backtest -- --synthetic                    # offline, deterministic
```

---

## Deploy (Vercel + Supabase)

The bot is designed for a free tier: one daily cron and one Postgres row.

**1. Database.** Create a **new, empty** Supabase project, then run `supabase/migrations/0001_init.sql` in the SQL editor. It creates three tables (`bot_state`, `trades`, `ticks`), an atomic lock function, and RLS with no policies (so only the service key can touch it).

The bot needs nothing else — candles come from the exchange API at tick time, and price history is not stored. (The SQL cross-check in `docs/BACKTEST.md` used a throwaway `market_daily` table to replay candles inside Postgres; it is not part of the schema and is not required to run.)

> **Use a dedicated project. Never run this against your app's database.**
> The migration writes to `public.` and inserts a row into `supabase_migrations.schema_migrations`. Dropped into a live project it will sit next to your real tables, share the 500 MB database / 5 GB egress quota, and show up in your migration history alongside production schema changes. Rollback means dropping bot-owned objects by name, which is exactly the kind of surgical cleanup nobody wants to do on a Friday.
>
> The free tier allows **2 projects** — spend one on the bot. If you must share a project, first rewrite every identifier in the migration to a dedicated schema (e.g. `autopilot.bot_state`) and set `search_path` accordingly; the file as shipped is not schema-agnostic. Then re-point the `Store` at that schema. Sharing `public` is not a supported configuration.

> **Free-tier pause — the biggest operational risk in this design.** Supabase pauses free projects after **7 consecutive days with no database activity**, and a paused project stays dark until you manually restore it. In normal operation the daily tick *is* the keep-alive, so this is safe. But if ticks start failing for a week, the project pauses and everything stops silently. Point a free uptime monitor at `/api/health` — it reads the database, so it keeps the project awake *and* alerts you when a tick is overdue. Do this.

**2. Vercel.** Import this repo, framework preset **Other**, no build command. Then set these environment variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (server-side only) |
| `CRON_SECRET` | any long random string |
| `DASHBOARD_TOKEN` | any long random string |
| `BOT_MODE` | `paper` |
| `SYMBOL` | `BTCUSDT` |
| `STRATEGY` | `trend` |

**2a. Pre-flight.** Run this before the first deploy, and after any change to
`vercel.json`, `api/`, or the migration:

```bash
npm run deploy:check
```

It verifies, offline: every cron path has a handler and no schedule is sub-daily (Hobby rejects
those at deploy time); every relative import in `api/` and `src/` resolves; each handler **bundles**
with esbuild and `/api/health` actually executes; the config loads with an empty environment, refuses
live without keys, and warns if live has no `CRON_SECRET`; `.env.example` still documents every
setting; and the migration contains the tables, lock function, RLS and seed row. `FAIL` exits
non-zero. It prints `deployable: 0 failure(s), 3 warning(s)` when the repo is sound.

What it cannot check, and does not pretend to: that the migration has been applied to *your* project,
that the exchange is reachable from your deployment, and that a cron actually fired.

**3. Done.** `vercel.json` registers two cron entries for `/api/tick`, at 00:20 and 06:20 UTC. Visit `/` for the dashboard, `/api/health` for a monitor-friendly liveness check.

Three Vercel behaviours that matter here, all verified for 2026:

- **Hobby crons run at most once per day**, 2 jobs per project maximum. Sub-daily expressions are *rejected at deploy time* rather than silently ignored.
- **Crons only fire on production deployments.** Deploying a branch as a preview will never tick.
- **There are no retries.** A failed run is never re-run — which is the entire reason there are two cron entries. The second is a free retry: ticks are idempotent and the Postgres lock de-duplicates, so a second run against the same daily candle is a guaranteed no-op. Hobby also fires *somewhere inside the scheduled hour*, so never assume 00:20 exactly.

For `pullback`, which needs sub-daily ticks, enable `.github/workflows/tick.yml` (free, 30-minute cadence). Running both schedulers is safe and is the recommended self-healing setup.

---

## Going live

Do it in stages. Each stage is one environment variable.

Why this design picks **Binance spot** and **BTCUSDT** over everything else — with live fee, spread, volatility and lot-step measurements behind it, and the conditions that would change the answer — is in [`docs/ASSET.md`](docs/ASSET.md).

### Check exchange access before you build the habit

Binance lists Uganda as a supported country and it is widely used there, but reports about regional access restrictions conflict and country rules change without notice. **Verify in-account before trusting the bot: log in, complete verification, and manually place one ~$6 BTCUSDT order.** If that works end-to-end, so will the bot.

USDT is usually acquired in Uganda through Binance **P2P** (0% Binance fee, MTN Mobile Money / Airtel), then traded against BTC on spot. P2P carries its own 0.5–2% spread from the counterparty — that is a one-time funding cost, not a trading cost.

If Binance is not usable for you, the `Exchange` interface means a different venue is roughly a 150-line adapter and nothing else in the engine changes.

**Stage 1 — paper (default).** Free, no keys, no risk.

**Stage 2 — testnet.** Create a key at [testnet.binance.vision](https://testnet.binance.vision), then set:
```
BOT_MODE=live
BINANCE_BASE_URL=https://testnet.binance.vision
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
```
This exercises the real signed-order code path with worthless money. Let it trade at least once.

**Stage 3 — live.** On your real Binance key, grant **only** "Enable Spot & Margin Trading". **Never** enable withdrawals — the bot has no use for them. The engine actively refuses to trade if it detects a withdrawal-enabled key (`/sapi/v1/account/apiRestrictions`).

```
BOT_MODE=live
BINANCE_BASE_URL=https://api.binance.com
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
```

Fund with $10, leave it alone.

---

## Configuration

Everything is optional — the defaults are the researched ones.

| Variable | Default | Notes |
|---|---|---|
| `BOT_MODE` | `paper` | `paper` or `live` |
| `SYMBOL` | `BTCUSDT` | any Binance spot pair |
| `STRATEGY` | `trend` | `trend` or `pullback` |
| `POSITION_FRACTION` | `0.97` | **main risk dial**, 0–1 |
| `MAX_DRAWDOWN` | `0.30` | circuit breaker threshold |
| `MAX_DAILY_LOSS` | `0.08` | per-UTC-day stop |
| `MAX_CONSECUTIVE_LOSSES` | `5` | losing-streak stop |
| `HALT_DAYS` | `7` | cool-off length |
| `COOLDOWN_HOURS` | `4` | pause after each exit |
| `TREND_EMA_PERIOD` | `200` | |
| `TREND_CRASH_STOP` | `0.25` | catastrophic stop |
| `FEE_RATE` | `0.001` | used by the paper simulator |
| `SLIPPAGE_BPS` | `2` | used by the paper simulator |
| `PAPER_START_USDT` | `10` | paper starting balance |
| `KILL_SWITCH` | `false` | block entries immediately |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | optional trade notifications |
| `CRON_SECRET` | — | required for `live` mode |

See `.env.example` for the annotated version.

---

## Operating it

You should not need this section. That is the point. If you do:

```bash
npm run status                 # equity, position, PnL, recent trades
npm run lock -- on             # block new entries (exits still allowed)
npm run lock -- off            # resume
npm run lock -- flatten        # sell everything now, go to cash
npm run lock -- status         # show flags
```

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` returns 503 | no tick in 3 days | check the Vercel cron ran; re-run the deploy |
| `entries blocked: halted` | circuit breaker or daily stop | wait, it re-arms itself |
| `below_min_notional` in logs | equity too small to open a position | expected on $10 after a drawdown; it resumes above ~$5.20 |
| Ticks log `locked` | another scheduler holds the lock | harmless, it is working as designed |
| `stale_data` | exchange returned old candles | transient, next tick fixes it |

**Set up Telegram.** It costs one BotFather message and turns "check the dashboard" into "the bot tells me when something happened". For an unattended bot, that is the difference between trusting it and babysitting it.

---

## Testing

```bash
npm test          # 90 tests: indicators, strategy, risk, engine, fills, ledger
npm run typecheck # strict TypeScript, no emit
```

The tests that matter most are in `test/engine.test.ts`: they prove a tick is idempotent, that a crashed tick releases its lock, that a position missing from the database is recovered from the exchange balance, and that stale market data is refused.

---

## Layout

```
api/              Vercel functions: tick, status, health, backtest
src/
  engine.ts       the tick lifecycle — read this first
  strategy.ts     pure signal functions (trend, pullback)
  risk.ts         pure risk functions (breakers, sizing)
  backtest.ts     walk-forward simulator, reuses strategy+risk
  exchange/       binance adapter, paper simulator, interface
  store/          supabase + memory implementations
  cli/            tick, status, halt, backtest
public/           dashboard (single file, no dependencies)
supabase/         schema + lock function
test/             90 tests
```

---

## Honest limitations

- **One asset, one position.** All eggs in one basket, by arithmetic necessity at $10.
- **Daily granularity.** The bot reacts to closes. A 20% intraday crash is seen after the fact.
- **Single exchange.** Binance only. The `Exchange` interface makes another venue a ~150-line file, but no other adapter is shipped or tested.
- **The backtest is one asset over one period**, and that period contained a historic bull run. Do not extrapolate +23% CAGR to the next decade.
- **The pullback strategy is unvalidated** on real data.
- **A paper-mode dashboard is not evidence of profit.** It is evidence the machinery works.
- This is not financial advice and there is no guarantee of profit. Trade money you can afford to lose entirely.

## Verified against live sources

Checked on **20 November 2026**:

| Claim | How it was checked | Result |
|---|---|---|
| Spot fee 0.1%, 0.075% in BNB (VIP 0) | Binance fee schedule | current → matches `FEE_RATE` |
| BTCUSDT minimum notional $5.00 | live `/api/v3/exchangeInfo` | exact |
| BTCUSDT lot step 0.00001, tick 0.01 | live `/api/v3/exchangeInfo` | exact |
| BTC history through 20 Nov 2026 | live `/api/v3/klines`, 3,383 candles | current |
| Vercel Hobby: 1 cron/day, 2 jobs, production-only, no retries | Vercel docs | current |
| Supabase free tier pauses after 7 days idle | Supabase docs | current |

One thing worth knowing: the bot reads **minimum notional, lot step, min quantity and tick size from the exchange at runtime**, every tick. If Binance changes those, the bot adapts without a code change — only a change to the *fee schedule* needs a config edit (`FEE_RATE`). Re-check fees before going live.

See [`docs/BACKTEST.md`](docs/BACKTEST.md) for full methodology, the parameter sensitivity sweep, and the trailing-stop experiment that I tested and rejected.

### What the safety rails actually do

```bash
BACKTEST_TRADE_LOG=1000 npm run backtest -- --csv=data/btc_1d.csv
```

The bot trades **4 times a year** (0.011/day), loses 23 trades in 33, averages a −4.6% loser and a
+57% winner, and its longest losing streak was 5 — about −27% of the account, which it survives
because it is spot and unlevered. Switching each safety rail off across 20 assets changes nothing
measurably (every |t| < 1.7); two of them never fired in seven years. They are insurance against
intraday gaps the daily backtest cannot see, not the thing earning the returns. See
[`docs/RISK.md`](docs/RISK.md).

### Tested across 20 assets, not just BTC

```bash
npm run xsection -- --dir=data/real --start=2020-01-01
npm run xsmom -- --dir=data/real
```

A single asset gives 33 trades in eight years, which cannot separate an edge from luck. So the
same code runs against a panel of **20 real assets** (`data/real/`, rebuilt from Binance minute
data), with a pre-registered 50-configuration grid and an in-sample/out-of-sample split.

What it found: the ensemble adds **nothing** (Sharpe better on 7/20, t = −0.01); cross-sectional
rotation loses out of sample (median −3.0%/yr, 0/50 configs beat holding BTC); and the one thing
that holds up in both halves of the sample, on one asset and on twenty, is the oldest rule in the
repo — **be long while the trend is intact, be in cash when it is broken**, which has no fitted
parameters. Drawdown improves in all seven windows tested.

See [`docs/CROSSSECTION.md`](docs/CROSSSECTION.md) for the tables and the five bugs the panel
caught.

Then the same rule was tested where decades of independent history exist — 26 equity, bond, FX and
commodity futures back to 1972 ([`docs/ASSETCLASS.md`](docs/ASSETCLASS.md)). The verdict darkened:
**drawdown improves in 22 of 26 out of sample, but risk-adjusted return does not improve (8/26,
t = −2.45)**. The gate is insurance, not alpha — and the crypto result that looked like alpha was
one cycle.

### Is it safe to leave alone?

[`docs/AUDIT.md`](docs/AUDIT.md) is a pass over the money paths, failure handling, credentials and
persistence, with what was found and what was fixed. Two findings are worth knowing before deploying:
`/api/backtest` is closed by default (opt in with `PUBLIC_BACKTEST`), and a live API key with
withdrawals enabled now latches the kill switch instead of trading.

### The goal line, and what it is allowed to change

```bash
npm run catchup -- --dir=data/real
```

```bash
npm run recover -- --dir=data/real
```

Growth arrives in bursts: the median asset gains its entire net return in **4 days out of ~2,300**,
and the longest wait between new highs was nearly four years — it is flat 61% of days by design.
Losses still get covered by ordinary trading: 88% of 5%+ drawdowns were recovered, median 6 days. What
does *not* work is catching up by size — below "escape velocity" (~$1,400 at 30%/yr) a $1/day line
advances faster than the account can, so the gap widens no matter how the positions are sized.

The bot reports where the account stands against +$1/day: deficit, today's P&L, how long the gap
takes to close at the rate actually achieved — and how many dollars it needs to regain its previous
peak (a $15 → $3 account is told it needs $12, which is a 400% climb, not an errand). If the balance
falls below the exchange minimum it says so plainly instead of idling quietly. The ledger may change what it *reports*; it is
never allowed to change how much it *risks* — `plannedRiskMultiplier` returns 1 by construction and
a test enforces it. The experiment that justifies that rule is in
[`docs/GOAL.md`](docs/GOAL.md): sizing up to recover a deficit left the median unchanged and
quadrupled the number of ruined accounts.

### What it cannot currently see

```bash
npm run context -- --dir=data/real
```

Beta to BTC (1.18), correlation (0.69), and the spread between up-market and down-market days
(+0.44% vs −0.37%) are all real, and all invisible to a bot that reads one symbol. Measured as
trading filters they fail: the symbol's trend already agrees with the market 72% of the time, so a
market gate re-tests what the entry rule knows. Volume is the one gap not yet given a fair trial: the offline panel has no column for it, so the
question was asked with a range-expansion proxy, which lost. `npm run fetch:volume -- --write` adds
real volume without touching a price, and the gate then tests itself for real.
See [`docs/INTELLIGENCE.md`](docs/INTELLIGENCE.md) §2a.

### Learning, if it is ever allowed to happen

```bash
npm run challenger -- --dir=data/real --replicate=data/realclass
```

Candidates run in shadow against their own ledger and can only take over by clearing a rule fixed
in advance: a sample floor, a multiplicity bar that rises with every attempt ever tried, per-asset
consistency, and replication outside crypto. Three challengers have been tried; **none survived** —
the best one cleared every crypto gate and was withdrawn for making things worse on 31 non-crypto
futures markets. See [`docs/LEARNING.md`](docs/LEARNING.md).

### The ensemble: regime switching

```bash
STRATEGY=ensemble npm run backtest -- --csv=data/btc_1d.csv
```

Classifies the market's volatility and directionality, then lets a trend follower and a
mean-reversion family compete for control, with cash forced during a volatility storm. The trade
is owned by one family at a time — letting both families vote on exits turned it into a 193-trade
churn that lost 42% to fees.

**It did not survive real data.** Across six spans of authentic candles it lowers drawdown in
6 of 6 and improves Sharpe in 4 of 6, but the mean Sharpe gain is +0.02 with **t ≈ 0.7** —
indistinguishable from luck — and the best window on synthetic data turned out to be nearly the
worst on real data. Off by default, and it should stay that way. The measurements, the sweep and
the reasoning are in [`docs/ENSEMBLE.md`](docs/ENSEMBLE.md).

### Adaptive sizing

The bot can change its own exposure in response to market state — volatility targeting, on by
default only when you ask for it:

```bash
ADAPTIVE_SIZING=1 npm run backtest -- --years=8     # compare against the static run
ADAPTIVE_SIZING=1 TARGET_VOL=0.3 STORM_SCALE=0.5 npm run tick
```

It measures recent volatility and scales the position against it, so exposure shrinks exactly
when the market gets violent. Deliberately one-sided: `ADAPTIVE_MAX_SCALE` defaults to 1, so it
can reduce risk but never enlarge a position beyond the configured fraction. It changes *how
much* is committed, never the entry or exit rules. Measured behaviour and its limits are in
[`docs/ADAPTIVE.md`](docs/ADAPTIVE.md).

### Searching for a better strategy

```bash
npm run research                    # walk-forward validation, 8 years
npm run research -- --is=500 --oos=250
npm run research -- --synthetic     # offline, deterministic
```

Parameters are chosen on one window and scored on the next unseen one. Every candidate tested
is counted, and the report prints the **luck floor** — the score 15 attempts would reach by
chance alone. A winner that cannot beat its own luck floor out of sample has been fitted, not
found, and the harness says so. See [`docs/INTELLIGENCE.md`](docs/INTELLIGENCE.md) for why the
bot updates its market facts automatically but never rewrites its own strategy.
