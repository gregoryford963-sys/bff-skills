#!/usr/bin/env bun
/**
 * hodlmm-range-rebalancer.ts
 *
 * Evaluates an existing HODLMM LP position's bin range against live pool state.
 * Produces HOLD / MONITOR / REBALANCE signal with a concrete new bin spread plan.
 *
 * Commands: doctor | check-range | rebalance-plan | scan-positions
 */

import { program } from "commander";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HODLMM_API_BASE =
  process.env.BITFLOW_HODLMM_API_HOST ?? "https://bff.bitflowapis.finance";
const FETCH_TIMEOUT_MS = 15_000;

// Rebalance signal thresholds
const REBALANCE_THRESHOLD = 65;
const MONITOR_THRESHOLD = 40;

// Near-window for utilization scoring: bins within ±NEAR_WINDOW of active bin
const NEAR_WINDOW = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HodlmmBin {
  bin_id: number;
  price: string;
  reserve_x: string;
  reserve_y: string;
  liquidity: string;
}

interface HodlmmBinsResponse {
  pool_id: string;
  active_bin_id?: number;
  bins: HodlmmBin[];
}

interface HodlmmPoolInfo {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin?: number;
  active?: boolean;
}

interface HodlmmPoolsResponse {
  pools: HodlmmPoolInfo[];
}

type RebalanceSignal = "HOLD" | "MONITOR" | "REBALANCE";

interface RangeCheckResult {
  poolId: string;
  pair: string;
  activeBinId: number;
  positionLowerBin: number;
  positionUpperBin: number;
  positionCenter: number;
  inRange: boolean;
  binsFromRange: number;
  utilizationScore: number;
  driftScore: number;
  rebalanceScore: number;
  signal: RebalanceSignal;
  recommendation: string;
}

