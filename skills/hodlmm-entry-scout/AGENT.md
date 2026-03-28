---
name: hodlmm-entry-scout-agent
skill: hodlmm-entry-scout
description: Analyzes HODLMM pool conditions before an agent adds liquidity — returns ENTER/WAIT/AVOID signal with bin spread recommendation.
---

# Agent Behavior — HODLMM Entry Scout

## Decision order

1. Run `doctor` first. If API is unreachable, stop and surface the blocker — do not proceed to any liquidity action.
2. Run `entry-signal --pool-id <id>` for the target pool.
3. Route on `action` field:
   - `ENTER`: proceed to `optimal-bins` to get the recommended bin spread, then pass offsets to `bitflow add-liquidity-simple`.
   - `WAIT`: log the score breakdown and retry after the next price update (5 min).
   - `AVOID`: do not add liquidity; surface reason to operator with the score breakdown.
4. Run `optimal-bins --pool-id <id> --count <n>` only after receiving `ENTER` signal.
5. Pass the `recommendedOffsets` array to the LP entry skill as the bin configuration.

## Guardrails

- Never call `add-liquidity-simple` without a prior `ENTER` signal from this skill.
- Always confirm entry score is ≥ 65 before committing funds.
- If `entryScore` is between 65–70 (marginal ENTER), surface the breakdown and ask for operator confirmation before proceeding.
- Never expose wallet passwords or private keys in arguments or logs.
- If pool state changes between `entry-signal` and `add-liquidity-simple` (price crossed a bin), re-run `entry-signal` before retrying.

## On error

- Log the full error payload from stdout.
- Do not retry silently — surface the error to the operator.
- If `API error 503`, retry once after 30 seconds; if still failing, stop and surface as a blocker.
- If pool ID not found, run `scan-pools` to discover valid pool IDs.

## On success

- Log `entryScore`, `action`, and `recommendedOffsets`.
- Pass offsets to the LP entry workflow.
- Record the `activeBinId` at time of decision in state — if price moves more than 3 bins before execution, re-run.

## Output fields used downstream

| Field | Used for |
|-------|----------|
| `action` | Route to enter / wait / avoid |
| `entryScore` | Gate for marginal-ENTER confirmation |
| `recommendedOffsets` | Bin configuration for `add-liquidity-simple` |
| `activeBinId` | Staleness check before execution |
