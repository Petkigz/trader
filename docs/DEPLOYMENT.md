# Deployment state — 21 Nov 2026

What exists, what is blocked, and the exact steps to finish. Kept in the repo so
this survives past the conversation that produced it.

## Done

**Supabase — `trader-paper`, project ref `cjhatumykdqlmihacopb`, eu-west-1, free plan.**

A dedicated project, not the shared `platform` database — the migration writes to
`public.` and would otherwise sit next to an app's real tables (see the warning in
the README).

- `0001_init.sql` applied as migration `init_trader_schema`
- verified after apply: `bot_state` (21 columns), `trades` (13), `ticks` (12);
  RLS enabled on all three; `bot_acquire_lock` present; the singleton seed row inserted
- `SUPABASE_URL` = `https://cjhatumykdqlmihacopb.supabase.co`
- the `service_role` key is in the Vercel env list below and in `.env` (gitignored)

**Local dashboard — running, paper mode, target 5%/day.** `GET /api/status` returns
`dailyRate: 0.05` and `rateAnnualised ≈ 5.49e7`. The dashboard renders the target in the
goal card: `5.0%/day target · behind $…`.

## Blocked

**Vercel project creation is refused for this connection.** Both attempts — user
scope and the default team `team_u4IS930bE1RJNIBGzLQBh5zT` — returned *Access
denied*, and the authenticated user reports `"limited": true`. Reads work (projects
list, user, deployments); writes that create resources do not. The Vercel project does
not exist, so there is nothing to deploy to and no deployment to inspect.

This needs a human: reconnect Vercel in Arena with a token that can create projects,
or create a project named `trader-paper` (framework preset **Other**, no build
command, connected to `Petkigz/trader`) and the remaining steps are mine.

## Remaining steps once a project exists

1. Set these environment variables on the project (production):

   | Variable | Value |
   |---|---|
   | `BOT_MODE` | `paper` |
   | `SYMBOL` | `BTCUSDT` |
   | `STRATEGY` | `trend` |
   | `PAPER_START_USDT` | `10` |
   | `GOAL_DAILY_RATE` | `0.05` — 5%/day, the target being tested |
   | `SUPABASE_URL` | `https://cjhatumykdqlmihacopb.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key from `.env` |
   | `CRON_SECRET` | from `.env` |
   | `DASHBOARD_TOKEN` | from `.env` |
   | `PUBLIC_BACKTEST` | `false` |

2. Deploy the branch as **production**. Crons only fire on production deployments.

3. Open the dashboard. The first tick lands at the next 00:20 or 06:20 UTC cron, or
   immediately by hand:
   `curl -X POST -H "x-cron-secret: $CRON_SECRET" https://<project>.vercel.app/api/tick`
   (the same value in `Authorization: Bearer` also works).

4. Point a free uptime monitor at `/api/health`. It reads the database, so it keeps the
   Supabase free project from pausing after 7 idle days **and** alerts when a tick is
   overdue.

## What to expect when it runs

`GOAL_DAILY_RATE=0.05` is a *reported* target, not a reachable one: 5%/day compounds to
about 5.5 billion %/yr. The bot trades its normal rule — one BTC position, ~4 round
trips a year — and the dashboard will show the deficit widening by design. Live mode
refuses this setting above 0.5%/day without `ALLOW_UNREACHABLE_TARGET=true`; paper mode
allows it, because watching it fail is the point.

Nothing on the trading path can read the goal ledger, so the target cannot become a
reason to size up. That is enforced by a test, not by intention.
