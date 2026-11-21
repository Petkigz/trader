#!/usr/bin/env python3
"""
Fetch non-crypto daily series for docs/ASSETCLASS.md.

Source: Rob Carver's `pst-group/pysystemtrade`, `data/futures/adjusted_prices_csv`,
which publishes back-adjusted continuous futures for ~250 instruments. Each file
is `DATETIME,price` at 20:00/23:00, so the last quote of each UTC day wins.

Output: data/realclass/<SYMBOL>.csv in this repo's `date,open,high,low,close`
shape (only closes are used; open/high/low are filled with the close).

Six of the 32 requested series (CRUDE_W, GILT, HANG, SOYBEAN, US10, US20) come
back with raw contract rolls still in them — a 57% rise followed by a 97% fall
within four days is a roll, not a market. They are downloaded and kept, but
`scripts/assetclass.ts` excludes any series containing a >50% daily move, so the
contamination cannot leak into a result.

    python3 scripts/fetch-assetclass.py

Requires the `gh` CLI (authenticated) because api.github.com is the only route to
this data from a sandbox without exchange access.
"""

import os
import subprocess
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

SYMBOLS = """SP500 NASDAQ DAX FTSE100 EUROSTX NIKKEI HANG SMI AEX RUSSELL TOPIX
BUND US10 US20 GILT JGB BTP
EUR GBP JPY CHF AUD CAD NZD
GOLD SILVER CRUDE_W COPPER CORN WHEAT SOYBEAN GAS_US""".split()

REPO = "pst-group/pysystemtrade"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "realclass")


def fetch(symbol):
    raw = subprocess.run(
        [
            "gh", "api",
            f"repos/{REPO}/contents/data/futures/adjusted_prices_csv/{symbol}.csv",
            "-H", "Accept: application/vnd.github.raw",
        ],
        capture_output=True,
    )
    if raw.returncode != 0 or len(raw.stdout) < 1000:
        return symbol, None
    by_day = OrderedDict()
    for line in raw.stdout.decode().splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        day = parts[0].strip()[:10]
        try:
            price = float(parts[1])
        except ValueError:
            continue
        if price > 0:
            by_day[day] = price
    return symbol, by_day


def main():
    os.makedirs(OUT, exist_ok=True)
    with ThreadPoolExecutor(max_workers=10) as pool:
        for symbol, days in pool.map(fetch, SYMBOLS):
            if not days:
                print(f"[{symbol}] missing")
                continue
            path = os.path.join(OUT, f"{symbol}.csv")
            with open(path, "w") as fh:
                fh.write("date,open,high,low,close\n")
                for day, price in days.items():
                    fh.write(f"{day},{price:.8g},{price:.8g},{price:.8g},{price:.8g}\n")
            keys = list(days)
            print(f"[{symbol}] {len(keys)} days {keys[0]} -> {keys[-1]}")


if __name__ == "__main__":
    main()
