#!/usr/bin/env bun
/**
 * AIBTC News Signal — Autonomous signal filing on aibtc.news
 *
 * Commands: doctor | run | install-packs
 * Actions (run):
 *   list-beats                        — show all available beat slugs
 *   file --beat <slug> --headline <h> [--body <b>] [--source <url> --source-title <t>]... [--tags <t,...>] [--confirm]
 *
 * Dry-run by default. Pass --confirm to emit MCP params for agent broadcast.
 * Built by 369SunRay — tested on mainnet.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const AIBTC_NEWS_API = "https://aibtc.com/api";
const MAX_HEADLINE_CHARS = 120;
const MAX_BODY_CHARS = 1000;
const MAX_SOURCES = 5;
const MAX_TAGS = 10;

// Known beats as of 2026-04-09 (verified via news_list_beats)
const KNOWN_BEATS: Record<string, string> = {
  "agent-economy":  "Agent Economy — autonomous agent financial activity",
  "agent-skills":   "Agent Skills — new skill releases and capabilities",
  "agent-social":   "Agent Social — agent-to-agent communication and presence",
  "agent-trading":  "Agent Trading — DeFi trades and swap activity by agents",
  "bitcoin-macro":  "Bitcoin Macro — BTC price, macro trends, on-chain data",
  "deal-flow":      "Deal Flow — investment, fundraising, partnerships",
  "distribution":   "Distribution — token distributions and airdrops",
  "governance":     "Governance — DAO votes, protocol proposals, parameter changes",
  "infrastructure": "Infrastructure — relay health, peg status, node ops",
  "onboarding":     "Onboarding — agent registration, identity, new participants",
  "quantum":        "Quantum — experimental and frontier protocol research",
  "security":       "Security — exploits, vulnerabilities, audit findings",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface Source {
  url: string;
  title: string;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(code: string, message: string, next: string): never {
  out({ status: "error", action: next, data: {}, error: { code, message, next } });
  process.exit(1);
}

function blocked(code: string, message: string, next: string): never {
  out({ status: "blocked", action: next, data: {}, error: { code, message, next } });
  process.exit(1);
}

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        // --source and --source-title can repeat
        if (key === "source" || key === "source-title") {
          const existing = result[key];
          result[key] = existing ? [...(Array.isArray(existing) ? existing : [existing]), val] : [val];
        } else {
          result[key] = val;
        }
      } else if (arg === "--confirm") {
        result["confirm"] = "true";
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        const key = arg.slice(2);
        const val = argv[++i];
        if (key === "source" || key === "source-title") {
          const existing = result[key];
          result[key] = existing ? [...(Array.isArray(existing) ? existing : [existing]), val] : [val];
        } else {
          result[key] = val;
        }
      } else {
        result[arg.slice(2)] = "true";
      }
    }
  }
  return result;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateBeat(slug: string): void {
  if (!KNOWN_BEATS[slug]) {
    const valid = Object.keys(KNOWN_BEATS).join(", ");
    fail("unknown_beat", `Beat "${slug}" is not a known beat slug.`, `Valid beats: ${valid}`);
  }
}

function validateHeadline(h: string): void {
  if (!h || h.trim().length === 0) fail("empty_headline", "Headline is required.", "Provide --headline");
  if (h.length > MAX_HEADLINE_CHARS) {
    fail("headline_too_long", `Headline is ${h.length} chars (max ${MAX_HEADLINE_CHARS}).`, "Shorten headline");
  }
}

function validateBody(b: string): void {
  if (b.length > MAX_BODY_CHARS) {
    fail("body_too_long", `Body is ${b.length} chars (max ${MAX_BODY_CHARS}).`, "Shorten body");
  }
}

function parseSources(args: Record<string, string | string[]>): Source[] {
  const urls = args["source"] ? (Array.isArray(args["source"]) ? args["source"] : [args["source"]]) : [];
  const titles = args["source-title"] ? (Array.isArray(args["source-title"]) ? args["source-title"] : [args["source-title"]]) : [];

  if (urls.length === 0) {
    fail("no_sources", "At least one source is required. Use --source <url> --source-title <title>.", "Add sources");
  }
  if (urls.length > MAX_SOURCES) {
    fail("too_many_sources", `Max ${MAX_SOURCES} sources allowed, got ${urls.length}.`, "Reduce sources");
  }
  if (titles.length < urls.length) {
    // Pad missing titles with hostname
    while (titles.length < urls.length) {
      try {
        titles.push(new URL(urls[titles.length]).hostname);
      } catch {
        titles.push(`Source ${titles.length + 1}`);
      }
    }
  }

  return urls.map((url, i) => ({ url, title: titles[i] || `Source ${i + 1}` }));
}

function parseTags(args: Record<string, string | string[]>): string[] {
  const raw = args["tags"];
  if (!raw) fail("no_tags", "At least one tag is required. Use --tags <tag1,tag2,...>.", "Add --tags");
  const tagStr = Array.isArray(raw) ? raw.join(",") : raw;
  const tags = tagStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) fail("no_tags", "Tags cannot be empty.", "Add --tags");
  if (tags.length > MAX_TAGS) fail("too_many_tags", `Max ${MAX_TAGS} tags, got ${tags.length}.`, "Reduce tags");
  return tags;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  // Check beats API reachability
  let beatsReachable = false;
  let beatCount = 0;
  try {
    const res = await fetch(`${AIBTC_NEWS_API}/news/beats`);
    if (res.ok) {
      const data = await res.json() as unknown[];
      beatCount = Array.isArray(data) ? data.length : 0;
      beatsReachable = beatCount > 0;
    }
  } catch {
    beatsReachable = false;
  }

  out({
    status: beatsReachable ? "success" : "error",
    action: beatsReachable
      ? `Beats API reachable (${beatCount} beats). Run with --action list-beats to see slugs.`
      : "Beats API unreachable. Check network connectivity.",
    data: {
      checks: {
        beats_api: {
          ok: beatsReachable,
          detail: beatsReachable ? `${beatCount} beats found` : "API returned no data",
        },
        known_beats_cached: {
          ok: true,
          detail: `${Object.keys(KNOWN_BEATS).length} beats in local cache`,
        },
      },
    },
    error: beatsReachable ? null : {
      code: "beats_unreachable",
      message: "Could not reach aibtc.news beats API",
      next: "Check connectivity or use cached beats via list-beats",
    },
  });
}

function cmdListBeats(): void {
  const beats = Object.entries(KNOWN_BEATS).map(([slug, description]) => ({ slug, description }));
  out({
    status: "success",
    action: `${beats.length} beats available. Use --beat <slug> to target one when filing.`,
    data: { beats },
    error: null,
  });
}

async function cmdFile(args: Record<string, string | string[]>): Promise<void> {
  const beat = (args["beat"] as string) || "";
  const headline = (args["headline"] as string) || "";
  const body = (args["body"] as string) || "";
  const confirm = args["confirm"] === "true";
  const disclosure = (args["disclosure"] as string) || "claude-sonnet-4-6, aibtc MCP tools";

  // Validate
  if (!beat) fail("no_beat", "Beat is required. Use --beat <slug>.", "Add --beat");
  validateBeat(beat);
  validateHeadline(headline);
  if (body) validateBody(body);
  const sources = parseSources(args);
  const tags = parseTags(args);

  const params = {
    beat_slug: beat,
    headline,
    ...(body ? { body } : {}),
    sources,
    tags,
    disclosure,
  };

  if (!confirm) {
    out({
      status: "success",
      action: `DRY RUN — Pass --confirm to execute. Filing "${headline}" on ${beat}.`,
      data: {
        dry_run: true,
        beat,
        beat_description: KNOWN_BEATS[beat],
        headline,
        body: body || null,
        sources,
        tags,
        disclosure,
        headline_length: headline.length,
        body_length: body.length,
        validation_passed: true,
      },
      error: null,
    });
    return;
  }

  // Confirmed — output MCP params for agent broadcast
  out({
    status: "success",
    action: "Execute signal filing via MCP news_file_signal tool",
    data: {
      mcp_command: {
        tool: "news_file_signal",
        params,
      },
      pre_checks_passed: {
        beat_valid: true,
        headline_length_ok: headline.length <= MAX_HEADLINE_CHARS,
        body_length_ok: !body || body.length <= MAX_BODY_CHARS,
        sources_ok: sources.length >= 1 && sources.length <= MAX_SOURCES,
        tags_ok: tags.length >= 1 && tags.length <= MAX_TAGS,
      },
    },
    error: null,
  });
}

function cmdInstallPacks(): void {
  out({
    status: "success",
    action: "No additional packages required — uses built-in fetch only.",
    data: { command: "# No install needed" },
    error: null,
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help") {
    out({
      status: "success",
      action: "Available commands: doctor | run --action <list-beats|file> | install-packs",
      data: {
        commands: {
          doctor: "Check beats API reachability",
          "run --action list-beats": "List all available beat slugs",
          "run --action file --beat <slug> --headline <h> [--body <b>] [--source <url> --source-title <t>]... [--tags <t,...>] [--confirm]":
            "File a signal (dry-run without --confirm)",
          "install-packs": "Show install command (no deps needed)",
        },
      },
      error: null,
    });
    return;
  }

  if (command === "doctor") {
    await cmdDoctor();
    return;
  }

  if (command === "install-packs") {
    cmdInstallPacks();
    return;
  }

  if (command === "run") {
    const args = parseArgs();
    const action = args["action"] as string;

    if (!action) {
      fail("no_action", "Action is required. Use --action <list-beats|file>.", "Add --action");
    }

    if (action === "list-beats") {
      cmdListBeats();
      return;
    }

    if (action === "file") {
      await cmdFile(args);
      return;
    }

    fail("unknown_action", `Unknown action "${action}". Valid: list-beats, file.`, "Check --action value");
  }

  fail("unknown_command", `Unknown command "${command}". Valid: doctor, run, install-packs.`, "Check command");
}

main().catch((err) => {
  console.error(JSON.stringify({
    status: "error",
    action: "Unexpected error",
    data: {},
    error: { code: "unexpected", message: String(err), next: "Check logs" },
  }));
  process.exit(1);
});
