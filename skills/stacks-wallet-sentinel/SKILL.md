---
name: stacks-wallet-sentinel
description: "Autonomous Stacks wallet health monitor — tracks STX/sBTC balances, detects nonce gaps and stuck transactions, fires actionable alerts, and triggers auto-remediation via nonce healing."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | watch [--address <stxAddr>] | heal [--address <stxAddr>] | install-packs"
  entry: "stacks-wallet-sentinel/stacks-wallet-sentinel.ts"
  requires: "wallet"
  tags: "monitoring, read, mainnet-only, l2"
---

# Stacks Wallet Sentinel

## What it does

Continuously monitors a Stacks wallet's operational health. On each run it checks STX and sBTC balances against configurable thresholds, queries the mempool for stuck or pending transactions, reads nonce state to detect gaps, and returns a structured JSON report with a severity level and an ordered list of actionable remediation steps. When a nonce gap is found it triggers the platform's `nonce_heal` tool to close it automatically.

## Why agents need it

Autonomous agents transact frequently. A single stuck transaction or nonce gap can silently block every subsequent transaction for hours. Without a sentinel, agents drain gas budget retrying failed calls or miss trading windows while their transaction queue is jammed. This skill surfaces the problem immediately and drives it to resolution.

## Safety notes

- **Primarily read-only.** `doctor` and `watch` call no write endpoints. Only `heal` submits transactions (via `nonce_heal`).
- **Heal is idempotent.** `nonce_heal` is safe to run repeatedly — it only submits if a gap exists.
- **Gas required for heal.** Nonce healing submits a zero-value STX self-transfer to fill the gap; costs ~300 uSTX. If gas is critically low, heal is blocked and reported.
- **Address defaults to active wallet.** Pass `--address` to monitor a different agent.
- **Mainnet only.** Mempool and nonce state are live chain data.

## Severity levels

| Level | Meaning |
|-------|---------|
| `ok` | All checks pass. Wallet is healthy. |
| `warn` | Non-critical issue: balance approaching threshold, slow mempool tx. |
| `critical` | Blocking issue: nonce gap detected, balance below operating floor, tx stuck 30+ min. |
| `error` | Could not read chain state — API unreachable or wallet missing. |

## Commands

### doctor
Full diagnostic: balances, nonce state, mempool transactions, circuit-breaker status. Read-only.
```bash
bun run skills/stacks-wallet-sentinel/stacks-wallet-sentinel.ts doctor
```

### watch
One-shot health check. Returns severity + remediation list. Use this in every agent cycle.
```bash
bun run skills/stacks-wallet-sentinel/stacks-wallet-sentinel.ts watch
bun run skills/stacks-wallet-sentinel/stacks-wallet-sentinel.ts watch --address SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
```

### heal
Detect and close nonce gaps by triggering `nonce_heal`. Reports the gap range and heal tx ID.
```bash
bun run skills/stacks-wallet-sentinel/stacks-wallet-sentinel.ts heal
```

### install-packs
Reports required dependencies: `@stacks/network`, `@stacks/transactions`.
```bash
bun run skills/stacks-wallet-sentinel/stacks-wallet-sentinel.ts install-packs --pack all
```

## Output contract

All output is JSON to stdout.

**Healthy wallet (`watch`):**
```json
{
  "status": "success",
  "severity": "ok",
  "action": "no_action_required",
  "data": {
    "address": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW",
    "balances": {
      "stx_ustx": 184998535,
      "sbtc_sats": 77602
    },
    "nonce": {
      "chain": 67,
      "mempool_max": 67,
      "gap": false
    },
    "mempool": {
      "pending_count": 0,
      "oldest_pending_ms": 0
    },
    "thresholds": {
      "stx_warn_ustx": 500000,
      "stx_critical_ustx": 100000,
      "sbtc_warn_sats": 10000,
      "sbtc_critical_sats": 1000
    },
    "alerts": []
  },
  "error": null
}
```

**Wallet with issues (`watch`):**
```json
{
  "status": "success",
  "severity": "critical",
  "action": "run_heal_to_close_nonce_gap",
  "data": {
    "address": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW",
    "balances": { "stx_ustx": 95000, "sbtc_sats": 77602 },
    "nonce": { "chain": 65, "mempool_max": 67, "gap": true, "gap_range": [66, 67] },
    "mempool": { "pending_count": 2, "oldest_pending_ms": 1850000 },
    "alerts": [
      { "level": "critical", "code": "nonce_gap", "message": "Nonce gap at 66-67 — transactions are stuck. Run heal." },
      { "level": "critical", "code": "low_stx", "message": "STX balance 95000 uSTX is below critical floor (100000 uSTX). Top up for gas." }
    ]
  },
  "error": null
}
```

**Heal result:**
```json
{
  "status": "success",
  "severity": "ok",
  "action": "nonce_gap_closed",
  "data": {
    "heal_result": {
      "gap_closed": true,
      "nonces_healed": [66],
      "txids": ["0x..."]
    }
  },
  "error": null
}
```

**Error:**
```json
{
  "status": "error",
  "severity": "error",
  "action": "check_api_connectivity",
  "data": {},
  "error": { "code": "api_unreachable", "message": "Hiro API returned 503", "next": "Retry in next cycle" }
}
```
