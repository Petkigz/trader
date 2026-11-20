# Autopilot Trader

A crypto trading bot built for one specific, awkward brief: **run on $10, look after itself, and never need a human**.

Long-only spot. One position at a time. No leverage, no margin, no liquidation, no API keys required to start. Zero runtime dependencies, zero build step, runs on a serverless cron and a free Postgres.

```
$10  ──►  daily trend filter  ──►  buy / hold / sell  ──►  $62.12   (real BTC, 2017-2026)
```

---

## Read this first: what it can and cannot do

**It can run unattended indefinitely.** That claim is about *uptime*, and the architecture genuinely delivers it: stateless ticks, self-reconciliation against the exchange, atomic locking, circuit breakers that re-arm instead of dying.

**It cannot promise profit.** No bot can. What follows is the honest accounting, not a pitch.

### Measured on real BTC history

Run on 3,383 real daily BTCUSDT candles (trading window 2018-03-05 → 2026-11-20, 8.71 years, after the 200-day warm-up), starting with $10:

| | This bot | Buy & hold |
|---|---|---|
| Ended with | **$62.12** | $54.34 |
| Total return | **+521%** | +443% |
| CAGR | **+23.3%** | +21.5% |
| Max drawdown | **−57%** | −83% |
| Time in the market | 56% | 100% |
| Round trips | 40 | — |
| Win rate | 25% | — |
| Fees paid | $2.21 | — |

Read that win rate again: **it wins 1 trade in 4**. Trend following is supposed to look like that — a few large winners pay for many small losses. If a 25% win rate would make you turn the bot off during a losing streak, do not run it.

And notice the drawdown: **−57%**. The risk system caps *new* risk (it tripped 5 circuit breakers over that period) but it cannot protect an open position from a crash. On $10 that means watching it drop to ~$4.30 at some point. That is the real cost of the 23% CAGR.

### The uncomfortable math of $10

$10 is not a small account, it is a *structurally different* account, and three exchange rules dominate everything:

1. **Minimum order size.** Binance rejects spot orders under **$5 notional**. A $10 account can hold exactly one position. Forget grid bots and portfolio strategies — they mathematically cannot exist here.
2. **Lot-size quantisation.** BTC's smallest step is 0.00001 BTC ≈ **$0.62**. On a $9.70 order that is up to 6% of your position that cannot be deployed. The bot handles this by spending only what quantises cleanly and leaving the dust as cash — but it means you are usually ~96% invested, not 100%.
3. **Fees are a fixed tax on activity.** 0.1% per side means a round trip costs 0.2%. A strategy that trades 3× a week burns ~30% of the account per year in fees alone. This is the single biggest reason most retail bots lose money, and it is why this one trades **~4 times a year** instead.

Total profit over 8.7 years: **about $52**, or roughly **$6/year**. That is what $10 does. The bot is not the money — it is the machine. Point it at $1,000 and the same 23% CAGR is ~$230/year with the same code and the same risk controls.

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

**1. Database.** Create a Supabase project, then run `supabase/migrations/0001_init.sql` in the SQL editor. It creates three tables, an atomic lock function, and RLS with no policies (so only the service key can touch it).

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

**3. Done.** `vercel.json` schedules `/api/tick` daily at 00:20 UTC. Visit `/` for the dashboard, `/api/health` for a monitor-friendly liveness check.

> **Vercel Hobby only allows one cron per day.** That is exactly right for `trend`, which only looks at the daily close. For `pullback`, enable `.github/workflows/tick.yml` (30-minute cadence, free) — it is safe to run both, the lock de-duplicates them.

---

## Going live

Do it in stages. Each stage is one environment variable.

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

See [`docs/BACKTEST.md`](docs/BACKTEST.md) for full methodology, the parameter sensitivity sweep, and the trailing-stop experiment that I tested and rejected.
