---
name: stackspot-lottery-joiner-agent
skill: stackspot-lottery-joiner
description: "Autonomous STX lottery pot manager — validates pot state, enforces spend limits, and outputs MCP broadcast parameters for joining Stackspot pots."
---

# Agent Behavior — Stackspot Lottery Joiner

## Decision order

1. Run `doctor` first. If `stx_gas.ok` is false, stop — surface the blocker.
2. Run `--action list` to identify open, non-locked pots.
3. Select target pot: prefer lowest-minimum open pot unless operator specifies.
4. Run `--action status --pot-name <name>` to confirm `isLocked: false`.
5. Run `--action join --pot-name <name> --amount <stx>` (dry run) and review output.
6. If `safety_checks_passed: true`, repeat with `--confirm` to get MCP params.
7. Pass `mcp_command.params` to the `stackspot_join_pot` MCP tool for broadcast.
8. Confirm txid in response and log.

## Guardrails

- **Never join a locked pot.** `isLocked: true` means stacking cycle in progress — STX can't be recovered until the cycle ends.
- **Never skip dry run.** Always run without `--confirm` first to verify safety checks pass.
- **Respect spend limit.** Default is 1,000 STX. If operator specifies a different limit, pass `--max-join-stx`.
- **Gas reserve.** If `gas_reserve_ok: false`, stop and surface the blocker — never join if it would leave the wallet unable to pay future gas.
- **One pot per cycle.** Do not join multiple pots in the same cycle. Record the join in STATE.md.

## Autonomous actions allowed

- `doctor` — always safe, no funds moved
- `run --action list` — always safe, read-only
- `run --action status` — always safe, read-only
- `run --action join` (without `--confirm`) — dry run, no funds moved

## Actions requiring explicit approval

- `run --action join --confirm` + `stackspot_join_pot` MCP broadcast — moves STX

## On error

- `status: "blocked"` with `code: "pot_locked"` → skip this pot, try another
- `status: "blocked"` with `code: "insufficient_gas"` → fund wallet and retry
- `status: "blocked"` with `code: "exceeds_limit"` → reduce `--amount` or raise `--max-join-stx`
- `status: "error"` → log the error payload, surface to operator, do not retry silently

## On success

- Confirm `txid` in MCP response
- Log pot name, amount, txid in `memory/journal.md`
- Update STATE.md: `last_pot_join: { pot, amount_stx, txid, cycle }`
- Do not join another pot until next stacking cycle
