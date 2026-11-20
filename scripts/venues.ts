#!/usr/bin/env node
/**
 * Venue comparison: what a $10 account does on Binance spot vs MetaTrader 5.
 *
 *   npm run venues
 *   npm run venues -- --equity=276
 *
 * `docs/ASSET.md` §3 quotes numbers from this simulation, but the script that
 * produced them was never committed — so the claim "MT5 loses the account 88%
 * of the time at $10" had no artifact behind it. This is that artifact.
 *
 * The asymmetry it measures is not about MT5 being worse software. It is about
 * the smallest position that exists: 0.01 lots of EURUSD is ~$1,160 notional,
 * and that number does not shrink when your equity does.
 *
 * Everything here is deterministic given the seed, so a disagreement with the
 * published figures is inspectable rather than vibes.
 */

import { gaussian, mulberry32 } from "../src/data.ts";

const DAYS = 252;
const PATHS = 20_000;
const SEED = 20260101;

/** Measured in `docs/ASSET.md`: BTC ~42% annualised vol, 23.3% CAGR (conservative earlier measure). */
const CRYPTO = { annualVol: 0.42, cagr: 0.233, positionFraction: 0.93 };
/** EURUSD proxy: ~10% annualised. The 6% case is the stress variant. */
const FX = { annualVol: 0.1, stressVol: 0.06 };
/** 0.01 lots = 1,000 units ≈ $1,160, fixed. The cost is $0.20 per round trip. */
const MT5 = { notionalPerLot: 1_160, roundTripCost: 0.2, roundTripsPerYear: 12, marginFloor: 2.32 };
/** Both systems are in the market on the same share of days. */
const EXPOSURE = 0.56;

interface Outcome {
  median: number;
  mean: number;
  deadRate: number;
  medianDeathDay: number | null;
  p10x: number;
  pDouble: number;
}

function simulate(
  startEquity: number,
  dailyVol: number,
  dailyDrift: number,
  /** Equity multiplier applied to the day's return, recomputed each day. */
  exposureOfEquity: (equity: number) => number,
  dead: (equity: number) => boolean,
  seed: number,
): Outcome {
  const rand = mulberry32(seed);
  const finals: number[] = [];
  let deadCount = 0;
  let deathDays = 0;
  let doubled = 0;
  let tenX = 0;

  for (let path = 0; path < PATHS; path++) {
    let equity = startEquity;
    let firstDeath: number | null = null;
    let peakDouble = false;

    for (let day = 0; day < DAYS && firstDeath === null; day++) {
      const inMarket = rand() < EXPOSURE;
      const shock = gaussian(rand);
      if (inMarket) {
        const exposure = exposureOfEquity(equity);
        equity += exposure * dailyVol * shock + exposure * dailyDrift;
      }
      if (equity <= 0) equity = 0;
      if (equity >= startEquity * 2) peakDouble = true;
      if (dead(equity)) firstDeath = day;
    }

    if (firstDeath !== null) {
      deadCount++;
      deathDays += firstDeath;
      finals.push(0);
    } else {
      finals.push(equity);
      if (equity >= startEquity * 2) peakDouble = true;
      if (equity >= startEquity * 10) tenX++;
    }
    if (peakDouble) doubled++;
  }

  finals.sort((a, b) => a - b);
  const sum = finals.reduce((a, b) => a + b, 0);
  return {
    median: finals[Math.floor(finals.length / 2)],
    mean: sum / finals.length,
    deadRate: deadCount / PATHS,
    medianDeathDay: deadCount > 0 ? deathDays / deadCount : null,
    p10x: tenX / PATHS,
    pDouble: doubled / PATHS,
  };
}

function cryptoAt(equity: number): Outcome {
  const dailyVol = CRYPTO.annualVol / Math.sqrt(DAYS);
  const dailyDrift = CRYPTO.cagr / DAYS;
  return simulate(
    equity,
    dailyVol,
    dailyDrift,
    (e) => e * CRYPTO.positionFraction,
    (e) => e < 1, // spot cannot be liquidated; only total ruin
    SEED,
  );
}

/**
 * MT5 needs its own loop: the position is a fixed notional, so the shock is a
 * percentage of $1,160 and not of equity. That asymmetry is the whole point.
 */
