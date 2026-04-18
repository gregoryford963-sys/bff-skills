---
name: hodlmm-inventory-balancer
skill: hodlmm-inventory-balancer
description: "Autonomous HODLMM inventory balancer — monitors token ratio drift and corrects via swap-rebalance when threshold exceeded."
---

# Agent Behavior — HODLMM Inventory Balancer

## Decision order

### Manual rebalance (`run`)

1. Run `doctor` to verify API and wallet readiness. If any check fails, stop and surface the blocker.
2. Run `scan` (with optional `--threshold <pct>` and `--pool-id`) to evaluate current drift across all HODLMM positions.
3. For each pool where `rebalance_recommended` is `true`, run `run --dry-run` to preview the full rebalance plan.
4. Present the plan to the operator: current ratio, drift %, swap direction and amount, expected slippage, gas cost.
5. Only proceed with `--password <pass>` (no dry-run) after explicit operator approval.
6. After execution, record the transaction ID and confirm via explorer link.

### Autonomous rebalance loop

1. Run `doctor` to verify readiness.
2. Schedule `scan` on a regular interval (e.g. every 2 hours) to check for ratio drift.
3. When `scan` returns `rebalance_recommended: true` for a pool, automatically execute `run --password <pass>`.
4. Respect the 2-hour cooldown enforced by the state file.
5. Log all rebalances in the agent journal with txids and drift values.

## Guardrails

- **Slippage protection.** Pre-simulate swap via `alex_get_swap_quote` before broadcasting. If simulated slippage > 1%, abort and report.
- **Drift gate.** Only rebalance when drift exceeds threshold (default 5%). Skip otherwise to avoid churn.
- **Cooldown enforced.** 2 hours between rebalances per pool. Do not bypass state file cooldown.
- **Gas check.** Requires >= 1 STX in wallet before executing any on-chain action.
- **Dry-run default.** Running without `--password` always produces a dry-run — no broadcast occurs.

## On error

- Emit `{ "error": "descriptive message" }` JSON and exit with code 1.
- Do not retry automatically — surface the error to the operator.
- Common errors: wallet decryption failure, cooldown active, drift below threshold, slippage exceeded, API timeout, no live position found (scan will use SIMULATION MODE).

## On success

- Report transaction ID with explorer link.
- Show before/after token ratios and drift values.
- Confirm new rebalance record written to state file.
- Note cooldown: next rebalance available after 2 hours.

## Simulation mode

When no live HODLMM position is detected, `scan` automatically falls back to SIMULATION MODE using mock data. This is clearly labeled in output and useful for:
- Testing the skill in a fresh wallet
- Demonstrating logic to operators before capital is deployed
- CI validation without requiring an active position

## State file

`~/.hodlmm-balancer-state.json` — tracks per-pool rebalance history and drift snapshots. Do not manually edit during an active rebalance cycle.
