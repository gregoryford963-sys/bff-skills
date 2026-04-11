---
name: nostr-agent-broadcaster-agent
skill: nostr-agent-broadcaster
description: Autonomous rules for broadcasting agent DeFi activity to Nostr — when to publish, relay health thresholds, and content guidelines for Nostr distribution.
---

# Nostr Agent Broadcaster — Agent Rules

## Prerequisites
- No wallet required — all operations are read-only (preview mode)
- Internet access to Nostr relay WebSocket endpoints
- Content to broadcast (DeFi signals, yield data, governance updates)

## Decision order

1. **Run `status` at session start** to confirm at least 1 relay is reachable before attempting publish
2. **Run `publish` after filing an aibtc.news signal** to extend reach to Nostr audience
3. **Skip broadcast if `reachable == 0`** — all relays unreachable, do not attempt publish
4. **Run `status` again if all relays show `timeout`** before declaring broadcast impossible
5. **Include relevant Nostr tags** (`["t","stacks"]`, `["t","sbtc"]`, `["t","bitcoin"]`) to reach DeFi audience

## Output routing

| Field | Condition | Agent action |
|-------|-----------|-------------|
| `severity: ok` | ≥1 relay reachable | Proceed with broadcast preview |
| `severity: warn` | Some relays unreachable | Broadcast anyway to reachable relays |
| `severity: error` | All relays down | Skip broadcast this cycle |
| `reachable == 0` | No relay available | Log and retry next cycle |
| `mode: preview` | Unsigned preview | Do not treat as a live Nostr post |

## Guardrails

- **Preview mode only** — this skill does NOT sign or submit events; integrate a Nostr signing skill for live publishing
- **Do not broadcast unverified data** — only publish content based on confirmed on-chain reads or approved aibtc.news signals
- **Do not call `status` more than once per cycle** — relay rate limits apply
- **Include disclosure** in broadcast content: `[369SunRay / aibtc]` so Nostr audiences can attribute source
- **Minimum content threshold** — do not broadcast status updates with no DeFi information value (e.g. "agent is running")

## Error handling

- `status: timeout` on all relays → Nostr network may be congested; skip this cycle, retry next
- `status: error` on one relay → Switch to backup relays (`nos.lol`, `relay.nostr.band`)
- Empty `results` array → Relay list configuration issue; check `--relays` parameter
