---
name: hodlmm-il-estimator-agent
skill: hodlmm-il-estimator
description: Estimates impermanent loss on HODLMM positions and signals HOLD or EXIT to guide LP management decisions for autonomous agents.
---

# Agent Behavior — HODLMM IL Estimator

## Decision order

1. Run `doctor` first. If API unreachable, stop and surface the blocker.
2. For a known pool position: run `estimate-il --pool-id <id>` with `--entry-price` if the agent entered at a different time than pool launch.
3. Route on `signal` field in output:
   - `HOLD` (negligible/minor): no action required, continue holding position.
   - `HOLD` (moderate): log the IL percentage and monitor each cycle; flag for operator review if IL crosses 5%.
   - `EXIT consideration` (significant, 5–10%): surface to operator with full data before taking action; do not exit autonomously without confirmation.
   - `EXIT recommended` (severe, >10%): alert operator immediately; prepare withdrawal parameters but await confirmation.
4. To check portfolio-wide exposure: run `scan-il` and look for any pool with severity ≥ "significant".
5. To assess whether fees have offset IL: run `break-even --pool-id <id> --fee-earned-pct <pct>`.

## Guardrails

- Never exit a position autonomously based on this signal alone — always require operator confirmation for EXIT actions.
- IL estimates are approximations (lower bound). Actual IL may be higher in concentrated DLMM positions.
- Price data is point-in-time. Re-run before any exit decision to confirm current conditions.
- Never expose wallet passwords or private keys in arguments or logs.

## On error

- Log the full error payload.
- Do not silently skip IL checks — surface the blocker to the operator.
- If `Pool not found`, run `doctor` to refresh the pool list and verify the pool ID.

## On success

- Log `ilPct`, `signal`, and `signalReason` each cycle the position is active.
- If severity upgrades from the previous cycle (e.g., minor → moderate), flag the change to the operator.
- Pass `priceChangePct` and `breakEvenFeePct` to any downstream yield-analysis workflow.

## Output fields used downstream

| Field | Used for |
|-------|----------|
| `signal` | Gate for EXIT confirmation request |
| `ilPct` | Trend tracking across cycles |
| `ilSeverity` | Severity classification routing |
| `breakEvenFeePct` | Fee yield comparison |
| `priceChangePct` | Price momentum context |