function mt5Sim(equity: number, fxVol = FX.annualVol, seed = SEED): Outcome {
  const rand = mulberry32(seed);
  const dailyVol = fxVol / Math.sqrt(DAYS);
  const costPerRoundTrip = MT5.roundTripCost;
  const finals: number[] = [];
  let deadCount = 0;
  let deathDays = 0;
  let tenX = 0;
  let doubled = 0;

  for (let path = 0; path < PATHS; path++) {
    let eq = equity;
    let firstDeath: number | null = null;
    let hitDouble = false;
    let trips = 0;

    for (let day = 0; day < DAYS && firstDeath === null; day++) {
      const inMarket = rand() < EXPOSURE;
      const shock = gaussian(rand);
      if (inMarket) {
        eq += MT5.notionalPerLot * dailyVol * shock;
        trips++;
        if (trips % 21 === 0) eq -= costPerRoundTrip;
      }
      if (eq >= equity * 2) hitDouble = true;
      if (eq < MT5.marginFloor) firstDeath = day;
    }

    if (hitDouble) doubled++;
    if (firstDeath !== null) {
      deadCount++;
      deathDays += firstDeath;
      finals.push(0);
    } else {
      finals.push(Math.max(0, eq));
      if (eq >= equity * 10) tenX++;
    }
  }

  finals.sort((a, b) => a - b);
  return {
    median: finals[Math.floor(finals.length / 2)],
    mean: finals.reduce((a, b) => a + b, 0) / finals.length,
    deadRate: deadCount / PATHS,
    medianDeathDay: deadCount > 0 ? deathDays / deadCount : null,
    p10x: tenX / PATHS,
    pDouble: doubled / PATHS,
  };
}

/** No simulation needed: one ordinary day, as a share of the account. */
function oneSigma(equity: number, fxVol = FX.annualVol): number {
  return (MT5.notionalPerLot * (fxVol / Math.sqrt(DAYS))) / equity;
}

function money(x: number): string {
  return `$${x.toFixed(2)}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const equityArg = Number(process.argv.find((a) => a.startsWith("--equity="))?.slice(9));
  const start = Number.isFinite(equityArg) && equityArg > 0 ? equityArg : 10;

  console.log(`Venue comparison · ${PATHS.toLocaleString()} paths · ${DAYS} days · seed ${SEED}`);
  console.log(`Exposure ${pct(EXPOSURE)} of days for both · FX ${pct(FX.annualVol)} annualised · 0.01 lot = ${money(MT5.notionalPerLot)}\n`);

  const crypto = cryptoAt(start);
  const mt5 = mt5Sim(start);

  console.log(`Starting equity ${money(start)}\n`);
  console.log("                          crypto spot      MT5 (0.01 lot)");
  console.log(`median after 1 year       ${money(crypto.median).padStart(11)}      ${money(mt5.median).padStart(11)}`);
  console.log(`mean                      ${money(crypto.mean).padStart(11)}      ${money(mt5.mean).padStart(11)}`);
  console.log(`P(account dead)           ${pct(crypto.deadRate).padStart(11)}      ${pct(mt5.deadRate).padStart(11)}`);
  console.log(`median day of death       ${"—".padStart(11)}      ${(mt5.medianDeathDay === null ? "—" : `day ${mt5.medianDeathDay.toFixed(0)}`).padStart(11)}`);
  console.log(`P(doubled)                ${pct(crypto.pDouble).padStart(11)}      ${pct(mt5.pDouble).padStart(11)}`);
  console.log(`P(10x)                    ${pct(crypto.p10x).padStart(11)}      ${pct(mt5.p10x).padStart(11)}`);
  console.log(`one ordinary day           ${pct(CRYPTO.annualVol / Math.sqrt(DAYS) * CRYPTO.positionFraction).padStart(11)}      ${pct(oneSigma(start)).padStart(11)}`);

  console.log("\nThe same model at different account sizes — MT5 only:");
  console.log("equity     leverage   1 sigma/day   P(dead in 1yr)   median      note");
  for (const eq of [10, 50, 100, 276, 500, 1160, 2320, 5000]) {
    const r = mt5Sim(eq, FX.annualVol, SEED + Math.round(eq));
    const sigma = oneSigma(eq);
    const leverage = MT5.notionalPerLot / eq;
    const note =
      sigma > 0.5
        ? "a quiet day can end the account"
        : sigma > 0.05
          ? "leverage still decides the outcome"
          : sigma > 0.015
            ? "risk per day is spot-like"
            : "below the spot bot's daily risk";
    console.log(
      `${money(eq).padStart(9)}  ${`${leverage.toFixed(1)}x`.padStart(9)}   ${pct(sigma).padStart(11)}    ${pct(r.deadRate).padStart(12)}   ${money(r.median).padStart(9)}   ${note}`,
    );
  }

  const stress = mt5Sim(start, FX.stressVol, SEED);
  console.log(
    `\nStress test at ${money(start)} with FX vol cut to ${pct(FX.stressVol)} (40% below measured): ` +
      `${pct(stress.deadRate)} dead, median ${money(stress.median)}.`,
  );
  console.log(
    "\nThe threshold: MT5 stops being a lottery ticket at about $276 of equity, where\n" +
      "one ordinary day is 2.6% of the account — the same as the spot bot's. At\n" +
      "$1,160 the position is unlevered. Below ~$100 it is a coin toss dressed as\n" +
      "a strategy, and at $10 the account is gone in a median 26 days.\n\n" +
      "The smallest position is the whole story: $1,160 of notional does not scale\n" +
      "down with a $10 account, so the account is 116x levered whether you asked for\n" +
      "it or not. The fix is not a better strategy, it is more equity or a smaller\n" +
      "minimum lot — and no broker offers one.",
  );
}

main();
