---
name: hodlmm-depth-scout
description: "Analyzes Bitflow HODLMM pool liquidity depth distribution and estimates swap price impact — returns depth score, bin concentration, and impact signal to guide LP and trading agent decisions."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | depth-check | swap-impact | scan-depth"
  entry: "hodlmm-depth-scout/hodlmm-depth-scout.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# HODLMM Depth Scout

## What it does

Analyzes the liquidity depth distribution across all bins in a Bitflow HODLMM pool. Reports:
- How many bins have liquidity above and below the active bin
- Whether the pool is single-sided (all in one token) or balanced
- A depth score 0-100 for comparing pools
- Estimated price impact (bins consumed, price move %) for a given swap size

## Why agents need it

Autonomous agents executing swaps or managing LP positions need to know execution conditions before acting:

- **LP agents**: Is the pool deep enough to justify adding liquidity? A SHALLOW pool may not generate meaningful fees.
- **Trading agents**: How many bins will a swap of size N consume? A swap through 50 bins is very different from a swap through 2.
- **Risk agents**: Is liquidity heavily one-sided? Single-sided pools are near their operational limits and may not be able to absorb large swaps in one direction.

## Commands

### doctor
Checks API connectivity and lists all active pools.
```bash
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts doctor
```

### depth-check
Analyzes liquidity depth for a specific pool.
```bash
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts depth-check --pool-id dlmm_2
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts depth-check --pool-id dlmm_2 --near-window 50
```

`--near-window` sets how many bins either side of the active bin count as "near depth" (default: 25).

### swap-impact
Estimates price impact for a swap of a given size through bin liquidity.
```bash
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts swap-impact --pool-id dlmm_2 --side sell --amount 1000000
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts swap-impact --pool-id dlmm_3 --side buy --amount 500000
```

`--side buy` = buying token_x (price rises), `--side sell` = selling token_x (price falls).
`--amount` is in the smallest unit of the input token (satoshis for sBTC, micro for STX/USDC).

**Note:** `avgExecutionPrice` is a rough estimate in pool-native units. Callers should apply token decimal conversion for human-readable prices.

### scan-depth
Scans all active pools and ranks by depth score.
```bash
bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts scan-depth
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "DEEP",
  "data": {
    "poolId": "dlmm_2",
    "pair": "sBTC-USDCx",
    "activeBinId": 603,
    "currentPrice": 66879771628,
    "binsWithLiquidity": 224,
    "binsAboveActive": 11,
    "binsBelowActive": 212,
    "nearDepthBins": 37,
    "depthScore": 92.2,
    "depthSignal": "DEEP",
    "concentration": "single-sided-y",
    "concentrationNote": "Pool is primarily token_y (price has fallen below entry — LPs converted to quote token)."
  },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Depth score thresholds

| Score | Signal | Meaning |
|-------|--------|---------|
| 0–29 | SHALLOW | Thin liquidity — high price impact, low fee generation |
| 30–59 | MODERATE | Adequate depth for small to medium swaps |
| 60–100 | DEEP | Strong liquidity — suitable for larger positions and swaps |

## Impact signal thresholds

| Price move | Signal |
|------------|--------|
| < 1% | LOW |
| 1–5% | MEDIUM |
| > 5% | HIGH |
| Insufficient liquidity | UNFILLABLE |

## Safety notes

- **Read-only** — no wallet required, no transactions submitted.
- No funds are moved. Safe to run at any frequency.
- Mainnet only — Bitflow HODLMM pools are mainnet-only.
- Swap impact estimates are simulations based on current bin reserves. Actual execution may differ due to MEV, concurrent swaps, or price oracle updates.
- Do not use `avgExecutionPrice` for precise settlement calculations — it requires token decimal normalization not handled here.

## Known constraints

- Swap impact is bin-walk simulation, not an exact AMM calculation. Treat as an upper-bound estimate.
- `avgExecutionPrice` is in pool-native microtoken units. Apply token decimal conversion for human-readable values.
- Reserves use the pool's native precision. Token amounts are not normalized across pools.
- Requires Bitflow HODLMM API (`bff.bitflowapis.finance`). Override with `BITFLOW_HODLMM_API_HOST`.
