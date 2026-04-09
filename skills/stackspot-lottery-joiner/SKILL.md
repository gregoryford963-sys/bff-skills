---
name: stackspot-lottery-joiner
description: "Autonomous STX lottery pot manager on Stackspot.app — lists open pots, checks pot state on-chain, and joins pots with configurable STX amounts and safety limits."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | run --action list | run --action status --pot-name <name> | run --action join --pot-name <name> --amount <stx> --confirm | install-packs"
  entry: "stackspot-lottery-joiner/stackspot-lottery-joiner.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Stackspot Lottery Joiner

## What it does

Manages STX lottery pot participation on [Stackspot.app](https://stackspot.app). Agents can list all known pots with live on-chain state (pool value, lock status, participant counts), check individual pot configuration, and join an open pot by depositing a configurable amount of STX. All STX is returned to participants at the end of each stacking cycle — only the sBTC yield is distributed to the VRF-selected winner.

## Why agents need it

Stackspot pots let agents put idle STX to work earning sBTC yield without permanent lock-up. This skill automates the discovery-to-participation flow: reading on-chain pot state directly from the Stacks contract via Hiro API (no external service needed), enforcing spend limits, and blocking when conditions aren't met. Without it, agents have no automated way to identify joinable pots or verify the minimum deposit requirement before committing.

## Safety notes

- **Writes to chain.** `run --action join --confirm` submits a Stacks transaction.
- **Moves STX.** STX is locked in the pot contract until the stacking cycle ends.
- **`--confirm` required.** Without the flag, `join` outputs a dry-run preview — no transaction is submitted.
- **Spend limit enforced.** Default max join: 1,000 STX. Override with `--max-join-stx`.
- **Gas reserve.** Always retains 5 STX minimum for future gas. Blocked if reserve can't be maintained.
- **Mainnet only.** Stackspot contracts are deployed on Stacks mainnet.
- **Locked pots blocked.** Refuses to join a pot that is already locked (stacking cycle in progress).

## Commands

### doctor

Checks wallet readiness and verifies all three known Stackspot pot contracts are reachable on-chain.

```bash
STACKS_ADDRESS=<your-address> bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts doctor
```

Example output:
```json
{
  "status": "success",
  "action": "Environment ready. Run with --action=list to see open pots.",
  "data": {
    "checks": {
      "stx_gas": { "ok": true, "detail": "184998535 uSTX available" },
      "pots_reachable": { "ok": true, "detail": "3/3 pots reachable" }
    },
    "address": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW"
  },
  "error": null
}
```

### run --action list

Lists all known pots with live on-chain state — pool value, lock status, and minimum deposit.

```bash
STACKS_ADDRESS=<your-address> bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run --action list
```

Example output:
```json
{
  "status": "success",
  "action": "3 pots found. Use --action=status --pot-name <name> for details.",
  "data": {
    "pots": [
      {
        "name": "Genesis",
        "contract": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.Genesis",
        "minAmountStx": 20,
        "maxParticipants": 2,
        "potValueUstx": "40000000",
        "isLocked": false
      },
      {
        "name": "STXLFG",
        "contract": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG",
        "minAmountStx": 21,
        "maxParticipants": 100,
        "potValueUstx": "0",
        "isLocked": false
      }
    ]
  },
  "error": null
}
```

### run --action status --pot-name &lt;name&gt;

Reads full on-chain state for a specific pot.

```bash
STACKS_ADDRESS=<your-address> bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run --action status --pot-name STXLFG
```

### run --action join --pot-name &lt;name&gt; --amount &lt;stx&gt; [--confirm]

Dry-run (no `--confirm`): outputs transaction parameters without submitting.
Live (with `--confirm`): outputs MCP execution parameters for the agent framework to broadcast.

```bash
# Dry run — safe to call anytime
STACKS_ADDRESS=<your-address> bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run \
  --action join --pot-name STXLFG --amount 21

# Live execution (agent framework broadcasts via stackspot_join_pot MCP tool)
STACKS_ADDRESS=<your-address> bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run \
  --action join --pot-name STXLFG --amount 21 --confirm
```

Example dry-run output:
```json
{
  "status": "success",
  "action": "DRY RUN — Pass --confirm to execute. Joining STXLFG with 21 STX.",
  "data": {
    "dry_run": true,
    "pot_name": "STXLFG",
    "amount_stx": 21,
    "amount_ustx": 21000000,
    "contract": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG",
    "function": "join-pot",
    "gas_reserve_stx": 5,
    "safety_checks_passed": true
  },
  "error": null
}
```

Example confirmed output (ready for agent MCP broadcast):
```json
{
  "status": "success",
  "action": "Execute join via MCP stackspot_join_pot tool",
  "data": {
    "mcp_command": {
      "tool": "stackspot_join_pot",
      "params": {
        "contractName": "STXLFG",
        "amount": "21000000"
      }
    },
    "pre_checks_passed": {
      "pot_not_locked": true,
      "balance_sufficient": true,
      "gas_reserve_ok": true,
      "within_spend_limit": true
    }
  },
  "error": null
}
```

### install-packs

```bash
bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts install-packs
```

Output:
```json
{
  "status": "success",
  "data": { "command": "bun add @stacks/transactions @stacks/network" }
}
```

## Output contract

All outputs are strict JSON to stdout with the shape:
```json
{
  "status": "success | error | blocked",
  "action": "human-readable next step",
  "data": {},
  "error": null | { "code": "string", "message": "string", "next": "string" }
}
```

## Known constraints

- Only the three known pots (Genesis, BuildOnBitcoin, STXLFG) are listed; custom pots require passing `--pot-name SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.CustomPot`
- The actual on-chain broadcast uses the MCP `stackspot_join_pot` tool — the skill validates and prepares, the agent framework executes
- `get-pot-value` and `is-locked` are read via Hiro's `call-read-only` endpoint; these may be slightly stale in high-traffic periods
