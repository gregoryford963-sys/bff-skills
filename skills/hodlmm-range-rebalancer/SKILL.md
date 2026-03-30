---
name: hodlmm-range-rebalancer
description: "Analyzes an existing HODLMM LP position's bin range against live pool state to produce a HOLD / REBALANCE signal with a new recommended bin spread — helps agents decide when to close and re-enter a liquidity position."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter"
  user-invocable: "false"
  arguments: "doctor | check-range | rebalance-plan | scan-positions"
  entry: "hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# HODLMM Range Rebalancer

## What it does

Evaluates whether an existing HODLMM LP position is still optimally positioned given current pool state. Compares the agent's bin range against the active bin, measures range utilization and drift, and produces a **HOLD / REBALANCE** signal with a concrete new bin spread when rebalancing is warranted.

## Why agents need it

An LP position that was optimal at entry degrades over time as price drifts:
- **Out-of-range bins**: Active bin moves outside the position's range — earning zero fees, accumulating maximum IL
- **Lopsided utilization**: Most liquidity is in bins far from the active bin — capital inefficiency
- **Stale spreads**: Volatility regime changed since entry — the original spread is too wide or too narrow

An autonomous LP agent must periodically answer "is my current range still working?" before deciding whether to stay or rebalance. `hodlmm-range-rebalancer` answers this with a HOLD/REBALANCE signal and a concrete new bin plan.

## Safety notes

- **Read-only** — no wallet required, no transactions submitted.
- No funds are moved. Safe to run at any frequency.
- Mainnet only — Bitflow HODLMM pools are mainnet-only.

## Commands

### doctor
Checks API connectivity and lists available HODLMM pools.
```bash
bun run skills/hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts doctor
```

### check-range
Evaluates a specific position (bin range) against current pool state.
```bash
bun run skills/hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts check-range \
  --pool-id dlmm_1 --lower-bin 8388500 --upper-bin 8388700
```

### rebalance-plan
Returns a full rebalance plan: close the old range, suggested new lower/upper bins, and rationale.
```bash
bun run skills/hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts rebalance-plan \
  --pool-id dlmm_1 --lower-bin 8388500 --upper-bin 8388700 --count 20
```

### scan-positions
Batch-evaluates multiple positions across pools and ranks by rebalance urgency.
```bash
bun run skills/hodlmm-range-rebalancer/hodlmm-range-rebalancer.ts scan-positions \
  --positions '[{"poolId":"dlmm_1","lowerBin":8388500,"upperBin":8388700},{"poolId":"dlmm_2","lowerBin":8387000,"upperBin":8389000}]'
```

## Output contract

All outputs are JSON to stdout.

**check-range success:**
```json
{
  "status": "success",
  "action": "REBALANCE",
  "data": {
    "poolId": "dlmm_1",
    "activeBinId": 8388750,
    "positionLowerBin": 8388500,
    "positionUpperBin": 8388700,
    "inRange": false,
    "binsFromRange": 50,
    "utilizationScore": 22,
    "driftScore": 78,
    "rebalanceScore": 71,
    "recommendation": "Active bin is 50 bins above your upper bound. Position is out of range and earning no fees."
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
| Utilization score | % of position bins near active bin | Capital efficiency |
| Drift score | Distance of active bin from position center | How far price has moved |
| Rebalance score | Weighted composite (50/50) | Overall urgency |

**Signal thresholds:**
- HOLD: rebalance score < 40
- MONITOR: rebalance score 40–64
- REBALANCE: rebalance score ≥ 65

## Known constraints

- Requires Bitflow HODLMM API access (`bff.bitflowapis.finance`). Override with `BITFLOW_HODLMM_API_HOST` env var.
- Bin IDs are pool-specific integers (visible via `doctor` or HODLMM explorer)
- Scores are point-in-time; pool state changes with every swap
