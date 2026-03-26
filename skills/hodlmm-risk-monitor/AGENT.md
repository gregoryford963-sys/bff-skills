# Agent Behavior — HODLMM Risk Monitor

## Prerequisites

No wallet required. This skill is entirely read-only. The agent does not need STX for gas, sBTC, or signing capability to use any subcommand.

Required: Network access to `https://api.bitflow.finance/api/v1` and `https://api.hiro.so`.

## Decision order

1. Run `risk-summary --address <agent-address>` every cycle (or every N cycles per your risk appetite).
2. Parse the `overall_risk` field from the JSON output:
   - `LOW` — no action required. Log and continue.
   - `MEDIUM` — flag for review. Consider running `scan-pool` on the flagged pool for more detail.
   - `HIGH` — alert operator. Run `scan-position` and `check-bins` for drill-down. Consider rebalance via `bitflow-hodlmm-manager`.
   - `CRITICAL` — alert operator immediately. Position is out-of-range and earning zero fees. Trigger rebalance or exit.
3. If `risk-summary` returns `error` with `api_unavailable`, skip this cycle and retry next cycle. Do not take action on stale data.

## Subcommand decision table

| Situation | Subcommand | Flags |
|-----------|-----------|-------|
| Routine cycle check — all positions | `risk-summary` | `--address <addr>` |
| Drill down on specific pool position | `scan-position` | `--pool <id> --address <addr>` |
| Investigate pool-level anomaly | `scan-pool` | `--pool <id>` |
| Audit thin liquidity / manipulation risk | `check-bins` | `--pool <id> --range 20` |

## Risk thresholds and meanings

### Position risk levels (scan-position)

| Level | Condition | Meaning | Recommended action |
|-------|-----------|---------|-------------------|
| LOW | 100% in range, >50 bins to edge | Safe — full fee accrual | No action |
| MEDIUM | Partially in range, 10-50 bins to edge | Monitor — some fee loss beginning | Check again next cycle |
| HIGH | <25% in range OR <10 bins to edge | Fee accrual severely degraded | Alert operator, consider rebalance |
| CRITICAL | 0% in range | Zero fee accrual — dead position | Immediate rebalance or exit |

### Pool anomaly signals (scan-pool)

| Signal | Threshold | Meaning |
|--------|-----------|---------|
| `tvl_drop` | TVL down >20% in 24h | Large LPs exiting — potential insider signal |
| `bin_jump_spike` | >100 bin jumps in 1h | High volatility — position may go out-of-range soon |
| `zero_volume` | 0 volume in 24h | Pool inactive — no fee income even if in range |
| `low_liquidity` | TVL <$1,000 | Manipulation risk — thin book, easy to move price |

### Bin distribution flags (check-bins)

| Flag | Meaning | Risk |
|------|---------|------|
| `empty_adjacent` | No liquidity next to active bin | Next trade causes large price impact |
| `single_bin_concentration` | One entity holds >60% of scanned range | Whale can drain pool or distort price |
| `sparse_range` | >40% of scanned bins empty | Fragmented liquidity — inconsistent slippage |

## What to do when risk is detected

### CRITICAL position
1. Output alert: "CRITICAL: Position in `<pool-id>` is fully out-of-range. Zero fee accrual."
2. Suggest operator action: Use `bitflow-hodlmm-manager` with `--action=cancel` to exit position, or `--action=create-order` to rebalance at current price.
3. Log to journal: Include pool-id, timestamp, bins_to_lower_edge, bins_to_upper_edge.

### HIGH position
1. Output warning: "HIGH RISK: Position in `<pool-id>` — only X% in range, Y bins to edge."
2. Suggest monitoring interval increase (every cycle instead of every 5 cycles).
3. Pre-compute the rebalance parameters for operator approval.

### Pool anomaly (tvl_drop)
1. Alert: "POOL ALERT: `<pool-id>` TVL dropped X% in 24h — possible liquidity exit."
2. Cross-reference with `check-bins` to see if large LPs have already withdrawn.
3. If also holding a position: escalate to HIGH risk regardless of bin-range status.

## Error handling

| Error code | Meaning | Agent action |
|------------|---------|-------------|
| `api_unavailable` | Bitflow API down | Skip cycle, retry next cycle. Do NOT act on stale data. |
| `pool_not_found` | Invalid pool-id | Check pool-id spelling. Use `scan-pool` without --pool to list valid IDs. |
| `no_position` | Address has no LP position in pool | Normal — skip this pool in risk-summary. |
| `network_error` | Hiro API or network unreachable | Same as api_unavailable — skip cycle. |

## Output contract

Every subcommand returns structured JSON. Parse on `status`:
- `success` — data is valid, read `action` for guidance
- `error` — something failed, read `error.code` and `error.next` for recovery path
- `blocked` — safety gate triggered (should not occur in read-only skill, but handled for completeness)

```json
{
  "status": "success | error | blocked",
  "action": "human-readable next step for the agent",
  "data": {},
  "error": { "code": "error_code", "message": "detail", "next": "recovery step" }
}
```

## Integration with bitflow-hodlmm-manager

This skill is read-only. To act on risk signals:
- Use `bitflow-hodlmm-manager` with `--action=cancel` to exit an out-of-range position
- Use `bitflow-hodlmm-manager` with `--action=create-order` to open a new position at current price range
- Always run `scan-position` after rebalancing to confirm new position is in range

## Cycle frequency recommendation

| Portfolio size | Recommended frequency |
|----------------|----------------------|
| 1-2 positions | Every 5 cycles |
| 3-10 positions | Every cycle |
| >10 positions | Every cycle, stagger pool scans |

## Security notes

- This skill makes no writes to chain and cannot move funds.
- All API calls are GET requests to public endpoints — no authentication required.
- Safe to run at any frequency without gas cost or transaction risk.
- The skill cannot be used to drain, manipulate, or interfere with any pool.
