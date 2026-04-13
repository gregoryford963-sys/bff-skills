---
name: zest-borrow-manager
description: "Computes safe STX borrow capacity against sBTC collateral on Zest Protocol v2, enforces health factor guardrails, and outputs the borrow command for agent execution."
metadata:
  author: "gregoryford963-sys"
  author-agent: "Amber Otter (369SunRay)"
  user-invocable: "false"
  arguments: "doctor | status | borrow | auto"
  entry: "zest-borrow-manager/zest-borrow-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# zest-borrow-manager

## What it does

Reads live collateral and borrow state from Zest Protocol v2 on Stacks mainnet, computes the maximum STX that can be borrowed against sBTC collateral while keeping the health factor above a configurable floor, and emits a structured `mcpCommand` for the agent to execute. This is the borrow-initiation counterpart to `zest-auto-repay` — together they close the full supply → borrow → repay loop on Zest. All writes are delegated to the `zest_borrow` MCP tool; this skill never broadcasts transactions directly.

## Why agents need it

Agents managing leveraged sBTC positions need to:

1. **Calculate safe borrow capacity** — raw LTV math is not enough; health factor must account for liquidation thresholds (not just LTV) and projected post-borrow state
2. **Enforce health factor floors** — borrowing to the protocol maximum is suicidal; agents need a configurable buffer (default: HF >= 2.0 post-borrow, never below 1.5)
3. **Manage leverage cycles** — when collateral value rises, agents can borrow additional STX for yield strategies, compounding, or liquidity without manual intervention
4. **Prevent over-borrowing** — daily spend caps and per-operation caps prevent a runaway feedback loop

Without this skill, an agent cannot safely initiate borrows — it can only defend existing positions (repay) or supply more collateral, leaving potential yield untapped.

## Safety notes

This skill **WRITES to chain** via the `zest_borrow` MCP tool. Every borrow command output includes a full `safetyChecks` block that must pass before the agent executes.

| Control | Value | Enforced |
|---------|-------|----------|
| Hard cap per borrow | 500,000 ustx equivalent | Cannot be overridden |
| Hard cap per day | 1,000,000 ustx equivalent | Cannot be overridden |
| Minimum health factor after borrow | 1.5 | Hard floor — borrow blocked below this |
| Target health factor after borrow | 2.0 | Default target (configurable 1.6–3.0) |
| Cooldown between borrows | 900 seconds (15 min) | Enforced via persistent ledger |
| Minimum STX reserve for gas | 500,000 ustx | Never borrow if gas reserve breached |
| `--confirm` gate | Required for borrow/auto | Skill returns plan without executing unless flag is set |

The `auto` command suggests borrows (HF > 3.0, no borrow in 24h) but never executes without `--confirm`.

## Commands

### `doctor`

Checks wallet unlock, STX gas balance, Zest API reachability, and existing sBTC collateral position. Safe to run anytime — read-only.

```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts doctor
```

### `status`

Reads live position data: collateral sats, current borrow balance, health factor, LTV, and safe borrow capacity at the configured target HF.

```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts status
```

### `borrow`

Computes a safe borrow plan and outputs the `mcpCommand` for agent execution. Requires `--confirm` to emit the executable command (without it, outputs a dry-run preview).

```bash
# Dry-run: shows borrow plan, no mcpCommand emitted
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow

# Execute: emits mcpCommand for agent
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow --confirm

# Borrow a specific amount (capped at safety limits)
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow --amount 5000000 --confirm

# Override target health factor (must be >= 1.6)
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow --target-hf 2.5 --confirm
```

### `auto`

Monitoring loop. Every 5 minutes, checks if health factor exceeds 3.0 AND no borrow has been made in the last 24 hours. If both conditions hold, outputs a borrow suggestion. With `--confirm`, executes the borrow.

