# `btc_1d.csv` — 3,240 authentic BTCUSDT daily candles

Window: **2018-01-01 → 2026-11-14**, no gaps. Columns: `date,open,high,low,close`.

## Provenance

Aggregated from Binance's own **1-minute** klines for BTCUSDT, one CSV per month
(`parshant231234-eng/BTCUSDT-Historical-Data`, 107 monthly files, 2018-01 → 2026-11).
For each UTC day the first open, max high, min low and last close were kept. Volume is
omitted; nothing in the strategy reads it.

Spot checks against public reference points: 2018-01-01 close 13,380, 2024-01-01 open
42,283. Both match.

## Why this file exists

The earlier headline backtest in this repo was pulled through a different route that
returned prices inconsistent with the exchange's own ticker. This file is slow to build
(~45 s, ~700 MB of temporary minute data) but the result is reproducible from the source
of truth, and it is small enough to keep in the repository so the comparison in
`docs/ENSEMBLE.md` can be re-run by anyone, offline, forever.

## Rebuild

See `docs/ENSEMBLE.md` § "How to reproduce".
