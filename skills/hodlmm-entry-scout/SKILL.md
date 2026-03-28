---
name: hodlmm-entry-scout
description: "Analyzes HODLMM pool bin distributions to score LP entry conditions and recommend optimal bin spread — helps agents decide when and how to enter a HODLMM liquidity position."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | scan-pools | entry-signal | optimal-bins"
  entry: "hodlmm-entry-scout/hodlmm-entry-scout.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# HODLMM Entry Scout

## What it does

Analyzes live HODLMM pool state to score LP entry conditions and recommend an optimal bin spread before an agent adds liquidity. Computes bin depth, distribution spread, and active-bin centrality to produce an ENTER / WAIT / AVOID signal with numeric scores.

## Why agents need it

Adding liquidity to a HODLMM pool without analyzing current bin state can result in:
- Immediate impermanent loss (price already at the edge of the distribution)
- Thin execution (liquidity too spread, active bin has low depth)
- Poor fee capture (bins misconfigured relative to current price momentum)

An autonomous LP agent must answer "is this a good time to enter, and how wide should I spread my bins?" before committing funds. `hodlmm-entry-scout` answers both questions with live pool data.

## Safety notes

- **Read-only** — no wallet required, no transactions submitted.
- No funds are moved. Safe to run at any frequency.
- Mainnet only — Bitflow HODLMM pools are mainnet-only.

## Commands

### doctor
Checks API connectivity and lists available HODLMM pools.
```bash
bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts doctor
```

### scan-pools
Scans all suggested HODLMM pools and ranks them by entry health score (0–100).
```bash
bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts scan-pools
bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts scan-pools --limit 5
```

### entry-signal
Returns an ENTER / WAIT / AVOID signal for a specific pool with full score breakdown.
```bash
bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts entry-signal --pool-id dlmm_1
```

### optimal-bins
Recommends the optimal bin spread (count and offsets) for adding N bins of liquidity given the current pool distribution.
```bash
bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts optimal-bins --pool-id dlmm_1 --count 10
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "ENTER",
  "data": {
    "poolId": "dlmm_1",
    "entryScore": 74,
    "depthScore": 82,
    "spreadScore": 71,
    "centralityScore": 68,
    "recommendation": "Conditions are favorable for LP entry.",
    "activeBinId": 8388608,
    "totalLiquidBins": 42
  },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Scoring methodology

| Score | Component | What it measures |
|-------|-----------|-----------------|
| Depth score | Liquidity volume in bins ±5 of active | Slippage risk during entry |
| Spread score | Distribution of liquidity across all bins | IL risk (narrow = high IL risk) |
| Centrality score | Active bin position within distribution | Price momentum (edge = trending away) |
| Entry score | Weighted composite (40/30/30) | Overall entry quality |

**Signal thresholds:**
- ENTER: score ≥ 65
- WAIT: score 40–64
- AVOID: score < 40

## Known constraints

- Requires Bitflow HODLMM API access (`bff.bitflowapis.finance`). Override with `BITFLOW_HODLMM_API_HOST` env var.
- Pool list may change as new HODLMM pools are added
- Scores are point-in-time; pool state changes with every swap