```bash
# Monitor and suggest (no writes)
bun run skills/zest-borrow-manager/zest-borrow-manager.ts auto

# Monitor and auto-execute when conditions are met
bun run skills/zest-borrow-manager/zest-borrow-manager.ts auto --confirm
```

## Output contract

All commands output structured JSON to stdout.

**Success (borrow plan ready):**
```json
{
  "status": "success",
  "action": "borrow-ready",
  "data": {
    "borrowPlan": {
      "asset": "wSTX",
      "borrowAmountUstx": 12345678,
      "borrowAmountStx": "12.345678",
      "currentHealthFactor": 3.5,
      "projectedHealthFactor": 2.0,
      "collateralSats": 62081,
      "ltv": "75%"
    },
    "mcpCommand": {
      "tool": "zest_borrow",
      "params": {
        "asset": "wSTX",
        "amount": "12345678"
      }
    },
    "safetyChecks": {
      "healthFactorAboveFloor": true,
      "withinPerBorrowCap": true,
      "withinDailyCap": true,
      "cooldownRespected": true,
      "reservePreserved": true
    }
  },
  "error": null
}
```

**Blocked (safety check failed):**
```json
{
  "status": "blocked",
  "action": "borrow-blocked",
  "data": null,
  "error": {
    "code": "health_factor_too_low",
    "message": "Projected HF 1.3 would fall below floor 1.5 — borrow rejected",
    "next": "Wait for collateral value to increase or reduce borrow amount"
  }
}
```

**Dry-run (no `--confirm` flag):**
```json
{
  "status": "success",
  "action": "borrow-preview",
  "data": {
    "borrowPlan": { "...": "..." },
    "note": "Dry-run mode — add --confirm to emit mcpCommand"
  },
  "error": null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `no_wallet` | Wallet not unlocked or STACKS_ADDRESS not set |
| `no_collateral` | No sBTC collateral position found in Zest |
| `health_factor_too_low` | Projected HF would fall below 1.5 floor |
| `exceeds_per_borrow_cap` | Amount exceeds 500,000 ustx hard cap |
| `exceeds_daily_cap` | Daily borrow cap already reached |
| `cooldown_active` | Must wait before next borrow |
| `insufficient_gas_reserve` | STX balance too low for gas |
| `api_unreachable` | Zest Protocol API not responding |
| `no_borrow_capacity` | Health factor math yields zero safe borrow |

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Agent wallet | `SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW` |
| Zest position | 62,081 zsbtc tokens (active collateral supply) |
| Protocol TVL | ~45 BTC in Zest Protocol at time of submission |
| Agent identity | Amber Otter (369SunRay) — ERC-8004 registered on aibtc.com |
| BTC address | `bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn` |
| Explorer | [View on Hiro](https://explorer.hiro.so/address/SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW?chain=mainnet) |

The agent operating this skill has an **active zsbtc position** — this is a real position manager, not a demo.

## Architecture

```
Agent invokes skill
  -> doctor: wallet check, gas check, API reachability, collateral detection
  -> status: fetch collateral + borrow balance, compute HF, compute safe capacity
  -> borrow: safety checks -> compute plan -> if --confirm, emit mcpCommand
  -> auto: 5-min loop -> check HF > 3.0 + 24h cooldown -> suggest/execute borrow
```

The skill separates **computation** (this file) from **execution** (MCP tool). The agent always sees the full safety check ledger before any on-chain write happens.

## Known constraints

- Zest Protocol v2 mainnet only — no testnet
- Borrows are denominated in wSTX (1 wSTX = 1 STX, 6 decimals)
- Health factor is estimated from on-chain reserve data; oracle prices can move between check and execution
- The `auto` command's 5-minute polling loop is blocking — run in a background process for daemon use
- STX gas is required separately from the borrowed amount
- Interest accrues on existing borrows — HF can decrease between cycles without new borrows
- Liquidation threshold on Zest v2 sBTC positions is ~85% LTV; this skill targets HF >= 2.0 (50% LTV equivalent) by default
