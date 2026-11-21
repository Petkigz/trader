# Audit

_run 2026-11-20, against `arena/59968791-trader`. Everything below was checked against the code, not
against memory of the code. Where a claim could be tested, it is a test now._

## What was checked

| Area | How |
|---|---|
| Money paths (sizing, fees, fills, exits) | read `src/engine.ts`, `src/risk.ts`, `src/exchange/*`; exercised by `test/engine.test.ts`, `test/paper.test.ts` |
| Failure and recovery | read the tick's error path, `reconcilePosition`, `costBasisFromTrades`; new `test/health.test.ts` |
| Idempotency (double ticks, retries) | new tests in `test/engine.test.ts` |
| Credentials and exposure | `src/auth.ts`, `api/*.ts`, `vercel.json`, `.env.example` vs `src/config.ts` (test-enforced) |
| Persistence | `supabase/migrations/0001_init.sql` vs `src/store/supabase.ts` (columns cross-checked) |
| Secrets in the repo | pattern scan for tokens, JWTs, long hex; none found, `.env.example` only |
| Research claims | `npm run research`, `challenger`, `catchup`, `recover`, `growth` — all re-run |

## Fixed in this pass

### 1. `/api/health` reported a green bot that was broken — high

A tick that throws still writes `lastTickAt` and records an `error` tick. The health endpoint only
looked at the timestamp, so a bot failing twice a day, every day, returned **200 OK**. That defeats
the one thing the endpoint exists to do.

Now it reads the tick records: three consecutive failures is a 503 with `consecutiveErrors` and
`lastError` in the body. A single failed tick stays green (a network blip should not page anyone), and
a risk halt is reported as a *problem* but not as a failure — doing nothing on purpose is not an
outage. Six tests in `test/health.test.ts`.

### 2. A live API key with withdrawals enabled was never checked — high

`getApiRestrictions()` existed on both exchanges and **nothing called it**. A key that can withdraw
turns any bug in this repo into a theft, and the one gate designed to catch it was dead code.

Now, in live mode and only when about to place a buy, the engine asks. Withdrawals enabled → no
order, `killSwitch` latched in the store (so it survives the tick), and a safe key is required to
resume. Unknown answer (testnets, some regions) is a warning, not a block. Four tests.

### 3. `/api/backtest` was open to anyone in paper mode — medium-high

The endpoint downloads up to 15 years of candles and simulates them, with
`Access-Control-Allow-Origin: *`. In the default configuration (paper mode, no secrets) it was
completely unauthenticated, so a stranger could spend the function quota and the exchange's rate
limit — paper mode protects your money, not your bill.

Now closed by default. Set `DASHBOARD_TOKEN`/`CRON_SECRET`, or opt in with `PUBLIC_BACKTEST=true`.
The dev server sets that flag for localhost only, so the dashboard panel keeps working in
development and not in production.

### 4. `.env.example` had drifted from the code — medium

Seventeen settings the code reads were undocumented, including `FEE_RATE`, `TREND_EMA_PERIOD` and
the two added this week (`GOAL_DAILY_TARGET`, `MIN_NOTIONAL`). A config file that is a partial memory
of the config is how people run a different bot than they think.

All documented now, and `test/config-docs.test.ts` fails if the two ever diverge again — it scans
`loadConfig` for every key and requires it to appear in `.env.example`, and separately loads the
example file to prove the documented defaults actually start.

### 5. The docs described a stop that does not exist — medium

`StrategyInput.price` claimed to be "used for live exits". The trend strategy ignores it entirely:
the crash stop is armed on the **daily close**, never on an intraday price. That is a defensible
design (no wick stops, and two ticks on the same day cannot disagree), but it was documented as the
opposite.

The comment now says what the code does, two tests lock the behaviour, and `entryBuffer`/`exitBuffer`
are validated as ≥ 0 — with both non-negative, a single candle can never want both out and in, which
is what makes the second tick of a day a no-op rather than churn.

## Accepted, with the reason

| Finding | Why it stays |
|---|---|
| Crash stop ignores intraday price | A 25% close-based stop cannot be wicked out. The cost is real: a fast crash is not stopped until the daily close. Changing it needs a test on intraday data, not an opinion. |
| Commission paid in BNB is approximated 1:1 | Commented at the call site. It understates the fee by a few cents and never overstates it. Track BNB balance properly only if it ever stops being tiny. |
| Unknown cost basis falls back to current price | Understates the loss, so the risk rails see a smaller drawdown than reality. It logs every time. The alternative — inventing a basis — is worse. |
| Dashboard equity is the last tick's, not live | The page shows `lastTickAgeMinutes` next to it. Pricing the whole dashboard live would cost an API call per page view. |
| Dashboard token can be passed as `?key=` | Convenient for curl and for the static page. It can appear in logs; prefer the `Authorization` header if you care. |
| Two crons per day for a daily strategy | The 06:20 run is redundant by design and harmless (`test/engine.test.ts` proves the second tick cannot act twice). |
| `state.lastCandleCloseTime` is written but never read | Kept for diagnostics; the idempotency it was meant to provide comes from close-based signals plus the mutually exclusive entry/exit buffers. |

## Needs a human — cannot be verified from here

1. **Environment on Vercel.** `CRON_SECRET` must be set before live mode (the tick refuses
   unauthenticated requests in live), `DASHBOARD_TOKEN` if the numbers should not be public, and
   `PUBLIC_BACKTEST` left off.
2. **Run the migration.** `supabase/migrations/0001_init.sql` must have been applied; the store
   assumes `bot_acquire_lock()` exists and that `bot_state` is seeded with `id = 1`.
3. **Cron cadence vs strategy.** `vercel.json` runs twice a day. That suits `trend` (daily bars) and
   **cannot support `pullback`** (hourly bars) — on `STRATEGY=pullback` the bot would evaluate an
   hourly strategy twice a day and miss its own signals. Use an external scheduler at hourly cadence,
   or stay on `trend`. Vercel's free tier also caps cron frequency, which is why this is not just a
   config line.
4. **API key permissions** must be spot-trading-only. The engine now refuses to trade with
   withdrawals enabled, but the key should never have had them.
5. **Backups.** `trades` is the ledger of record; cost basis is rebuilt from it after a wipe. It has
   no retention policy and no backup configured.

## What I could not test here

- Real order placement against Binance: outbound network to exchanges is blocked in this sandbox, so
  the live path is covered by `FakeExchange` and by the paper exchange, not by a real fill.
- Supabase RLS with real keys: the SQL enables RLS with no policies and revokes `anon`/`authenticated`
  — read from the migration, not observed.
- Vercel cron behaviour, cold starts and the 60s function limit.

## How to re-run this audit

```bash
npx tsc --noEmit && npm test          # 210 tests
npm run deploy:check                  # deploy pre-flight: crons, bundles, config, schema
npm run research                      # headline grid, unchanged
npm run challenger -- --dir=data/real --replicate=data/realclass
npm run catchup -- --dir=data/real    # the sizing experiment
npm run recover -- --dir=data/real    # do losses get covered, and can the line be caught
npm run growth  -- --dir=data/real    # when growth actually arrives
```

A standing rule that came out of this pass: **every check that exists must be called by something,
and every claim in a comment must have a test or be deleted.** Two of the five fixes above were dead
code and stale prose, not missing features.
