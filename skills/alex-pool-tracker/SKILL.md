---
name: alex-pool-tracker
description: "Monitor ALEX Protocol liquidity pools — check pool APY, TVL, 24h volume, and find best yield opportunities on Stacks mainnet."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "pools [--token <symbol>] | pool <pool-id> | install-packs"
  entry: "alex-pool-tracker/alex-pool-tracker.ts"
  requires: "none"
  tags: "defi, read-only, mainnet-only, l2, alex"
---

# ALEX Pool Tracker

## What it does

Read-only monitoring of ALEX Protocol liquidity pools on Stacks mainnet. Calls the ALEX REST API to report pool APY, TVL, 24h trading volume, and token pair composition. Supports filtering by token symbol to find pools containing specific assets like sBTC or STX.

## Why agents need it

Agents managing liquidity or seeking yield on Stacks need to compare ALEX pool performance across cycles without executing transactions. This skill provides a lightweight read-only view of: (1) which pools offer the highest APY, (2) how much TVL is in each pool, and (3) recent trading volume as a liquidity health signal. No wallet required — purely observational.

## On-chain contracts

| Protocol | API | Purpose |
|----------|-----|---------|
| ALEX Lab | `https://api.alexlab.co/v1/pool_stats` | Pool stats endpoint — APY, TVL, volume |

## Commands

### pools [--token]
List all ALEX pools sorted by APY descending. Optional token filter narrows to pools containing that token.
```bash
bun run skills/alex-pool-tracker/alex-pool-tracker.ts pools
bun run skills/alex-pool-tracker/alex-pool-tracker.ts pools --token sBTC
bun run skills/alex-pool-tracker/alex-pool-tracker.ts pools --token STX
```

### pool \<pool-id\>
Show details for a single ALEX pool by pool ID.
```bash
bun run skills/alex-pool-tracker/alex-pool-tracker.ts pool <pool-id>
```

### install-packs
Reports dependency status (no additional packages required beyond Bun builtins).
```bash
bun run skills/alex-pool-tracker/alex-pool-tracker.ts install-packs
```

## Output contract

### pools output
```json
{
  "status": "ok",
  "filter": "sBTC",
  "pools": [
    {
      "pool_id": "alex-pool-sbtc-stx",
      "pair": "SBTC TOKEN / STX TOKEN",
      "apy_pct": 12.45,
      "tvl_usd": 850000,
      "volume_24h_usd": 42000
    }
  ],
  "count": 3,
  "summary": {
    "top_apy_pool": "alex-pool-sbtc-stx",
    "top_apy_pct": 12.45,
    "total_tvl_usd": 2100000
  },
  "severity": "ok"
}
```

### pool output
```json
{
  "status": "ok",
  "pool_id": "alex-pool-sbtc-stx",
  "pair": "SBTC TOKEN / STX TOKEN",
  "token_x": "SP...",
  "token_y": "SP...",
  "pool_token": "SP...",
  "apy_pct": 12.45,
  "tvl_usd": 850000,
  "volume_24h_usd": 42000,
  "severity": "ok"
}
```

## Safety notes

- **Read-only.** No transactions are submitted. No wallet required.
- **Mainnet only.** ALEX Protocol v2 is on Stacks mainnet.
- **Uses ALEX public API.** Data may lag real-time on-chain state by up to 5 minutes.
- **APY is annualized.** Pool APY reflects recent trading fees and may change rapidly with volume.
