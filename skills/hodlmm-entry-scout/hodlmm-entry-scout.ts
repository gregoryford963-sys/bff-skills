#!/usr/bin/env bun
/**
 * hodlmm-entry-scout — HODLMM LP entry condition analyzer
 *
 * Analyzes live HODLMM pool bin distributions to score entry conditions
 * and recommend optimal bin spreads before adding liquidity.
 *
 * Self-contained: uses Bitflow HODLMM API directly, no external dependencies beyond commander.
 * HODLMM bonus eligible: Yes — directly reads HODLMM pool and bin state.
 *
 * Usage: bun run skills/hodlmm-entry-scout/hodlmm-entry-scout.ts <subcommand> [options]
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HODLMM_API_BASE =
  process.env.BITFLOW_HODLMM_API_HOST ?? "https://bff.bitflowapis.finance";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HodlmmBinData {
  pool_id?: string;
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price?: string;
  liquidity?: string;
}

interface HodlmmPoolInfo {
  pool_id: string;
  amm_type?: string;
  active_bin: number;
  bin_step: number;
  token_x: string;
  token_y: string;
  pool_name?: string;
  pool_symbol?: string;
  active?: boolean;
  suggested?: boolean;
  sbtc_incentives?: boolean;
}

interface HodlmmBinListResponse {
  success?: boolean;
  pool_id?: string;
  active_bin_id?: number;
  total_bins?: number;
  bins: HodlmmBinData[];
}

interface HodlmmPoolsResponse {
  pools: HodlmmPoolInfo[];
}

interface EntryScores {
  depthScore: number;
  spreadScore: number;
  centralityScore: number;
  entryScore: number;
}

type EntryAction = "ENTER" | "WAIT" | "AVOID";

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

async function getHodlmmPoolBins(poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(
    `${HODLMM_API_BASE}/api/quotes/v1/bins/${poolId}`
  );
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

/**
 * Get bin liquidity as a number.
 * Uses the `liquidity` field if available. Falls back to reserve_x only —
 * summing reserve_x + reserve_y is dimensionally incorrect for cross-token pools
 * (e.g. STX/sBTC) where the two reserves have different denominations.
 */
function binLiquidity(bin: HodlmmBinData): number {
  if (bin.liquidity !== undefined) {
    const liq = Number(bin.liquidity);
    if (!isNaN(liq)) return liq;
  }
  // Use reserve_x as a single-denomination proxy; do not sum cross-token reserves.
  return parseFloat(bin.reserve_x) || 0;
}

/**
 * Depth score (0-100): measures how much liquidity surrounds the active bin.
 * High depth = good price support during entry. We look at bins within ±DEPTH_WINDOW.
 */
function computeDepthScore(
  bins: HodlmmBinData[],
  activeBinId: number,
  depthWindow = 10
): number {
  if (bins.length === 0) return 0;

  const totalLiq = bins.reduce((sum, b) => sum + binLiquidity(b), 0);
  if (totalLiq === 0) return 0;

  const nearLiq = bins
    .filter((b) => Math.abs(b.bin_id - activeBinId) <= depthWindow)
    .reduce((sum, b) => sum + binLiquidity(b), 0);

  const ratio = nearLiq / totalLiq;
  // Ideal: 30-70% of total liquidity near the active bin
  if (ratio >= 0.3 && ratio <= 0.7) return 100;
  if (ratio < 0.3) return Math.round((ratio / 0.3) * 100);
  // >70% = too concentrated near active bin
  return Math.round(100 - ((ratio - 0.7) / 0.3) * 50);
}

/**
 * Spread score (0-100): measures how many bins have meaningful liquidity.
 * Too few = high IL risk. Very many thin bins = high slippage.
 */
function computeSpreadScore(bins: HodlmmBinData[]): number {
  const liquidBins = bins.filter((b) => binLiquidity(b) > 0);
  const count = liquidBins.length;
  if (count === 0) return 0;

  // Optimal range: 20-200 liquid bins
  if (count >= 20 && count <= 200) return 100;
  if (count < 20) return Math.round((count / 20) * 100);
  if (count <= 500) return Math.round(100 - ((count - 200) / 300) * 30);
  return 70;
}

