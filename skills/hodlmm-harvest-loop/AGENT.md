---
name: hodlmm-harvest-loop
skill: hodlmm-harvest-loop
description: "Autonomous HODLMM fee harvester — monitors LP fee accrual and compounds via withdraw-rebalance-redeploy."
---

# Agent Behavior — HODLMM Harvest Loop

## Decision order

### Manual harvest (`run`)

1. Run `doctor` to verify API and wallet readiness. If any check fails, stop and surface the blocker.
2. Run `scan --wallet <addr>` to identify pools with harvestable fee accrual.
3. For each pool where `harvest_recommended` is `true`, run `run --pool-id <id> --wallet <addr>` (dry-run) to preview the full harvest plan.
4. Present the plan to the operator: accrued fees, gas cost, rebalance swap if needed, expected outcome.
5. Only proceed with `--confirm=HARVEST --password <pass>` after explicit operator approval.
6. After execution, record the transaction IDs and verify via explorer links.

### Autonomous harvest loop

1. Run `doctor` to verify readiness.
2. Schedule `scan` on a regular interval (e.g. every 4 hours) to check for harvestable pools.
3. When `scan` returns `harvest_recommended: true` for a pool, automatically execute `run --confirm=HARVEST`.
4. Respect the 4-hour cooldown enforced by the state file.
5. Log all harvests in the agent journal with txids and fee amounts.

## Guardrails

- **`--confirm=HARVEST` required.** The exact string must be passed. Any other value or absence means dry-run only.
- **Cooldown enforced.** 4 hours between harvests per pool. Do not bypass state file cooldown.
- **Minimum threshold.** Default 5000 sats. If accrued fees < threshold + estimated gas, skip harvest — it's not cost-effective.
- **Slippage protection.** Rebalance swap minimum-output = quote × 0.97 (3% max slippage). If market has moved beyond this, abort the rebalance step.
- **Gas check.** Requires ≥1 STX in wallet before executing any on-chain action.
- **Never simulate failure.** If withdraw simulation returns `Err`, do not broadcast.

## On error

- Emit `{ "error": "descriptive message" }` JSON and exit with code 1.
- Do not retry automatically — surface the error to the operator.
- Common errors: wallet decryption failure, cooldown active, fees below threshold, API timeout, simulation failure.

## On success

- Report all transaction IDs with explorer links.
- Show before/after token balances.
- Confirm new deposit baseline recorded in state file.
- Note cooldown: next harvest available after 4 hours.

## State file

`~/.hodlmm-harvest-state.json` — tracks per-pool deposit baselines and harvest history. Do not manually edit during an active harvest cycle.
