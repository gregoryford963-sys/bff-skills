---
name: hodlmm-depth-scout-agent
skill: hodlmm-depth-scout
description: Analyzes HODLMM pool liquidity depth and swap price impact to guide LP entry, exit, and trading decisions for autonomous agents.
---

# Agent Behavior — HODLMM Depth Scout

## Decision order

1. Run `doctor` first. If API unreachable, stop and surface the blocker.
2. For LP entry decisions: run `depth-check --pool-id <id>` to assess pool depth before adding liquidity.
   - SHALLOW (<30): avoid — fees unlikely to cover IL risk, large price impact on entry/exit.
   - MODERATE (30–59): proceed with smaller position size; monitor depth each cycle.
   - DEEP (≥60): favorable conditions for LP entry.
3. For swap execution: run `swap-impact --pool-id <id> --side <buy|sell> --amount <n>` before transacting.
   - LOW: proceed with the swap.
   - MEDIUM: proceed with caution; consider splitting into smaller orders.
   - HIGH: split order or delay — price impact is significant.
   - UNFILLABLE: pool lacks depth to fill the order; do not submit.
4. For portfolio-wide depth comparison: run `scan-depth` to rank all active pools.
5. Check `concentration` field:
   - `single-sided-y`: price has fallen significantly from entry — pool holds mostly quote token.
   - `single-sided-x`: price has risen significantly from entry — pool holds mostly base token.
   - `balanced`: price near entry — both tokens present; active LP region.

## Guardrails

- Depth and impact estimates are approximations. Do not rely solely on these for large transaction decisions.
- Re-run before each swap or LP action — depth changes with every block.
- Never expose wallet credentials in arguments or logs.

## On error

- Log the full error payload.
- If `Pool not found`, run `doctor` to refresh pool list.
- If API timeout (>30s), retry once then surface blocker to operator.

## On success

- Log `depthScore`, `depthSignal`, `concentration`, and `binsAboveActive`/`binsBelowActive` each cycle the LP position is active.
- If `depthSignal` downgrades from previous cycle (DEEP → MODERATE or MODERATE → SHALLOW), flag change to operator.
- Pass `binsConsumed` and `priceMovePercent` to downstream trading agents for execution planning.

## Output fields used downstream

| Field | Used for |
|-------|----------|
| `depthSignal` | LP entry/exit gate |
| `depthScore` | Cross-pool depth comparison |
| `concentration` | Position composition risk |
| `impactSignal` | Swap execution gate |
| `binsConsumed` | Order routing — split thresholds |
| `priceMovePercent` | Slippage budget tracking |
