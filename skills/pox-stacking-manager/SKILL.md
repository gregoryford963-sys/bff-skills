---
name: pox-stacking-manager
description: "Autonomous PoX stacking manager — reads the next-cycle floor, compares to STX balance, and routes to solo stacking or Pillar FastPool delegation with mandatory confirmation and spend guardrails."
metadata:
  author: "gregoryford963-sys"
  author_agent: "Amber Otter"
  user-invocable: "true"
  arguments: "doctor | status | run | install-packs"
  entry: "pox-stacking-manager/pox-stacking-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, infrastructure"
---

# PoX Stacking Manager

## What it does

Reads live PoX cycle data from Stacks mainnet, compares the next-cycle minimum stacking threshold against the wallet's available STX balance, and routes to the optimal stacking strategy: **solo stacking** (via `pox-4 stack-stx`) if balance exceeds the floor, or **pool delegation** (via Pillar FastPool v3) if it does not. All writes require explicit `--confirm` and respect configurable spend limits.

## Why agents need it

PoX floor changes every 2,100 blocks. Agents that hard-code a threshold miss windows when the floor drops (Cycle 133: 120K STX, down from 160K in Cycle 132). This skill polls the live floor each cycle and makes the routing decision automatically — preventing dead STX capital when the floor is achievable, and ensuring pool entry when it is not.

## Safety notes

- **Writes to chain.** `run --confirm` submits a live Stacks transaction.
- **Moves funds.** Stacking locks STX for the duration of the lock period.
- **Mainnet only.** All contracts are mainnet addresses.
- **Irreversible per cycle.** Stacked STX cannot be unlocked before the lock period expires.
- Gas reserve (5 STX minimum) is always retained — never stacked.
- Maximum stackable amount defaults to 90% of available balance. Pass `--max-amount` to override.

## Commands

### doctor
Checks wallet, STX balance, and pox-4 reachability. Safe to run anytime.
```bash
bun run skills/pox-stacking-manager/pox-stacking-manager.ts doctor
```

### status
Shows current cycle, next-cycle floor, wallet balance, current stacking status, and routing recommendation.
```bash
bun run skills/pox-stacking-manager/pox-stacking-manager.ts status
```

### run
Assess and execute stacking. Routes to solo or pool based on balance vs floor.
```bash
# Dry run (no --confirm = blocked output with proposed action)
bun run skills/pox-stacking-manager/pox-stacking-manager.ts run

# Execute pool delegation (Pillar FastPool v3)
bun run skills/pox-stacking-manager/pox-stacking-manager.ts run --action=pool --confirm

# Execute solo stacking (requires balance > floor + gas)
bun run skills/pox-stacking-manager/pox-stacking-manager.ts run --action=solo --cycles=1 --confirm

# With explicit spend cap
bun run skills/pox-stacking-manager/pox-stacking-manager.ts run --action=pool --max-amount=150000000000 --confirm
```

### install-packs
```bash
bun run skills/pox-stacking-manager/pox-stacking-manager.ts install-packs --pack all
```

## Output contract
All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "recommendation": "solo | pool | none",
    "mcp_command": { "tool": "...", "params": {} }
  },
  "error": null
}
```

## Known constraints

- Solo stacking in pox-4 requires a valid signer-key. Agents without a configured Taproot signer should use `--action=pool`.
- Pool delegation via FastPool locks for 1 cycle minimum. FastPool auto-renews unless revoked.
- `delegate-stx` is idempotent — calling it again extends the delegation amount if already delegated.
- Prepare phase starts ~100 blocks before reward phase. Stacking calls after prepare-phase start apply to the *next* cycle, not the current one.
