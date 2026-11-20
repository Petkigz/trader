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

## `real/` — the 20-asset panel

`data/real/*.csv` holds one file per symbol, same format and same pipeline:
BTCUSDT, ETHUSDT, BNBUSDT, LTCUSDT, NEOUSDT, ADAUSDT, ETCUSDT, IOTAUSDT,
ONTUSDT, QTUMUSDT, TRXUSDT, VETUSDT, XLMUSDT, XRPUSDT, ALGOUSDT, ATOMUSDT,
BCHUSDT, DOGEUSDT, LINKUSDT, THETAUSDT.

2.3 MB total, 3,035–3,240 days each, all ending 2026-11-14. Verified against
public reference prices (ETH closed 4,628.78 on 2021-11-10; ADA's high that day
was 2.331; LTC on 2018-01-01 closed 222.61).

This panel is what `docs/CROSSSECTION.md` measures, and it exists so that claim
can be re-run offline by anyone rather than trusted.
