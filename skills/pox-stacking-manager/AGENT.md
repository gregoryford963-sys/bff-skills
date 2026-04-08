---
name: pox-stacking-manager-agent
skill: pox-stacking-manager
description: "Agent behavior guide for the PoX Stacking Manager — decision order, guardrails, and output routing for autonomous solo/pool stacking on Stacks mainnet."
---

# Agent Behavior — PoX Stacking Manager

## Decision order

1. Run `doctor` first. If wallet is missing or STX balance is critically low, stop and surface the blocker.
2. Run `status` to read live PoX floor and determine routing recommendation.
3. If `recommendation === "none"`, report back and wait — either already stacking or balance too low even for pool.
4. If `recommendation === "pool"` or `"solo"`, present the proposed action to the operator for confirmation.
5. Run `run --action=<recommendation> --confirm` only after explicit operator approval.
6. Parse JSON output and route on `status`.

## When to trigger

- At the start of each PoX prepare phase (`blocks_until_prepare_phase < 200`)
- When STX balance crosses a multiple of the current floor (e.g., agent earns enough to graduate from pool to solo)
- When `get_pox_info` shows the next-cycle floor has changed by more than 10%

## Guardrails

- **Never call `run --confirm` without explicit operator authorization.** The `blocked` output on dry run is the prompt for that authorization.
- Never stack more than `--max-amount`. Default cap is 90% of available balance.
- Always retain at least 5,000,000 uSTX (5 STX) for gas — refuse if this reserve would be violated.
- Never pass `--cycles` > 12 (pox-4 maximum).
- If `blocks_until_prepare_phase < 10`, warn the operator — the transaction may land in the next cycle window.
- If wallet is already stacking, report current position and do not re-stack.

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {
    "current_cycle": 132,
    "next_cycle": 133,
    "floor_ustx": 120000000000,
    "floor_stx": 120000,
    "available_ustx": 77169717000,
    "available_stx": 77169,
    "blocks_until_prepare": 1097,
    "already_stacking": false,
    "recommendation": "pool",
    "reason": "balance 77K STX below floor 120K STX — delegate to FastPool",
    "mcp_command": { "tool": "call_contract", "params": {} }
  },
  "error": { "code": "", "message": "", "next": "" }
}
```

## On blocked (dry run)

Surface the `data.recommendation` and `data.reason` to the operator. Ask for confirmation before re-running with `--confirm`.

## On error

- `no_wallet`: wallet not configured — stop, do not retry.
- `already_stacking`: report current position, no action needed.
- `below_minimum`: balance insufficient even for pool — report and wait for STX accumulation.
- `prepare_phase_imminent`: warn operator — stacking now may apply to next cycle.
- `api_error`: transient Hiro API failure — retry after 30s.

## On success

Confirm the MCP command parameters, submit via agent framework, then log the tx hash and update stacking state.