/**
 * Centrality score (0-100): how well-centered is the active bin in the liquid range?
 * Active bin near the edge of the distribution signals price is trending out of range.
 */
function computeCentralityScore(
  bins: HodlmmBinData[],
  activeBinId: number
): number {
  const liquidBinIds = bins
    .filter((b) => binLiquidity(b) > 0)
    .map((b) => b.bin_id)
    .sort((a, b) => a - b);

  if (liquidBinIds.length === 0) return 0;

  const minBin = liquidBinIds[0];
  const maxBin = liquidBinIds[liquidBinIds.length - 1];
  const range = maxBin - minBin;

  if (range === 0) return 50;

  const center = (minBin + maxBin) / 2;
  const deviation = Math.abs(activeBinId - center) / (range / 2);

  return Math.round(Math.max(0, 100 - deviation * 100));
}

/**
 * Compute all scores and composite entry score.
 * Weights: depth 40%, spread 30%, centrality 30%
 */
function computeScores(bins: HodlmmBinData[], activeBinId: number): EntryScores {
  const depthScore = computeDepthScore(bins, activeBinId);
  const spreadScore = computeSpreadScore(bins);
  const centralityScore = computeCentralityScore(bins, activeBinId);
  const entryScore = Math.round(
    depthScore * 0.4 + spreadScore * 0.3 + centralityScore * 0.3
  );
  return { depthScore, spreadScore, centralityScore, entryScore };
}

function scoreToAction(entryScore: number): EntryAction {
  if (entryScore >= 65) return "ENTER";
  if (entryScore >= 40) return "WAIT";
  return "AVOID";
}

function actionDescription(action: EntryAction, score: number): string {
  if (action === "ENTER")
    return `Entry conditions are favorable (score ${score}/100). Proceed with LP entry.`;
  if (action === "WAIT")
    return `Entry conditions are marginal (score ${score}/100). Wait for better distribution.`;
  return `Entry conditions are poor (score ${score}/100). Avoid adding liquidity now.`;
}

/**
 * Recommend bin offsets for adding N bins around the active bin.
 * Applies a slight tilt based on price momentum (active bin vs. distribution center).
 */
function recommendBinOffsets(
  bins: HodlmmBinData[],
  activeBinId: number,
  count: number
): number[] {
  const liquidBinIds = bins
    .filter((b) => binLiquidity(b) > 0)
    .map((b) => b.bin_id);

  const half = Math.floor(count / 2);

  if (liquidBinIds.length === 0) {
    return Array.from({ length: count }, (_, i) => i - half);
  }

  const center = (Math.min(...liquidBinIds) + Math.max(...liquidBinIds)) / 2;
  const momentum = activeBinId > center ? 1 : activeBinId < center ? -1 : 0;

  const offsets: number[] = [];
  const start = momentum === 1 ? -half + 1 : momentum === -1 ? -half - 1 : -half;

  for (let i = start; offsets.length < count; i++) {
    offsets.push(i);
  }

  return offsets;
}

