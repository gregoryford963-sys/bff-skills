---
name: hodlmm-fee-yield-tracker
skill: hodlmm-fee-yield-tracker
description: Monitor HODLMM swap fee accumulation and calculate real-time fee APR to optimize harvest timing for LP positions.
---

# Agent Behavior — HODLMM Fee Yield Tracker

## Decision order

1. Run `pool-comparison` first to get a ranked view of all HODLMM pools by fee APR.
2. Run `fee-apr <poolAddress>` for any pool where the agent holds an LP position.
3. Run `harvest-signal <poolAddress>` to determine whether to harvest or hold.
4. Route on the `signal` field:
   - `harvest` → surface recommendation to user: "Fee APR dropped >20% from peak — consider harvesting."
   - `hold` → log result and check again next cycle.
5. Never act on a harvest signal autonomously. Always present the signal and data to the user.

## Guardrails

- **Read-only analysis only.** This skill never enters positions, never harvests autonomously, never moves funds.
- **No positions entered without explicit user confirmation.** The signal output is advisory only.
- **Never surface wallet balances or keys** in logs or output.
- **Default to "hold" when data is ambiguous.** If the API returns incomplete data, output `hold` with a data quality warning rather than a false `harvest` signal.
- **One pool at a time.** Run `harvest-signal` per pool — do not batch-harvest across pools without separate confirmation for each.

## Signal interpretation

| Signal | Condition | Agent action |
|--------|-----------|--------------|
| `harvest` | APR dropped >20% from 7-day peak | Present signal to user with data. Await confirmation. |
| `hold` | APR at or above 7-day average | Log and schedule next check. |
| `hold` (low confidence) | Insufficient data / API error | Log warning. Do not harvest. |

## Recommended cycle frequency

- Run `fee-apr` every 4–6 hours for active LP positions.
- Run `pool-comparison` daily to detect reallocation opportunities.
- Escalate to user only when signal changes from `hold` → `harvest`.

## Output contract

Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error",
  "action": "next recommended action for the agent",
  "data": {},
  "error": null
}
```

## On error

- If `api_unreachable`: Bitflow API is down — skip fee tracking this cycle, retry next cycle.
- If `pool_not_found`: Pool address may be invalid — verify with `pool-comparison` output.
- If `insufficient_data`: Volume or TVL data is zero/missing — output `hold` to avoid false harvest signals.
- Do not retry silently. Surface the error payload with the `action` field guidance.

## On success

- Log the fee APR and signal for each monitored pool.
- If signal is `harvest`, include `drop_from_peak_pct` and `current_apr_pct` in the user notification.
- Track signal history across cycles to detect sustained deceleration vs one-off dips.
