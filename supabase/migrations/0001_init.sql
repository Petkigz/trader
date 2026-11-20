-- ---------------------------------------------------------------------------
-- Autopilot Trader — schema
--
-- Design notes:
--  * bot_state is a single row (id = 1). It carries the lock, the risk
--    bookkeeping, and the paper balance, so a tick is one read and one write.
--  * Money columns are `numeric`, not float, so balances never drift.
--  * RLS is enabled with *no* policies: only the service_role key (which
--    bypasses RLS) can read or write. The anon key sees nothing.
-- ---------------------------------------------------------------------------

create table if not exists public.bot_state (
  id                     integer primary key default 1,
  mode                   text        not null default 'paper',
  symbol                 text        not null,
  strategy               text        not null,

  high_water_mark        numeric     not null default 0,
  day_key                text        not null default '',
  day_start_equity       numeric     not null default 0,
  consecutive_losses     integer     not null default 0,
  halted_until           bigint      not null default 0,
  halt_reason            text        not null default '',
  cooldown_until         bigint      not null default 0,
  kill_switch            boolean     not null default false,

  paper_usdt             numeric     not null default 10,
  paper_base             numeric     not null default 0,

  position               jsonb,
  entry_price            numeric,

  last_tick_at           bigint      not null default 0,
  last_candle_close_time bigint      not null default 0,
  lock_expires_at        bigint      not null default 0,
  created_at             bigint      not null,
  updated_at             bigint      not null,

  constraint bot_state_singleton check (id = 1)
);

create table if not exists public.trades (
  id                 uuid primary key,
  ts                 bigint      not null,
  mode               text        not null,
  strategy           text        not null,
  symbol             text        not null,
  side               text        not null,
  qty                numeric     not null,
  price              numeric     not null,
  quote_qty          numeric     not null,
  fee_quote          numeric     not null default 0,
  reason             text        not null default '',
  order_id           text        not null default '',
  realized_pnl_quote numeric
);

create index if not exists trades_ts_idx on public.trades (ts desc);

create table if not exists public.ticks (
  id       bigserial primary key,
  ts       bigint      not null,
  mode     text        not null,
  strategy text        not null,
  symbol   text        not null,
  price    numeric     not null,
  equity   numeric     not null,
  action   text        not null,
  reason   text        not null default '',
  detail   text        not null default '',
  meta     jsonb       not null default '{}'::jsonb
);

create index if not exists ticks_ts_idx on public.ticks (ts desc);

-- Atomic "who runs this tick" claim. Returns true exactly once per TTL window
-- even if two schedulers fire simultaneously, because the UPDATE ... WHERE is
-- evaluated under a row lock.
create or replace function public.bot_acquire_lock(ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
  now_ms  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  update public.bot_state
     set lock_expires_at = now_ms + greatest(ttl_seconds, 5) * 1000
   where id = 1
     and lock_expires_at < now_ms
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

alter table public.bot_state enable row level security;
alter table public.trades    enable row level security;
alter table public.ticks     enable row level security;

revoke all on public.bot_state from anon, authenticated;
revoke all on public.trades    from anon, authenticated;
revoke all on public.ticks     from anon, authenticated;

-- Seed the singleton so /api/status has something to read on a cold start.
insert into public.bot_state (id, symbol, strategy, created_at, updated_at)
values (1, 'BTCUSDT', 'trend', (extract(epoch from clock_timestamp()) * 1000)::bigint, (extract(epoch from clock_timestamp()) * 1000)::bigint)
on conflict (id) do nothing;
