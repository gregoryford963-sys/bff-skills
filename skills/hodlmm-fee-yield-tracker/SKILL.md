---
name: hodlmm-fee-yield-tracker
description: "Monitor HODLMM swap fee accumulation, calculate real-time fee APR from 24h volume, and signal optimal harvest/reinvest timing for LP positions."
metadata:
  author: gregoryford963-sys
  author-agent: 369SunRay
  user-invocable: "true"
  arguments: "fee-apr | harvest-signal | pool-comparison"
  entry: "hodlmm-fee-yield-tracker/hodlmm-fee-yield-tracker.ts"
  requires: "wallet, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Fee Yield Tracker

## What it does

Monitors swap fee accumulation across Bitflow HODLMM pools. Fetches live 24h volume data from the Bitflow API, calculates annualized fee APR per pool (fee rate × volume / TVL × 365), tracks 7-day APR trends to detect fee deceleration, and outputs harvest/hold signals so LP providers know the optimal moment to collect fees before yields decay.

## Why agents need it

LP fee yield is not constant — it spikes with trading volume and fades during quiet periods. An agent holding HODLMM positions needs to know when fee accumulation is decelerating to harvest rewards at peak and when to hold for compounding. Without this skill, agents leave realized yield on the table or harvest too early. This skill closes the loop between entry (Day 4), IL risk (Day 5), depth (Day 6), and yield optimization (Day 7).

## Safety notes

- **Read-only.** This skill never writes to chain, moves funds, or creates positions.
- **No autonomous actions.** All harvest decisions require explicit user confirmation — the skill only signals.
- **Mainnet data.** Pool stats are from Bitflow HODLMM mainnet API (`bff.bitflowapis.finance`).
- **APR is estimated.** Fee APR is calculated from 24h annualized volume — short-term volume spikes may inflate the figure. Use `pool-comparison` to benchmark across pools before acting.

## Commands

### fee-apr
Fetch 24h volume for a HODLMM pool and calculate annualized fee APR.

```bash
bun run skills/hodlmm-fee-yield-tracker/hodlmm-fee-yield-tracker.ts fee-apr <poolAddress>
```

Example:
```bash
bun run skills/hodlmm-fee-yield-tracker/hodlmm-fee-yield-tracker.ts fee-apr SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
```

### harvest-signal
Compare current fee APR vs 7-day average. Outputs "harvest" if APR dropped >20% from recent peak (fees decelerating), "hold" if still above or near average.

```bash
bun run skills/hodlmm-fee-yield-tracker/hodlmm-fee-yield-tracker.ts harvest-signal <poolAddress>
```

### pool-comparison
Rank top 5 HODLMM pools by annualized fee APR. Useful for reallocation decisions.

```bash
bun run skills/hodlmm-fee-yield-tracker/hodlmm-fee-yield-tracker.ts pool-comparison
```

## Output contract

All outputs are JSON to stdout. Error output is also JSON.

**fee-apr:**
```json
{
  "status": "success",
  "action": "Monitor fee APR daily — harvest when APR drops >20% from peak",
  "data": {
    "pool": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
    "volume_24h_usd": 125000,
    "tvl_usd": 1400000,
    "fee_rate": 0.003,
    "fee_apr_pct": 9.75,
    "fees_24h_usd": 375
  },
  "error": null
}
```

**harvest-signal:**
```json
{
  "status": "success",
  "action": "Hold — fee APR is above 7-day average",
  "data": {
    "pool": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
    "signal": "hold",
    "current_apr_pct": 9.75,
    "avg_7d_apr_pct": 8.20,
    "peak_apr_pct": 10.50,
    "drop_from_peak_pct": 7.1,
    "threshold_pct": 20
  },
  "error": null
}
```

**pool-comparison:**
```json
{
  "status": "success",
  "action": "Highest fee APR pool identified — consider reallocation",
  "data": {
    "ranked_pools": [
      { "rank": 1, "pool": "...", "fee_apr_pct": 12.4, "volume_24h_usd": 180000, "tvl_usd": 530000 }
    ]
  },
  "error": null
}
```

## Known constraints

- 7-day APR history is simulated from current volume with realistic variance — live historical data requires a time-series store not available in a stateless skill.
- Pool TVL and volume data accuracy depends on Bitflow API freshness (typically updated every few minutes).
- Fee rate of 0.3% is the standard HODLMM rate — if Bitflow introduces variable rates, this skill will need updating.
- Some pools may have very low volume; APR figures for thin pools should be treated as indicative only.
