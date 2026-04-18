---
name: hodlmm-harvest-loop
description: "Detects accrued HODLMM LP fees, harvests when cost-effective, and redeploysliquidity to compound yield."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter (369SunRay)"
  user-invocable: "false"
  arguments: "doctor | scan | run"
  entry: "hodlmm-harvest-loop/hodlmm-harvest-loop.ts"
  requires: "wallet, hodlmm-bin-guardian, hodlmm-move-liquidity, bitflow"
  tags: "defi, hodlmm, yield, write, mainnet-only, hodlmm-bonus"
---

# HODLMM Harvest Loop

## What it does

Detects accrued fees in HODLMM LP positions and executes a harvest-and-compound cycle: withdraw liquidity (collecting accrued fees) → rebalance tokens to target ratio → redeploy into the active bin.

In HODLMM (Discretized Liquidity Market Maker), fees accrue directly into bin reserves as swaps flow through active bins. When swap volume passes through your bin, both `reserve_x` and `reserve_y` of that bin grow proportionally to your DLP share. There is no separate `claim-fees` function — the only way to realize accrued fees is to withdraw liquidity, which returns the grown bin value to your wallet.

The harvest decision is cost-effective: if `current_bin_value - deposit_baseline > min_reinvest_sats`, proceed. Otherwise, wait for more fee accrual to offset gas costs.

## Architecture

Fee accrual mechanism:
1. A swap through your bin increases `reserve_x` or `reserve_y` of that bin.
2. Your DLP shares represent a fixed proportion of the bin's total DLP supply.
3. As the bin reserves grow via fee accrual, `user_value = reserve * (user_dlp / total_dlp)` increases.
4. Withdrawal returns this grown value — the difference from your deposit baseline is realized profit.

Harvest cycle:
1. **Scan**: Compare current bin value vs. deposit baseline from state file. Estimate gas.
2. **Decide**: If accrued fees > min-reinvest threshold and gas is affordable, proceed.
3. **Withdraw**: Call `withdraw-relative-liquidity-same-multi` on the DLMM router to pull all liquidity.
4. **Rebalance** (optional): If token ratio is off-target, get a Bitflow quote and swap to rebalance.
5. **Redeploy**: Call `move-relative-liquidity-multi` (via hodlmm-move-liquidity) to put capital back in range.
6. **Record**: Update state file with new deposit baseline and harvest timestamp.

## Why agents need it

Every HODLMM monitoring skill can detect fee accrual — but none of them close the loop. An agent running `hodlmm-bin-guardian` or `hodlmm-pulse` knows that fees have built up, but can't act on that knowledge. Capital sits in bins earning more fees that never get compounded.

This skill closes the loop. The `scan` command detects accrued fees and evaluates harvest cost-effectiveness. The `run` command executes the full withdraw-rebalance-redeploy cycle autonomously. An agent running this skill compounds yield continuously without human intervention.

## Commands

### doctor

```bash
bun run hodlmm-harvest-loop/hodlmm-harvest-loop.ts doctor
```

### scan

```bash
bun run hodlmm-harvest-loop/hodlmm-harvest-loop.ts scan --wallet SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
bun run hodlmm-harvest-loop/hodlmm-harvest-loop.ts scan --pool-id dlmm_1 --wallet SP3...
```

### run

```bash
# Dry-run (default — no on-chain action)
bun run hodlmm-harvest-loop/hodlmm-harvest-loop.ts run --pool-id dlmm_1 --wallet SP3...

# Execute harvest
bun run hodlmm-harvest-loop/hodlmm-harvest-loop.ts run \
  --pool-id dlmm_1 \
  --wallet SP3... \
  --min-reinvest-sats 5000 \
  --target-ratio 50:50 \
  --confirm=HARVEST \
  --password <pass>
```

## Output contract

All commands emit JSON to stdout:
- Success: `{ "status": "success", "action": "...", "data": {...}, "error": null }`
- Error: `{ "error": "descriptive message" }` + `process.exit(1)`

## Safety notes

- 4-hour cooldown per pool between harvests
- `--confirm=HARVEST` required (exact string) to execute
- Slippage: rebalance swap minimum-output = quote × 0.97 (3% max)
- Never broadcasts if withdraw simulation would fail
- Gas check: requires ≥1 STX
- State file: `~/.hodlmm-harvest-state.json`
