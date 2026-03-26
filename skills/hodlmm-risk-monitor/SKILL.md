---
name: hodlmm-risk-monitor
description: "Security monitor for Bitflow HODLMM positions — detects bin drift, impermanent loss exposure, pool anomalies, and manipulation signals."
author: gregoryford963-sys
author_agent: Amber Otter
user-invocable: "false"
arguments: "scan-position | scan-pool | check-bins | risk-summary"
entry: "hodlmm-risk-monitor/hodlmm-risk-monitor.ts"
requires: ""
tags: "defi, read-only, l2"
hodlmm: "true"
---

# HODLMM Risk Monitor

## What it does

Continuously audits Bitflow HODLMM (Concentrated Liquidity AMM) positions and pools for security signals without executing any transactions. Detects when LP positions drift out-of-range (silently stop earning fees), flags abnormal TVL drops that indicate liquidity exits, identifies thin-liquidity bins that enable price manipulation, and estimates impermanent loss exposure at current market prices.

## Why agents need it

HODLMM positions go out-of-range silently — no on-chain event fires when your liquidity stops earning fees. An agent holding a concentrated LP position needs continuous surveillance to know when to rebalance or exit. This skill gives agents a security posture: run `risk-summary` every cycle and only act when a HIGH or CRITICAL risk score is returned, keeping gas costs near zero while maintaining full position awareness.

## Safety notes

- **Read-only.** This skill never submits transactions. No wallet required.
- **No funds moved.** Pure monitoring — fetches pool state and computes risk metrics.
- **No mainnet write operations.** Safe to run on any cycle cadence.
- **API dependency.** Relies on Bitflow public API (`https://api.bitflow.finance/api/v1`). If unreachable, returns `error` status with `api_unavailable` code.

## Commands

### scan-position

Fetch an address's LP position in a specific HODLMM pool and compute risk metrics: percentage of position in the active bin range, bins until out-of-range in each direction, and estimated impermanent loss at current price.

Risk levels:
- `LOW` — position fully in range, >50 bins to edge
- `MEDIUM` — position partially in range, 10-50 bins to edge
- `HIGH` — position <25% in range, or <10 bins to edge
- `CRITICAL` — position fully out-of-range (earning zero fees)

```bash
bun run skills/hodlmm-risk-monitor/hodlmm-risk-monitor.ts scan-position --pool <pool-id> --address <stx-address>
```

Example output:
```json
{
  "status": "success",
  "action": "Position is CRITICAL — fully out-of-range. Rebalance or exit immediately.",
  "data": {
    "pool_id": "hodlmm-sbtc-stx-v1",
    "address": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW",
    "active_bin": 8431200,
    "position": { "lower_bin": 8380000, "upper_bin": 8410000, "liquidity_share_pct": 2.41 },
    "risk": {
      "level": "CRITICAL",
      "in_range_pct": 0,
      "bins_to_lower_edge": -210,
      "bins_to_upper_edge": -21,
      "estimated_il_pct": 4.2,
      "fees_earning": false
    }
  },
  "error": null
}
```

### scan-pool

Fetch pool-level stats and detect anomalies: TVL drop >20% in 24h (mass exit signal), abnormal bin jumps (volatility spike), zero volume (abandoned pool), low liquidity (manipulation risk).

Anomaly signals:
- `tvl_drop` — TVL decreased >20% in 24h
- `bin_jump_spike` — active bin moved >100 bins in last hour
- `zero_volume` — no trading volume in 24h
- `low_liquidity` — TVL <$1,000

```bash
bun run skills/hodlmm-risk-monitor/hodlmm-risk-monitor.ts scan-pool --pool <pool-id>
```

Example output:
```json
{
  "status": "success",
  "action": "Pool has active anomaly: tvl_drop. Monitor closely or exit position.",
  "data": {
    "pool_id": "hodlmm-sbtc-stx-v1",
    "tvl_usd": 48200,
    "tvl_24h_change_pct": -22.3,
    "volume_24h_usd": 12400,
    "active_bin": 8431200,
    "bin_step_bps": 10,
    "anomalies": ["tvl_drop"],
    "risk_level": "HIGH"
  },
  "error": null
}
```

### check-bins

Inspect the liquidity distribution across N bins on each side of the active bin. Flags empty bins adjacent to the active bin (thin liquidity = high slippage and manipulation risk) and single-bin concentration.

Flags:
- `empty_adjacent` — bins immediately next to active bin have zero liquidity
- `single_bin_concentration` — one bin holds >60% of total liquidity in range
- `sparse_range` — >40% of bins in range are empty

```bash
bun run skills/hodlmm-risk-monitor/hodlmm-risk-monitor.ts check-bins --pool <pool-id> --range <N>
```

Example output:
```json
{
  "status": "success",
  "action": "Bin distribution shows sparse_range. Thin liquidity — slippage risk elevated.",
  "data": {
    "pool_id": "hodlmm-sbtc-stx-v1",
    "active_bin": 8431200,
    "scanned_range": 20,
    "bins": [
      { "bin_id": 8431180, "liquidity_usd": 0, "distance_from_active": -20 },
      { "bin_id": 8431190, "liquidity_usd": 0, "distance_from_active": -10 },
      { "bin_id": 8431200, "liquidity_usd": 12400, "distance_from_active": 0 },
      { "bin_id": 8431210, "liquidity_usd": 0, "distance_from_active": 10 },
      { "bin_id": 8431220, "liquidity_usd": 0, "distance_from_active": 20 }
    ],
    "flags": ["sparse_range", "empty_adjacent"],
    "risk_level": "HIGH"
  },
  "error": null
}
```

### risk-summary

Runs `scan-position` across all HODLMM pools where the address has active liquidity. Returns consolidated risk report sorted by severity. Primary command for autonomous agents — run once per cycle.

```bash
bun run skills/hodlmm-risk-monitor/hodlmm-risk-monitor.ts risk-summary --address <stx-address>
```

Example output:
```json
{
  "status": "success",
  "action": "1 CRITICAL position detected. Immediate rebalance required for hodlmm-sbtc-stx-v1.",
  "data": {
    "address": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW",
    "positions_found": 2,
    "overall_risk": "CRITICAL",
    "positions": [
      { "pool_id": "hodlmm-sbtc-stx-v1", "risk_level": "CRITICAL", "in_range_pct": 0, "fees_earning": false, "estimated_il_pct": 4.2 },
      { "pool_id": "hodlmm-stx-usda-v1", "risk_level": "LOW", "in_range_pct": 100, "fees_earning": true, "estimated_il_pct": 0.3 }
    ]
  },
  "error": null
}
```

## Output contract

All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## Known constraints

- Read-only — cannot trigger rebalances or exits. Use `bitflow-hodlmm-manager` for write operations.
- Bitflow API must be reachable. Offline environments get `api_unavailable` error.
- IL estimates are approximations based on current price vs position entry price ratio.
- Bin liquidity data may be up to 30 seconds stale depending on Bitflow API cache.
- `risk-summary` scales linearly with number of positions — large portfolios may be slow.
