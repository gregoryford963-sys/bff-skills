#!/usr/bin/env bun
/**
 * nostr-agent-broadcaster.ts — Publish agent DeFi activity to Nostr relays
 *
 * Usage:
 *   bun run nostr-agent-broadcaster.ts publish --message "<text>" [--relays <url,...>]
 *   bun run nostr-agent-broadcaster.ts status [--relays <url,...>]
 *   bun run nostr-agent-broadcaster.ts install-packs
 */

import { program } from "commander";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

// ── Types ───────────────────────────────────────────────────────────────────

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface RelayResult {
  relay: string;
  status: "ok" | "error" | "timeout";
  message?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function getEventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return sha256(serialized);
}

async function pingRelay(
  relayUrl: string,
  timeoutMs = 5000
): Promise<RelayResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ relay: relayUrl, status: "timeout", message: "Connection timed out" });
    }, timeoutMs);

    try {
      const ws = new WebSocket(relayUrl);

      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve({ relay: relayUrl, status: "ok", message: "Relay reachable" });
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        resolve({
          relay: relayUrl,
          status: "error",
          message: `WebSocket error: ${err}`,
        });
      };
    } catch (err) {
      clearTimeout(timer);
      resolve({
        relay: relayUrl,
        status: "error",
        message: `Failed to connect: ${err}`,
      });
    }
  });
}

async function publishToRelay(
  relayUrl: string,
  event: NostrEvent,
  timeoutMs = 8000
): Promise<RelayResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ relay: relayUrl, status: "timeout", message: "Publish timed out" });
    }, timeoutMs);

    try {
      const ws = new WebSocket(relayUrl);
      let resolved = false;

      ws.onopen = () => {
        ws.send(JSON.stringify(["EVENT", event]));
      };

      ws.onmessage = (msg: MessageEvent) => {
        if (resolved) return;
        clearTimeout(timer);
        resolved = true;
        ws.close();

        try {
          const data = JSON.parse(msg.data as string) as unknown[];
          const type = data[0] as string;
          if (type === "OK") {
            const accepted = data[2] as boolean;
            resolve({
              relay: relayUrl,
              status: accepted ? "ok" : "error",
              message: accepted ? "Event accepted" : (data[3] as string) ?? "Rejected",
            });
          } else {
            resolve({ relay: relayUrl, status: "ok", message: `Received: ${type}` });
          }
        } catch {
          resolve({ relay: relayUrl, status: "ok", message: "Response received" });
        }
      };

      ws.onerror = () => {
        if (resolved) return;
        clearTimeout(timer);
        resolved = true;
        resolve({ relay: relayUrl, status: "error", message: "WebSocket error" });
      };
    } catch (err) {
      clearTimeout(timer);
      resolve({ relay: relayUrl, status: "error", message: `Connect failed: ${err}` });
    }
  });
}

function buildUnsignedEvent(content: string, tags: string[][] = []): Omit<NostrEvent, "id" | "sig"> {
  return {
    pubkey: "0000000000000000000000000000000000000000000000000000000000000000",
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags,
    content,
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

program
  .name("nostr-agent-broadcaster")
  .description("Publish agent DeFi activity to Nostr relays");

program
  .command("publish")
  .description("Publish a text note to Nostr relays (unsigned, for status broadcasts)")
  .requiredOption("--message <text>", "Message content to publish")
  .option("--relays <urls>", "Comma-separated relay WebSocket URLs", DEFAULT_RELAYS.join(","))
  .option("--tags <json>", "JSON array of Nostr tags (e.g. [[\"t\",\"stacks\"]])", "[]")
  .action(async (options: { message: string; relays: string; tags: string }) => {
    const relayList = options.relays.split(",").map((r) => r.trim()).filter(Boolean);
    let tags: string[][] = [];
    try {
      tags = JSON.parse(options.tags) as string[][];
    } catch {
      // ignore bad tags
    }

    // Build unsigned event stub for preview
    const baseEvent = buildUnsignedEvent(options.message, tags);
    const eventId = getEventId(baseEvent);

    const results: RelayResult[] = [];
    for (const relay of relayList) {
      const result = await pingRelay(relay);
      results.push(result);
    }

    const reachable = results.filter((r) => r.status === "ok").length;

    console.log(
      JSON.stringify(
        {
          status: "ok",
          mode: "preview",
          note: "Unsigned broadcast preview — sign with a Nostr private key to publish live events",
          message: options.message,
          event_id_preview: eventId,
          relay_check: {
            checked: relayList.length,
            reachable,
            results,
          },
          tags,
          severity: reachable > 0 ? "ok" : "warn",
          summary: `${reachable}/${relayList.length} relays reachable for broadcast`,
        },
        null,
        2
      )
    );
  });

program
  .command("status")
  .description("Check connectivity to Nostr relays")
  .option("--relays <urls>", "Comma-separated relay WebSocket URLs", DEFAULT_RELAYS.join(","))
  .action(async (options: { relays: string }) => {
    const relayList = options.relays.split(",").map((r) => r.trim()).filter(Boolean);

    const results: RelayResult[] = [];
    for (const relay of relayList) {
      const result = await pingRelay(relay);
      results.push(result);
    }

    const reachable = results.filter((r) => r.status === "ok").length;

    console.log(
      JSON.stringify(
        {
          status: "ok",
          relays: results,
          summary: {
            checked: relayList.length,
            reachable,
            unreachable: relayList.length - reachable,
          },
          severity: reachable === 0 ? "error" : reachable < relayList.length ? "warn" : "ok",
        },
        null,
        2
      )
    );
  });

program
  .command("install-packs")
  .description("Check skill dependencies")
  .action(() => {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          dependencies: {
            bun: "required (runtime)",
            commander: "required (argument parsing)",
            WebSocket: "built-in (Bun global)",
            "node:crypto": "built-in (Node compat)",
          },
          note: "No additional packages required. Run with: bun run nostr-agent-broadcaster.ts",
        },
        null,
        2
      )
    );
  });

program.parse();