// ---------------------------------------------------------------------------
// Pool label helper
// ---------------------------------------------------------------------------
function poolLabel(pool: HodlmmPoolInfo): string {
  if (pool.pool_symbol) return pool.pool_symbol;
  const x = pool.token_x.split(".").pop() ?? "?";
  const y = pool.token_y.split(".").pop() ?? "?";
  return `${x}/${y}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-entry-scout")
  .description(
    "Analyzes HODLMM pool bin distributions to score LP entry conditions and recommend optimal bin spreads."
  );

// ── doctor ──────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check API connectivity and list available HODLMM pools")
  .action(async () => {
    try {
      const pools = await getHodlmmPools();
      const activePools = pools.filter((p) => p.active !== false);
      printJson({
        status: "success",
        action: "ready",
        data: {
          apiReachable: true,
          apiBase: HODLMM_API_BASE,
          totalPools: pools.length,
          activePools: activePools.length,
          pools: activePools.map((p) => ({
            id: p.pool_id,
            pair: poolLabel(p),
            activeBin: p.active_bin,
            sbtcIncentives: p.sbtc_incentives ?? false,
          })),
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── scan-pools ───────────────────────────────────────────────────────────────
program
  .command("scan-pools")
  .description("Scan active HODLMM pools and rank by entry health score")
  .option("--limit <number>", "Max pools to scan", "8")
  .action(async (opts: { limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10) || 8;
      const pools = await getHodlmmPools();
      const targets = pools.filter((p) => p.active !== false).slice(0, limit);

      const results: Array<{
        poolId: string;
        pair: string;
        entryScore: number;
        action: EntryAction;
        activeBinId: number;
        liquidBins: number;
        sbtcIncentives: boolean;
      }> = [];

      for (const pool of targets) {
        try {
          const binsData = await getHodlmmPoolBins(pool.pool_id);
          const activeBinId = binsData.active_bin_id ?? pool.active_bin;
          const scores = computeScores(binsData.bins, activeBinId);
          results.push({
            poolId: pool.pool_id,
            pair: poolLabel(pool),
            entryScore: scores.entryScore,
            action: scoreToAction(scores.entryScore),
            activeBinId,
            liquidBins: binsData.bins.filter((b) => binLiquidity(b) > 0).length,
            sbtcIncentives: pool.sbtc_incentives ?? false,
          });
        } catch {
          // skip pools with API errors
        }
      }

      results.sort((a, b) => b.entryScore - a.entryScore);

      printJson({
        status: "success",
        action: results[0]?.action ?? "WAIT",
        data: {
          scannedPools: results.length,
          bestPool: results[0] ?? null,
          pools: results,
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── entry-signal ─────────────────────────────────────────────────────────────
program
  .command("entry-signal")
  .description("Return ENTER/WAIT/AVOID signal for a specific HODLMM pool")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [pool, binsData] = await Promise.all([
        getHodlmmPool(opts.poolId),
        getHodlmmPoolBins(opts.poolId),
      ]);

      const activeBinId = binsData.active_bin_id ?? pool.active_bin;
      const scores = computeScores(binsData.bins, activeBinId);
      const action = scoreToAction(scores.entryScore);
      const liquidBins = binsData.bins.filter((b) => binLiquidity(b) > 0);

      printJson({
        status: "success",
        action,
        data: {
          poolId: opts.poolId,
          pair: poolLabel(pool),
          activeBinId,
          binStep: pool.bin_step,
          totalBins: binsData.total_bins ?? binsData.bins.length,
          liquidBins: liquidBins.length,
          entryScore: scores.entryScore,
          depthScore: scores.depthScore,
          spreadScore: scores.spreadScore,
          centralityScore: scores.centralityScore,
          recommendation: actionDescription(action, scores.entryScore),
          sbtcIncentives: pool.sbtc_incentives ?? false,
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── optimal-bins ─────────────────────────────────────────────────────────────
program
  .command("optimal-bins")
  .description("Recommend optimal bin offsets for adding N bins of liquidity")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .requiredOption("--count <number>", "Number of bins to add (1-100)")
  .action(async (opts: { poolId: string; count: string }) => {
    try {
      const count = parseInt(opts.count, 10);
      if (!count || count < 1 || count > 100) {
        throw new Error("--count must be between 1 and 100");
      }

      const [pool, binsData] = await Promise.all([
        getHodlmmPool(opts.poolId),
        getHodlmmPoolBins(opts.poolId),
      ]);

      const activeBinId = binsData.active_bin_id ?? pool.active_bin;
      const scores = computeScores(binsData.bins, activeBinId);
      const action = scoreToAction(scores.entryScore);
      const offsets = recommendBinOffsets(binsData.bins, activeBinId, count);

      printJson({
        status: "success",
        action,
        data: {
          poolId: opts.poolId,
          pair: poolLabel(pool),
          activeBinId,
          binStep: pool.bin_step,
          requestedBinCount: count,
          entryScore: scores.entryScore,
          entrySignal: action,
          recommendedOffsets: offsets,
          binPositions: offsets.map((offset) => ({
            offset,
            absoluteBinId: activeBinId + offset,
          })),
          note:
            action === "AVOID"
              ? "Entry conditions are poor — use these offsets with caution."
              : "Pass recommendedOffsets to add-liquidity-simple as the bins configuration.",
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
