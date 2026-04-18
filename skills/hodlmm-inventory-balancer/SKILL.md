---
name: hodlmm-inventory-balancer
description: "Detects token ratio drift in HODLMM LP positions and rebalances via Bitflow swaps when drift exceeds threshold."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter (369SunRay)"
  user-invocable: "false"
  arguments: "doctor | scan | run [--threshold <pct>] [--dry-run]"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  requires: "wallet, hodlmm-move-liquidity, bitflow, alex"
  tags: "defi, hodlmm, rebalance, write, mainnet-only, hodlmm-bonus"
---

# HODLMM Inventory Balancer

## What it does

Monitors token ratio drift in HODLMM LP positions and automatically corrects via Bitflow/ALEX swaps when the ratio drifts beyond a configurable threshold (default 5%).

In a 50/50 HODLMM pool, impermanent divergence and bin-boundary crossings cause the value held in token X vs token Y to shift. When the ratio drifts significantly, capital efficiency drops — one side sits idle while the other side is fully deployed. Correcting the ratio before redeploying liquidity maximizes fee generation.

## Drift-correction loop

1. **Scan**: Fetch the user's HODLMM position (active bins, DLP shares, reserve values). Compute the current effective token ratio (token_x value / token_y value, normalized to the same unit via active-bin price). Calculate drift % = |current_ratio - 1.0| * 100.
2. **Gate**: If drift < threshold (default 5%), no action needed. Report clean.
3. **Quote**: Call `alex_get_swap_quote` (or Bitflow quotes endpoint) to determine the swap amount and expected output for rebalancing. Abort if simulated slippage > 1%.
4. **Execute**: Issue the swap via ALEX router or Bitflow. Wait for confirmation.
5. **Record**: Write drift history and rebalance timestamp to `~/.hodlmm-balancer-state.json`.

## Commands

### doctor

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor
```

Checks: wallet config, Bitflow API, ALEX API, Hiro API, STX balance (for gas), state file status.

### scan

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts scan
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts scan --threshold 3
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts scan --pool-id dlmm_1
```

Read-only. Reports current ratio, drift %, and whether rebalance is recommended. Falls back to SIMULATION MODE with mock data when no live position is found — useful for testing and demo runs.

### run

```bash
# Dry-run (default — no on-chain action)
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run --dry-run

# Execute rebalance
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --threshold 5 \
  --pool-id dlmm_1 \
  --password <wallet-pass>
```

Runs scan, then if drift > threshold: pre-simulates the swap, checks slippage, executes the rebalance. Requires `--password` to unlock the wallet for on-chain execution.

## Safety model

- **Slippage protection**: Swap is aborted if simulated slippage > 1% (checked via pre-quote before broadcast).
- **Drift gate**: Only rebalances when drift exceeds threshold — avoids churn on stable positions.
- **Dry-run default**: Without explicit `--password` the run command always dry-runs.
- **Cooldown**: 2-hour cooldown per pool to prevent over-trading on volatile conditions.
- **Gas check**: Requires ≥1 STX before any on-chain action.
- **State file**: `~/.hodlmm-balancer-state.json` — tracks last rebalance timestamp and drift history.

## Output contract

All commands emit JSON to stdout:
- Success: `{ "status": "success", "action": "...", "data": {...}, "error": null }`
- Error: `{ "error": "descriptive message" }` + `process.exit(1)`
