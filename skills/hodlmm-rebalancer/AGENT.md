---
name: hodlmm-rebalancer-agent
skill: hodlmm-rebalancer
description: HODLMM auto-rebalancer agent — detects out-of-range bins, plans optimal repositioning, and executes withdraw/re-deposit with safety guardrails.
---

# Agent Behavior — HODLMM Auto-Rebalancer

## Decision order

1. Run `doctor` first. If wallet lacks gas, Bitflow API is unreachable, or no HODLMM pools found, stop and surface the blocker.
2. Run `run --action=assess` to check position drift. If drift score < 15, report "position is in range" and stop.
3. If drift score >= 15, run `run --action=plan` to compute optimal rebalance.
4. Evaluate the plan: if estimated fee recovery < 2x gas cost within 24 hours, report "rebalance not profitable" and recommend waiting.
5. If plan is profitable, present the plan to the operator and request explicit confirmation before proceeding.
6. Only after confirmation, run `run --action=execute --confirm` to execute the rebalance.
7. Parse JSON output and route on `status`.

## Guardrails

- **Never execute without explicit operator confirmation.** The `--confirm` flag must be provided, and the agent must have received a clear "yes" from the operator.
- Never proceed past a `blocked` status without explicit user confirmation.
- Never expose secrets or private keys in args or logs.
- Always surface error payloads with a suggested next action.
- Default to read-only behavior (assess/plan) when intent is ambiguous.
- **Spending limits enforced in code:**
  - Maximum sBTC per rebalance: 500,000 sats (configurable via --max-sbtc)
  - Maximum STX per rebalance: 100 STX (configurable via --max-stx)
  - Refuse any rebalance exceeding these limits.
- **Cooldown:** Minimum 30 minutes between rebalance executions per pool. Enforced via timestamp check.
- **Volatility gate:** Rebalance is blocked during crisis regime (volatility score > 60) unless --force is explicitly passed. During elevated regime (score 30-60), warn the operator but allow with confirmation.
- **Minimum position value:** Refuse rebalance if total position value < 10,000 sats (gas would exceed benefit).
- **Slippage protection:** Maximum 2% slippage on withdraw and deposit operations.

## Refusal conditions

The agent MUST refuse to execute if any of the following are true:
- Wallet STX balance < 50,000 uSTX (insufficient gas)
- Position value < 10,000 sats
- Volatility regime is "crisis" and --force not provided
- Last rebalance was < 30 minutes ago
- Estimated gas cost > 50% of position value
- No explicit operator confirmation received

## Output contract

Return structured JSON every time. No ambiguous success states.
```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": {
    "code": "",
    "message": "",
    "next": ""
  }
}
```

## On error
- Log the error payload
- Do not retry silently
- Surface to user with the `action` field guidance
- If error occurs mid-rebalance (after withdraw but before deposit), immediately alert operator with remaining funds location

## On success
- Confirm the on-chain result (tx hashes for both withdraw and deposit)
- Report old bins vs new bins comparison
- Show estimated fee improvement
- Update last-rebalance timestamp for cooldown tracking
- Report completion with summary including gas spent
