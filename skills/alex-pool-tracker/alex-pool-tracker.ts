#!/usr/bin/env bun
/**
 * alex-pool-tracker.ts — Read-only monitor for ALEX Protocol liquidity pools
 *
 * Usage:
 *   bun run alex-pool-tracker.ts pools [--token <symbol>]
 *   bun run alex-pool-tracker.ts pool <pool-id>
 *   bun run alex-pool-tracker.ts install-packs
 */

import { program } from "commander";

// ── Config ──────────────────────────────────────────────────────────────────

const ALEX_API = "https://api.alexlab.co";

// ── Types ───────────────────────────────────────────────────────────────────

interface AlexPool {
  pool_id: string;
  token_x: string;
  token_y: string;
  pool_token: string;
  apy: number;
  tvl: number;
  volume_24h: number;
}

interface AlexPoolsResponse {
  pools?: AlexPool[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatToken(token: string): string {
  // Extract human-readable token name from contract identifier
  const parts = token.split("::");
  const name = parts[parts.length - 1];
  return name.replace(/-/g, " ").toUpperCase();
}

async function fetchPools(): Promise<AlexPool[]> {
  try {
    const res = await fetch(`${ALEX_API}/v1/pool_stats`);
    if (!res.ok) return [];
    const data = (await res.json()) as AlexPoolsResponse | AlexPool[];
    if (Array.isArray(data)) return data;
    return data.pools ?? [];
  } catch {
    return [];
  }
}

async function fetchPoolById(poolId: string): Promise<AlexPool | null> {
  try {
    const res = await fetch(`${ALEX_API}/v1/pool_stats/${encodeURIComponent(poolId)}`);
    if (!res.ok) return null;
    return (await res.json()) as AlexPool;
  } catch {
    return null;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

program
  .name("alex-pool-tracker")
  .description("Read-only ALEX Protocol liquidity pool monitor");

program
  .command("pools")
  .description("List all ALEX pools sorted by APY")
  .option("--token <symbol>", "Filter pools by token symbol (e.g. sBTC, STX)")
  .action(async (options: { token?: string }) => {
    const raw = await fetchPools();

    const pools = raw
      .filter((p) => {
        if (!options.token) return true;
        const filter = options.token.toLowerCase();
        return (
          p.token_x.toLowerCase().includes(filter) ||
          p.token_y.toLowerCase().includes(filter)
        );
      })
      .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
      .slice(0, 20);

    if (pools.length === 0) {
      console.log(
        JSON.stringify(
          {
            status: "ok",
            pools: [],
            count: 0,
            note: options.token
              ? `No pools found containing token: ${options.token}`
              : "No pools returned from ALEX API",
          },
          null,
          2
        )
      );
      return;
    }

    const topPool = pools[0];
    const totalTvl = pools.reduce((sum, p) => sum + (p.tvl ?? 0), 0);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          filter: options.token ?? null,
          pools: pools.map((p) => ({
            pool_id: p.pool_id,
            pair: `${formatToken(p.token_x)} / ${formatToken(p.token_y)}`,
            apy_pct: typeof p.apy === "number" ? Number(p.apy.toFixed(2)) : null,
            tvl_usd: typeof p.tvl === "number" ? Number(p.tvl.toFixed(0)) : null,
            volume_24h_usd:
              typeof p.volume_24h === "number"
                ? Number(p.volume_24h.toFixed(0))
                : null,
          })),
          count: pools.length,
          summary: {
            top_apy_pool: topPool.pool_id,
            top_apy_pct: typeof topPool.apy === "number" ? Number(topPool.apy.toFixed(2)) : null,
            total_tvl_usd: Number(totalTvl.toFixed(0)),
          },
          severity: "ok",
        },
        null,
        2
      )
    );
  });

program
  .command("pool <pool-id>")
  .description("Show details for a specific ALEX pool")
  .action(async (poolId: string) => {
    const pool = await fetchPoolById(poolId);

    if (!pool) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            pool_id: poolId,
            error: "Pool not found or ALEX API unavailable",
            severity: "error",
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          status: "ok",
          pool_id: pool.pool_id,
          pair: `${formatToken(pool.token_x)} / ${formatToken(pool.token_y)}`,
          token_x: pool.token_x,
          token_y: pool.token_y,
          pool_token: pool.pool_token,
          apy_pct: typeof pool.apy === "number" ? Number(pool.apy.toFixed(2)) : null,
          tvl_usd: typeof pool.tvl === "number" ? Number(pool.tvl.toFixed(0)) : null,
          volume_24h_usd:
            typeof pool.volume_24h === "number"
              ? Number(pool.volume_24h.toFixed(0))
              : null,
          severity: "ok",
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
            fetch: "built-in (Bun global)",
          },
          note: "No additional packages required. Run with: bun run alex-pool-tracker.ts",
        },
        null,
        2
      )
    );
  });

program.parse();
