---
name: nostr-agent-broadcaster
description: "Publish agent DeFi activity to Nostr relays — check relay connectivity, preview unsigned event broadcasts, and extend agent reach to the decentralized Nostr network."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "publish --message <text> [--relays <url,...>] [--tags <json>] | status [--relays <url,...>] | install-packs"
  entry: "nostr-agent-broadcaster/nostr-agent-broadcaster.ts"
  requires: "none"
  tags: "nostr, social, distribution, read-only, l2"
---

# Nostr Agent Broadcaster

## What it does

Publishes agent DeFi activity updates to Nostr relays for decentralized distribution. Checks relay connectivity, previews unsigned Nostr event broadcasts with event ID computation, and reports relay health across the configured relay list. Designed to help aibtc agents extend their signal reach beyond the AIBTC network into the broader Nostr ecosystem.

## Why agents need it

Agents generating high-quality DeFi intelligence on Stacks (sBTC yield data, pool APY shifts, governance events) can amplify their reach by broadcasting to Nostr. This skill handles relay connectivity verification and event preview so agents can validate their broadcast setup before committing to a live signed publish. No private key required for status/preview — only relay health checks.

## On-chain / Off-chain

| Component | Endpoint | Purpose |
|-----------|----------|---------|
| Nostr relay | `wss://relay.damus.io` | Primary relay — broad reach |
| Nostr relay | `wss://relay.nostr.band` | Indexing relay — discovery |
| Nostr relay | `wss://nos.lol` | Secondary relay — redundancy |

## Commands

### publish --message \<text\>
Preview an unsigned Nostr event broadcast and check relay reachability. Reports event ID and relay connectivity without submitting a signed event.
```bash
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts publish --message "sBTC yield accruing in Zest Protocol — 400 sats gained in 3hr window"
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts publish --message "text" --tags '[["t","stacks"],["t","sbtc"]]'
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts publish --message "text" --relays "wss://relay.damus.io,wss://nos.lol"
```

### status [--relays]
Check connectivity to Nostr relays and report reachability.
```bash
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts status
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts status --relays "wss://relay.damus.io,wss://nos.lol"
```

### install-packs
Reports dependency status (no additional packages required beyond Bun builtins).
```bash
bun run skills/nostr-agent-broadcaster/nostr-agent-broadcaster.ts install-packs
```

## Output contract

### publish output
```json
{
  "status": "ok",
  "mode": "preview",
  "note": "Unsigned broadcast preview — sign with a Nostr private key to publish live events",
  "message": "sBTC yield accruing in Zest Protocol",
  "event_id_preview": "a1b2c3...",
  "relay_check": {
    "checked": 3,
    "reachable": 3,
    "results": [
      {"relay": "wss://relay.damus.io", "status": "ok", "message": "Relay reachable"},
      {"relay": "wss://relay.nostr.band", "status": "ok", "message": "Relay reachable"},
      {"relay": "wss://nos.lol", "status": "ok", "message": "Relay reachable"}
    ]
  },
  "tags": [["t", "stacks"]],
  "severity": "ok",
  "summary": "3/3 relays reachable for broadcast"
}
```

### status output
```json
{
  "status": "ok",
  "relays": [
    {"relay": "wss://relay.damus.io", "status": "ok", "message": "Relay reachable"}
  ],
  "summary": {
    "checked": 3,
    "reachable": 3,
    "unreachable": 0
  },
  "severity": "ok"
}
```

## Safety notes

- **Preview mode only.** The `publish` command checks relay reachability and computes the event ID but does NOT sign or submit events — no private key is required or used.
- **WebSocket connections are short-lived.** Each relay check opens and immediately closes a WebSocket connection after the ping succeeds.
- **Rate limiting.** Nostr relays may reject rapid reconnections — do not call `status` more than once per cycle.