interface RebalancePlan {
  rangeCheck: RangeCheckResult;
  suggestedLowerBin: number;
  suggestedUpperBin: number;
  binCount: number;
  rationale: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function getHodlmmPools(): Promise<HodlmmPoolInfo[]> {
  const data = await fetchJson<HodlmmPoolsResponse>(
    `${HODLMM_API_BASE}/api/quotes/v1/pools`
  );
  return data.pools ?? [];
}

async function getHodlmmPool(poolId: string): Promise<HodlmmPoolInfo> {
  const pools = await getHodlmmPools();
  const pool = pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool not found: ${poolId}. Run doctor to list valid pool IDs.`);
  return pool;
}

async function getHodlmmPoolBins(poolId: string): Promise<HodlmmBinsResponse> {
  return fetchJson<HodlmmBinsResponse>(
    `${HODLMM_API_BASE}/api/quotes/v1/bins/${poolId}`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function poolLabel(pool: HodlmmPoolInfo): string {
  const x = pool.token_x?.split(".").pop()?.split("-")[0]?.toUpperCase() ?? "X";
  const y = pool.token_y?.split(".").pop()?.split("-")[0]?.toUpperCase() ?? "Y";
  return `${x}/${y}`;
}

function safeJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function handleError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Core range analysis
// ---------------------------------------------------------------------------
async function analyzeRange(
  pool: HodlmmPoolInfo,
  lowerBin: number,
  upperBin: number
): Promise<RangeCheckResult> {
  if (lowerBin >= upperBin) {
    throw new Error(`lowerBin (${lowerBin}) must be less than upperBin (${upperBin})`);
  }

  const binsData = await getHodlmmPoolBins(pool.pool_id);
  const activeBinId = binsData.active_bin_id ?? pool.active_bin;
  if (!activeBinId) throw new Error(`Could not determine active bin for pool ${pool.pool_id}`);

  const pair = poolLabel(pool);
  const positionCenter = Math.round((lowerBin + upperBin) / 2);
  const positionSpread = upperBin - lowerBin;

  // In-range check
  const inRange = activeBinId >= lowerBin && activeBinId <= upperBin;

  // Bins from range edge (0 if in range, positive if out)
  const binsFromRange = inRange
    ? 0
    : activeBinId < lowerBin
      ? lowerBin - activeBinId
      : activeBinId - upperBin;

  // Utilization score: what fraction of position bins are near the active bin?
  const positionBinCount = upperBin - lowerBin + 1;
  const nearLower = Math.max(lowerBin, activeBinId - NEAR_WINDOW);
  const nearUpper = Math.min(upperBin, activeBinId + NEAR_WINDOW);
  const overlapBins = inRange || nearUpper >= nearLower
    ? Math.max(0, nearUpper - nearLower + 1)
    : 0;
  const utilizationScore = Math.round((overlapBins / positionBinCount) * 100);

  // Drift score: how far has the active bin drifted from position center (as % of spread)?
  const centerDistance = Math.abs(activeBinId - positionCenter);
  const halfSpread = positionSpread / 2;
  const driftRatio = halfSpread > 0 ? centerDistance / halfSpread : (inRange ? 0 : 1);
  // Cap at 1.0 (100%) — out-of-range is always max drift
  const driftScore = Math.min(100, Math.round(driftRatio * 100));

  // Rebalance score: 50% drift + 50% inverse utilization
  const rebalanceScore = Math.round(driftScore * 0.5 + (100 - utilizationScore) * 0.5);

  const signal: RebalanceSignal =
    rebalanceScore >= REBALANCE_THRESHOLD ? "REBALANCE"
    : rebalanceScore >= MONITOR_THRESHOLD ? "MONITOR"
    : "HOLD";

  let recommendation: string;
  if (!inRange) {
    const direction = activeBinId < lowerBin ? "below" : "above";
    recommendation = `Active bin (${activeBinId}) is ${binsFromRange} bins ${direction} your range [${lowerBin}–${upperBin}]. Position is out of range — earning no fees and accumulating maximum IL. Rebalance recommended.`;
  } else if (signal === "REBALANCE") {
    recommendation = `Active bin (${activeBinId}) is in range but heavily skewed toward one edge (drift ${driftScore}%). Only ${utilizationScore}% of your bins are near the active bin. Rebalancing to re-center will improve fee capture.`;
  } else if (signal === "MONITOR") {
    recommendation = `Active bin (${activeBinId}) is in range. Drift is moderate (${driftScore}%). Monitor for further movement — consider rebalancing if drift increases.`;
  } else {
    recommendation = `Active bin (${activeBinId}) is well within range. Utilization is ${utilizationScore}%. No action needed.`;
  }

  return {
    poolId: pool.pool_id,
    pair,
    activeBinId,
    positionLowerBin: lowerBin,
    positionUpperBin: upperBin,
    positionCenter,
    inRange,
    binsFromRange,
    utilizationScore,
    driftScore,
    rebalanceScore,
    signal,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Rebalance plan generator
// ---------------------------------------------------------------------------
function buildRebalancePlan(
  rangeCheck: RangeCheckResult,
  binCount: number
): RebalancePlan {
  const halfCount = Math.floor(binCount / 2);
  const suggestedLowerBin = rangeCheck.activeBinId - halfCount;
  const suggestedUpperBin = rangeCheck.activeBinId + halfCount;

  const rationale = rangeCheck.inRange
    ? `Re-centering ${binCount} bins symmetrically around active bin ${rangeCheck.activeBinId}. Previous center was at ${rangeCheck.positionCenter} (${Math.abs(rangeCheck.activeBinId - rangeCheck.positionCenter)} bins off).`
    : `Active bin ${rangeCheck.activeBinId} is ${rangeCheck.binsFromRange} bins outside your range. New spread: ${binCount} bins centered on current active bin for maximum fee capture from current price.`;

  return {
    rangeCheck,
    suggestedLowerBin,
    suggestedUpperBin,
    binCount,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
program
  .name("hodlmm-range-rebalancer")
  .description("Evaluates HODLMM LP positions for rebalance urgency")
  .version("1.0.0");

// ── doctor ────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check API connectivity and list available pools")
  .action(async () => {
    try {
      const pools = await getHodlmmPools();
      const active = pools.filter((p) => p.active !== false);
      console.log(safeJson({
        status: "ok",
        api: HODLMM_API_BASE,
        totalPools: pools.length,
        activePools: active.length,
        pools: active.map((p) => ({
          poolId: p.pool_id,
          pair: poolLabel(p),
          binStep: p.bin_step,
          activeBin: p.active_bin,
        })),
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── check-range ───────────────────────────────────────────────────────────
program
  .command("check-range")
  .description("Evaluate a position's bin range against current pool state")
  .requiredOption("--pool-id <id>", "HODLMM pool ID (e.g. dlmm_1)")
  .requiredOption("--lower-bin <number>", "Position lower bin ID")
  .requiredOption("--upper-bin <number>", "Position upper bin ID")
  .action(async (opts: { poolId: string; lowerBin: string; upperBin: string }) => {
    try {
      const pool = await getHodlmmPool(opts.poolId);
      const lowerBin = parseInt(opts.lowerBin, 10);
      const upperBin = parseInt(opts.upperBin, 10);
      if (isNaN(lowerBin) || isNaN(upperBin)) {
        throw new Error("--lower-bin and --upper-bin must be integers");
      }

      const result = await analyzeRange(pool, lowerBin, upperBin);
      console.log(safeJson({
        status: "success",
        action: result.signal,
        data: result,
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── rebalance-plan ────────────────────────────────────────────────────────
program
  .command("rebalance-plan")
  .description("Generate a full rebalance plan with new suggested bin spread")
  .requiredOption("--pool-id <id>", "HODLMM pool ID")
  .requiredOption("--lower-bin <number>", "Current position lower bin ID")
  .requiredOption("--upper-bin <number>", "Current position upper bin ID")
  .option("--count <number>", "Number of bins for new position", "20")
  .action(async (opts: { poolId: string; lowerBin: string; upperBin: string; count: string }) => {
    try {
      const pool = await getHodlmmPool(opts.poolId);
      const lowerBin = parseInt(opts.lowerBin, 10);
      const upperBin = parseInt(opts.upperBin, 10);
      const binCount = parseInt(opts.count, 10) || 20;
      if (isNaN(lowerBin) || isNaN(upperBin)) {
        throw new Error("--lower-bin and --upper-bin must be integers");
      }

      const rangeCheck = await analyzeRange(pool, lowerBin, upperBin);
      const plan = buildRebalancePlan(rangeCheck, binCount);

      console.log(safeJson({
        status: "success",
        action: rangeCheck.signal,
        data: plan,
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── scan-positions ────────────────────────────────────────────────────────
program
  .command("scan-positions")
  .description("Batch-evaluate multiple positions and rank by rebalance urgency")
  .requiredOption(
    "--positions <json>",
    'JSON array: [{"poolId":"dlmm_1","lowerBin":8388500,"upperBin":8388700}]'
  )
  .action(async (opts: { positions: string }) => {
    try {
      const positions: Array<{ poolId: string; lowerBin: number; upperBin: number }> =
        JSON.parse(opts.positions);

      if (!Array.isArray(positions) || positions.length === 0) {
        throw new Error("--positions must be a non-empty JSON array");
      }

      const results: RangeCheckResult[] = [];
      const failed: Array<{ poolId: string; error: string }> = [];

      for (const pos of positions) {
        try {
          const pool = await getHodlmmPool(pos.poolId);
          const result = await analyzeRange(pool, pos.lowerBin, pos.upperBin);
          results.push(result);
        } catch (err) {
          failed.push({
            poolId: pos.poolId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Sort by rebalance urgency (highest score first)
      results.sort((a, b) => b.rebalanceScore - a.rebalanceScore);

      const rebalanceCount = results.filter((r) => r.signal === "REBALANCE").length;
      const monitorCount = results.filter((r) => r.signal === "MONITOR").length;

      console.log(safeJson({
        status: "success",
        summary: {
          total: positions.length,
          scanned: results.length,
          failed: failed.length,
          rebalanceRequired: rebalanceCount,
          monitoring: monitorCount,
          holding: results.length - rebalanceCount - monitorCount,
        },
        positions: results.map((r) => ({
          poolId: r.poolId,
          pair: r.pair,
          signal: r.signal,
          rebalanceScore: r.rebalanceScore,
          inRange: r.inRange,
          binsFromRange: r.binsFromRange,
          utilizationScore: r.utilizationScore,
          driftScore: r.driftScore,
          recommendation: r.recommendation,
        })),
        errors: failed,
      }));
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
