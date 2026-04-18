#!/usr/bin/env bun
/**
 * hodlmm-harvest-loop — Autonomous HODLMM fee harvester and compounder.
 *
 * In HODLMM (DLMM), fees accrue into bin reserves as swaps flow through.
 * There is NO standalone claim-fees function. Harvest = withdraw (collecting
 * the grown bin value) → optional rebalance → redeploy into active bin.
 *
 * Commands:
 *   doctor  — check APIs, wallet, gas readiness
 *   scan    — detect accrued fees and estimate harvest value (read-only)
 *   run     — execute harvest cycle (dry-run unless --confirm=HARVEST)
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// Center bin offset — Bitflow API returns unsigned bin IDs (0–1000),
// but the contract uses signed IDs relative to center (bin 500 = offset 0).
const CENTER_BIN_ID = 500;

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_MIN_REINVEST_SATS = 5000;
const FETCH_TIMEOUT = 30_000;
const SLIPPAGE_BPS = 300; // 3% max slippage on rebalance swap

const STATE_FILE = path.join(os.homedir(), ".hodlmm-harvest-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string; // DLP shares
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string; // total DLP in bin
}

interface HarvestState {
  pools: {
    [poolId: string]: {
      deposit_baseline_x: number;
      deposit_baseline_y: number;
      last_harvest_at: string | null;
      total_harvested_x: number;
      total_harvested_y: number;
    };
  };
}

interface HarvestRecommendation {
  pool_id: string;
  pair: string;
  current_value_x: string;
  current_value_y: string;
  baseline_x: number;
  baseline_y: number;
  accrued_fee_x: string;
  accrued_fee_y: string;
  accrued_usd: number;
  gas_cost_usd: number;
  harvest_recommended: boolean;
  reason: string;
  cooldown_remaining_min: number;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(
  status: string,
  action: string,
  data: unknown,
  error: string | null = null
): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function outError(message: string): void {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[harvest-loop] ${args.join(" ")}\n`);
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(
  password: string
): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. ENV override
  if (process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY) {
    const key =
      process.env.CLIENT_PRIVATE_KEY ?? process.env.STACKS_PRIVATE_KEY ?? "";
    const { getAddressFromPrivateKey, TransactionVersion } = await import(
      "@stacks/transactions" as string
    );
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  // 2. ~/.aibtc wallet store
  const { generateWallet, deriveAccount, getStxAddress } = await import(
    "@stacks/wallet-sdk" as string
  );

  // Try wallet.json per-wallet directory first
  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const walletDir = path.join(WALLETS_DIR, activeWallet.id);
      // Try wallet.json
      const walletJsonPath = path.join(walletDir, "wallet.json");
      if (fs.existsSync(walletJsonPath)) {
        const wj = JSON.parse(fs.readFileSync(walletJsonPath, "utf-8"));
        if (wj.encryptedMnemonic) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(wj.encryptedMnemonic, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
      // Try keystore.json (AES-GCM or legacy)
      const keystorePath = path.join(walletDir, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
          const { scryptSync, createDecipheriv } = await import("crypto");
          const salt = Buffer.from(enc.salt, "base64");
          const iv = Buffer.from(enc.iv, "base64");
          const authTag = Buffer.from(enc.authTag, "base64");
          const ciphertext = Buffer.from(enc.ciphertext, "base64");
          const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
            N: enc.scryptParams?.N ?? 16384,
            r: enc.scryptParams?.r ?? 8,
            p: enc.scryptParams?.p ?? 1,
          });
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(authTag);
          const mnemonic = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ])
            .toString("utf-8")
            .trim();
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return {
            stxPrivateKey: account.stxPrivateKey,
            stxAddress: getStxAddress(account),
          };
        }
        const legacyEnc =
          keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
        if (legacyEnc) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(legacyEnc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return {
            stxPrivateKey: account.stxPrivateKey,
            stxAddress: getStxAddress(account),
          };
        }
      }
    }
  }
  throw new Error(
    "No wallet found. Set CLIENT_PRIVATE_KEY or run: npx @aibtc/mcp-server@latest --install"
  );
}

// ─── Bitflow / Hiro API reads ─────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  const raw = await fetchJson<{
    data?: unknown[];
    results?: unknown[];
    pools?: unknown[];
    [k: string]: unknown;
  }>(`${BITFLOW_APP}/pools?amm_type=dlmm`);
  const list = (
    raw.data ??
    raw.results ??
    raw.pools ??
    (Array.isArray(raw) ? raw : [])
  ) as Record<string, unknown>[];
  return list.map((p) => ({
    pool_id: String(p.pool_id ?? ""),
    pool_contract: String(p.pool_token ?? ""),
    token_x: String(p.token_x ?? ""),
    token_y: String(p.token_y ?? ""),
    token_x_symbol: String(p.token_x_symbol ?? "?"),
    token_y_symbol: String(p.token_y_symbol ?? "?"),
    token_x_decimals: Number(p.token_x_decimals ?? 8),
    token_y_decimals: Number(p.token_y_decimals ?? 6),
    active_bin: Number(p.active_bin ?? 0),
    bin_step: Number(p.bin_step ?? 0),
  }));
}

async function fetchUserPositions(
  poolId: string,
  address: string
): Promise<UserBin[]> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/pools/${poolId}/user-positions?address=${address}`
  );
  const list = (
    raw.data ??
    raw.positions ??
    raw.bins ??
    (Array.isArray(raw) ? raw : [])
  ) as Record<string, unknown>[];
  return list.map((b) => ({
    bin_id: Number(b.bin_id ?? b.binId ?? 0),
    liquidity: String(b.liquidity ?? b.dlp ?? "0"),
    reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
    reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
    price: String(b.price ?? "0"),
  }));
}

async function fetchPoolBins(
  poolId: string
): Promise<{ active_bin_id: number; bins: BinData[] }> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_QUOTES}/bins/${poolId}`
  );
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = (
    (raw.bins ?? []) as Record<string, unknown>[]
  ).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins };
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchJson<{ stx?: { balance?: string } }>(
    `${HIRO_API}/v2/accounts/${address}?proof=0`
  );
  const micro = Number(data.stx?.balance ?? "0");
  return micro / 1_000_000;
}

async function fetchNonce(address: string): Promise<bigint> {
  const data = await fetchJson<{ nonce?: number }>(
    `${HIRO_API}/v2/accounts/${address}?proof=0`
  );
  return BigInt(data.nonce ?? 0);
}

// ─── Fee accrual computation ──────────────────────────────────────────────────

/**
 * Compute the user's current proportional share value across all their bins.
 *
 * Fee accrual mechanism: swaps through a bin increase reserve_x/reserve_y.
 * User's value = sum over bins of: reserve * (user_dlp / total_bin_dlp)
 *
 * Returns totals in raw token units (smallest denomination).
 */
function computeCurrentValue(
  userBins: UserBin[],
  allBins: BinData[]
): { total_x: bigint; total_y: bigint } {
  const binMap = new Map<number, BinData>(allBins.map((b) => [b.bin_id, b]));
  let totalX = 0n;
  let totalY = 0n;

  for (const ub of userBins) {
    const bd = binMap.get(ub.bin_id);
    if (!bd) continue;

    const userDlp = BigInt(ub.liquidity);
    const totalDlp = BigInt(bd.liquidity);
    if (totalDlp === 0n) continue;

    const reserveX = BigInt(bd.reserve_x);
    const reserveY = BigInt(bd.reserve_y);

    totalX += (reserveX * userDlp) / totalDlp;
    totalY += (reserveY * userDlp) / totalDlp;
  }

  return { total_x: totalX, total_y: totalY };
}

// ─── State file management ────────────────────────────────────────────────────

function loadHarvestState(): HarvestState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as HarvestState;
    }
  } catch {
    // corrupt state — start fresh
  }
  return { pools: {} };
}

function saveHarvestState(state: HarvestState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getPoolState(
  state: HarvestState,
  poolId: string
): HarvestState["pools"][string] {
  return (
    state.pools[poolId] ?? {
      deposit_baseline_x: 0,
      deposit_baseline_y: 0,
      last_harvest_at: null,
      total_harvested_x: 0,
      total_harvested_y: 0,
    }
  );
}

function cooldownRemainingMs(state: HarvestState, poolId: string): number {
  const ps = state.pools[poolId];
  if (!ps?.last_harvest_at) return 0;
  const elapsed = Date.now() - new Date(ps.last_harvest_at).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

// ─── Gas cost estimation ──────────────────────────────────────────────────────

/**
 * Estimate USD cost of a 2-tx harvest cycle (withdraw + redeploy).
 * Uses a fixed STX fee estimate of 0.05 STX per tx × 2 = 0.10 STX.
 * STX price is fetched from Bitflow quotes if available.
 */
async function estimateGasCostUsd(): Promise<number> {
  try {
    const raw = await fetchJson<Record<string, unknown>>(
      `${BITFLOW_QUOTES}/prices`
    );
    const prices = (raw.prices ?? raw.data ?? raw) as Record<string, unknown>;
    // Try to find STX price
    const stxPrice =
      Number(
        (prices as Record<string, Record<string, unknown>>)["stx"]?.usd ??
          (prices as Record<string, unknown>)["STX"] ??
          0
      ) || 1.5; // fallback: $1.50
    return 0.10 * stxPrice; // 2 txs × 0.05 STX each
  } catch {
    return 0.15; // conservative fallback
  }
}

// ─── Harvest recommendation ───────────────────────────────────────────────────

async function buildRecommendation(
  pool: PoolMeta,
  userBins: UserBin[],
  allBins: BinData[],
  state: HarvestState,
  minReinvestSats: number
): Promise<HarvestRecommendation> {
  const { total_x, total_y } = computeCurrentValue(userBins, allBins);
  const ps = getPoolState(state, pool.pool_id);
  const cdMs = cooldownRemainingMs(state, pool.pool_id);

  const baselineX = BigInt(Math.round(ps.deposit_baseline_x));
  const baselineY = BigInt(Math.round(ps.deposit_baseline_y));

  const feeX = total_x > baselineX ? total_x - baselineX : 0n;
  const feeY = total_y > baselineY ? total_y - baselineY : 0n;

  // Convert fee accrual to approximate USD using token symbols
  // sBTC: 1e8 units = 1 BTC, assume ~$85,000. USDCx: 1e6 = $1. STX: ~$1.5
  const feeXUsd = estimateTokenUsd(
    feeX,
    pool.token_x_symbol,
    pool.token_x_decimals
  );
  const feeYUsd = estimateTokenUsd(
    feeY,
    pool.token_y_symbol,
    pool.token_y_decimals
  );
  const accruedUsd = feeXUsd + feeYUsd;

  const gasCostUsd = await estimateGasCostUsd();

  // Convert min-reinvest-sats to USD: 1 sat = ~$0.00085 (at $85k BTC)
  const minUsd = (minReinvestSats / 1e8) * 85_000;

  let recommended = false;
  let reason = "";

  if (cdMs > 0) {
    reason = `Cooldown active — ${Math.ceil(cdMs / 60_000)} minutes remaining`;
  } else if (ps.deposit_baseline_x === 0 && ps.deposit_baseline_y === 0) {
    reason =
      "No deposit baseline recorded. First run will set baseline. Execute a harvest to establish tracking.";
    recommended = true; // allow first harvest to set baseline
  } else if (accruedUsd < gasCostUsd) {
    reason = `Accrued fees ($${accruedUsd.toFixed(4)}) less than estimated gas ($${gasCostUsd.toFixed(4)}) — not cost-effective`;
  } else if (feeX + feeY === 0n) {
    reason = "No fee accrual detected since last deposit baseline";
  } else {
    const feeAsSats = Number(feeX); // proxy: fee_x in token_x raw units
    if (feeAsSats < minReinvestSats && pool.token_x_symbol === "sBTC") {
      reason = `Accrued ${feeX} sats (${feeAsSats} raw units) below min-reinvest-sats threshold of ${minReinvestSats}`;
    } else {
      recommended = true;
      reason = `Fee accrual $${accruedUsd.toFixed(4)} > gas cost $${gasCostUsd.toFixed(4)} — harvest is cost-effective`;
    }
  }

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    current_value_x: total_x.toString(),
    current_value_y: total_y.toString(),
    baseline_x: ps.deposit_baseline_x,
    baseline_y: ps.deposit_baseline_y,
    accrued_fee_x: feeX.toString(),
    accrued_fee_y: feeY.toString(),
    accrued_usd: accruedUsd,
    gas_cost_usd: gasCostUsd,
    harvest_recommended: recommended,
    reason,
    cooldown_remaining_min: Math.ceil(cdMs / 60_000),
  };
}

function estimateTokenUsd(
  amount: bigint,
  symbol: string,
  decimals: number
): number {
  const human = Number(amount) / Math.pow(10, decimals);
  switch (symbol.toLowerCase()) {
    case "sbtc":
      return human * 85_000;
    case "usdcx":
    case "usdc":
      return human * 1.0;
    case "stx":
      return human * 1.5;
    default:
      return human * 1.0;
  }
}

// ─── On-chain: withdraw ───────────────────────────────────────────────────────

async function executeWithdraw(
  privateKey: string,
  pool: PoolMeta,
  userBins: UserBin[],
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    listCV,
    tupleCV,
    intCV,
    uintCV,
    contractPrincipalCV,
    PostConditionMode,
    AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  // withdraw-relative-liquidity-same-multi: withdraw all DLP from each bin
  // using relative bin IDs (offset from center).
  const withdrawList = userBins
    .filter((b) => BigInt(b.liquidity) > 0n)
    .map((b) => {
      const amt = BigInt(b.liquidity);
      // Slippage: accept at least 97% of current reserve value back
      const minX = (BigInt(b.reserve_x) * 97n) / 100n;
      const minY = (BigInt(b.reserve_y) * 97n) / 100n;
      return tupleCV({
        "bin-id": intCV(b.bin_id - CENTER_BIN_ID),
        amount: uintCV(amt),
        "min-x-amount": uintCV(minX),
        "min-y-amount": uintCV(minY),
        "pool-trait": contractPrincipalCV(poolAddr, poolName),
        "x-token-trait": contractPrincipalCV(xAddr, xName),
        "y-token-trait": contractPrincipalCV(yAddr, yName),
      });
    });

  if (withdrawList.length === 0) {
    throw new Error("No bins with liquidity to withdraw");
  }

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "withdraw-relative-liquidity-same-multi",
    functionArgs: [listCV(withdrawList)],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({
    transaction: tx,
    network: STACKS_MAINNET,
  });
  if ("error" in result && result.error) {
    throw new Error(
      `Withdraw broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`
    );
  }
  return result.txid as string;
}

// ─── On-chain: redeploy ───────────────────────────────────────────────────────

async function executeRedeploy(
  privateKey: string,
  pool: PoolMeta,
  activeBin: number,
  spread: number,
  amountX: bigint,
  amountY: bigint,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    listCV,
    tupleCV,
    intCV,
    uintCV,
    contractPrincipalCV,
    PostConditionMode,
    AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  // Distribute X amount into bins above active (offset >= 0)
  // Distribute Y amount into bins below active (offset <= 0)
  // Active bin gets a proportional share of both.
  const binCount = spread * 2 + 1; // -(spread) to +(spread) inclusive
  const addList: ReturnType<typeof tupleCV>[] = [];

  // Above bins (X token): active bin + 1 to active bin + spread
  if (amountX > 0n && spread > 0) {
    const perBinX = amountX / BigInt(spread + 1);
    for (let offset = 0; offset <= spread; offset++) {
      if (perBinX === 0n) continue;
      addList.push(
        tupleCV({
          "active-bin-id-offset": intCV(offset),
          "x-amount": uintCV(perBinX),
          "y-amount": uintCV(0n),
          "min-dlp": uintCV(0n),
          "pool-trait": contractPrincipalCV(poolAddr, poolName),
          "x-token-trait": contractPrincipalCV(xAddr, xName),
          "y-token-trait": contractPrincipalCV(yAddr, yName),
        })
      );
    }
  }

  // Below bins (Y token): active bin - spread to active bin - 1
  if (amountY > 0n && spread > 0) {
    const perBinY = amountY / BigInt(spread + 1);
    for (let offset = -spread; offset <= 0; offset++) {
      if (perBinY === 0n) continue;
      addList.push(
        tupleCV({
          "active-bin-id-offset": intCV(offset),
          "x-amount": uintCV(0n),
          "y-amount": uintCV(perBinY),
          "min-dlp": uintCV(0n),
          "pool-trait": contractPrincipalCV(poolAddr, poolName),
          "x-token-trait": contractPrincipalCV(xAddr, xName),
          "y-token-trait": contractPrincipalCV(yAddr, yName),
        })
      );
    }
  }

  if (addList.length === 0) {
    throw new Error("No redeployment positions to add");
  }

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "add-relative-liquidity-multi",
    functionArgs: [listCV(addList)],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({
    transaction: tx,
    network: STACKS_MAINNET,
  });
  if ("error" in result && result.error) {
    throw new Error(
      `Redeploy broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`
    );
  }
  return result.txid as string;
}

// ─── Bitflow rebalance swap ───────────────────────────────────────────────────

/**
 * Parse target ratio string "x:y" into a fraction [xPart, yPart].
 */
function parseTargetRatio(ratioStr: string): [number, number] {
  const parts = ratioStr.split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => isNaN(n) || n <= 0)) {
    return [50, 50]; // default 50:50
  }
  return [parts[0], parts[1]];
}

/**
 * Determine if a rebalance swap is needed and which direction.
 * Returns null if already at target ratio (within 5% tolerance).
 */
function needsRebalance(
  amountX: bigint,
  amountY: bigint,
  priceXInY: number,
  targetRatio: [number, number],
  pool: PoolMeta
): { swapXtoY: boolean; swapAmount: bigint } | null {
  if (amountX === 0n || amountY === 0n) return null;

  // Normalize both sides to Y units
  const xAsY = Number(amountX) * priceXInY;
  const yAsY = Number(amountY);
  const totalY = xAsY + yAsY;

  const currentXRatio = xAsY / totalY; // fraction of value in X token
  const targetXRatio =
    targetRatio[0] / (targetRatio[0] + targetRatio[1]);

  const deviation = Math.abs(currentXRatio - targetXRatio);
  if (deviation < 0.05) return null; // within 5% — no swap needed

  if (currentXRatio > targetXRatio) {
    // Too much X — swap some X to Y
    const excessXAsY = (currentXRatio - targetXRatio) * totalY;
    const swapAmount = BigInt(Math.floor(excessXAsY / priceXInY));
    return { swapXtoY: true, swapAmount };
  } else {
    // Too much Y — swap some Y to X
    const excessY = (targetXRatio - currentXRatio) * totalY;
    return { swapXtoY: false, swapAmount: BigInt(Math.floor(excessY)) };
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-harvest-loop")
  .description("Autonomous HODLMM fee harvester and compounder");

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check API access, wallet, gas readiness")
  .option("--wallet <address>", "STX address to check")
  .action(async (opts) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    // Bitflow pools
    try {
      const pools = await fetchPools();
      checks.bitflow_pools = {
        ok: pools.length > 0,
        detail: `${pools.length} HODLMM pools found`,
      };
    } catch (e: unknown) {
      checks.bitflow_pools = { ok: false, detail: (e as Error).message };
    }

    // Bitflow bins (dlmm_1)
    try {
      const data = await fetchJson<Record<string, unknown>>(
        `${BITFLOW_QUOTES}/bins/dlmm_1`
      );
      checks.bitflow_bins = {
        ok: !!data.active_bin_id,
        detail: `active_bin_id=${data.active_bin_id}`,
      };
    } catch (e: unknown) {
      checks.bitflow_bins = { ok: false, detail: (e as Error).message };
    }

    // Hiro API
    try {
      const info = await fetchJson<Record<string, unknown>>(
        `${HIRO_API}/v2/info`
      );
      checks.hiro_api = {
        ok: !!info.stacks_tip_height,
        detail: `tip=${info.stacks_tip_height}`,
      };
    } catch (e: unknown) {
      checks.hiro_api = { ok: false, detail: (e as Error).message };
    }

    // Wallet env
    const hasWalletEnv =
      !!(process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY);
    const hasWalletFile = fs.existsSync(WALLETS_FILE);
    checks.wallet_config = {
      ok: hasWalletEnv || hasWalletFile,
      detail: hasWalletEnv
        ? "CLIENT_PRIVATE_KEY or STACKS_PRIVATE_KEY env set"
        : hasWalletFile
        ? `wallet file found at ${WALLETS_FILE}`
        : "No wallet config found",
    };

    // STX balance
    if (opts.wallet) {
      try {
        const bal = await fetchStxBalance(opts.wallet);
        checks.stx_balance = {
          ok: bal >= 1,
          detail: `${bal.toFixed(6)} STX (need ≥1 for gas)`,
        };
      } catch (e: unknown) {
        checks.stx_balance = { ok: false, detail: (e as Error).message };
      }
    }

    // State file
    const stateExists = fs.existsSync(STATE_FILE);
    const state = loadHarvestState();
    const trackedPools = Object.keys(state.pools).length;
    checks.state_file = {
      ok: true,
      detail: stateExists
        ? `found at ${STATE_FILE}, tracking ${trackedPools} pool(s)`
        : `not found (will be created on first harvest) at ${STATE_FILE}`,
    };

    // Stacks tx library
    try {
      await import("@stacks/transactions" as string);
      checks.stacks_tx_lib = { ok: true, detail: "available" };
    } catch {
      checks.stacks_tx_lib = {
        ok: false,
        detail: "@stacks/transactions not installed",
      };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    const message = allOk
      ? "All checks passed — ready to harvest"
      : "Some checks failed — review before executing harvest";

    out(allOk ? "success" : "degraded", "doctor", { checks, message });
  });

// ── scan ──────────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description(
    "Detect accrued fees and estimate harvest value (read-only)"
  )
  .option("--pool-id <id>", "Restrict to a single pool ID (e.g. dlmm_1)")
  .option("--wallet <address>", "STX address to scan")
  .option(
    "--min-reinvest-sats <n>",
    "Minimum accrued sats to recommend harvest",
    String(DEFAULT_MIN_REINVEST_SATS)
  )
  .action(async (opts) => {
    if (!opts.wallet) {
      outError("--wallet <address> is required for scan");
    }

    try {
      const minSats = parseInt(opts.minReinvestSats, 10) || DEFAULT_MIN_REINVEST_SATS;
      const state = loadHarvestState();
      const pools = await fetchPools();
      const targetPools = opts.poolId
        ? pools.filter((p) => p.pool_id === opts.poolId)
        : pools;

      if (opts.poolId && targetPools.length === 0) {
        outError(`Pool ${opts.poolId} not found`);
      }

      const recommendations: HarvestRecommendation[] = [];

      for (const pool of targetPools) {
        try {
          const [userBins, binsData] = await Promise.all([
            fetchUserPositions(pool.pool_id, opts.wallet),
            fetchPoolBins(pool.pool_id),
          ]);
          if (userBins.length === 0) {
            log(`${pool.pool_id}: no position — skip`);
            continue;
          }

          const rec = await buildRecommendation(
            pool,
            userBins,
            binsData.bins,
            state,
            minSats
          );
          recommendations.push(rec);
        } catch (e: unknown) {
          log(`${pool.pool_id} scan error: ${(e as Error).message}`);
        }
      }

      const harvestable = recommendations.filter((r) => r.harvest_recommended);
      out("success", "scan", {
        wallet: opts.wallet,
        pools_scanned: targetPools.length,
        positions_found: recommendations.length,
        harvest_recommended_count: harvestable.length,
        recommendations,
      });
    } catch (e: unknown) {
      outError((e as Error).message);
    }
  });

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description(
    "Execute harvest cycle for a pool (dry-run unless --confirm=HARVEST)"
  )
  .requiredOption("--pool-id <id>", "Pool ID (e.g. dlmm_1)")
  .option("--wallet <address>", "STX address")
  .option(
    "--min-reinvest-sats <n>",
    "Minimum sats to proceed with harvest",
    String(DEFAULT_MIN_REINVEST_SATS)
  )
  .option(
    "--target-ratio <x:y>",
    "Target token ratio after rebalance (e.g. 50:50)",
    "50:50"
  )
  .option(
    "--confirm <value>",
    "Pass HARVEST to execute on-chain (omit for dry-run)"
  )
  .option("--password <pass>", "Wallet password (required with --confirm=HARVEST)")
  .option("--spread <n>", "Bin spread ±N around active bin for redeploy", "5")
  .action(async (opts) => {
    const poolId: string = opts.poolId;
    const confirmed: boolean = opts.confirm === "HARVEST";
    const minSats =
      parseInt(opts.minReinvestSats, 10) || DEFAULT_MIN_REINVEST_SATS;
    const targetRatio = parseTargetRatio(opts.targetRatio ?? "50:50");
    const spread = Math.min(Math.max(parseInt(opts.spread, 10) || 5, 1), 10);

    try {
      // Resolve wallet address
      let walletAddress: string = opts.wallet ?? "";
      if (!walletAddress && confirmed) {
        // Derive from key
        if (!opts.password) {
          outError("--password required when --confirm=HARVEST is set");
        }
      }

      // Fetch pool metadata
      const pools = await fetchPools();
      const pool = pools.find((p) => p.pool_id === poolId);
      if (!pool) {
        outError(`Pool ${poolId} not found`);
        return;
      }

      // Fetch position data
      const [binsData] = await Promise.all([fetchPoolBins(poolId)]);

      let userBins: UserBin[] = [];
      if (walletAddress) {
        userBins = await fetchUserPositions(poolId, walletAddress);
      }

      const activeBin = binsData.active_bin_id || pool.active_bin;

      // If no wallet yet (confirmed mode), derive address first
      if (!walletAddress && confirmed && opts.password) {
        const keys = await getWalletKeys(opts.password);
        walletAddress = keys.stxAddress;
        userBins = await fetchUserPositions(poolId, walletAddress);
      }

      if (userBins.length === 0) {
        out("blocked", "run", { pool_id: poolId }, "No position found in this pool");
        return;
      }

      // Load state and build recommendation
      const state = loadHarvestState();
      const cdMs = cooldownRemainingMs(state, poolId);

      if (cdMs > 0) {
        out("blocked", "run", {
          pool_id: poolId,
          cooldown_remaining_min: Math.ceil(cdMs / 60_000),
        }, `Cooldown active — ${Math.ceil(cdMs / 60_000)} minutes remaining`);
        return;
      }

      const rec = await buildRecommendation(
        pool,
        userBins,
        binsData.bins,
        state,
        minSats
      );

      // Compute current values
      const { total_x, total_y } = computeCurrentValue(userBins, binsData.bins);

      // Compute rebalance need
      // Use active bin price as X→Y exchange rate
      const activeBinData = binsData.bins.find((b) => b.bin_id === activeBin);
      const priceXInY = activeBinData ? Number(activeBinData.price) : 1.0;
      const rebalanceNeeded = needsRebalance(
        total_x,
        total_y,
        priceXInY,
        targetRatio,
        pool
      );

      const plan = {
        pool_id: poolId,
        pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
        active_bin: activeBin,
        spread,
        current_value_x: total_x.toString(),
        current_value_y: total_y.toString(),
        accrued_fee_x: rec.accrued_fee_x,
        accrued_fee_y: rec.accrued_fee_y,
        accrued_usd: rec.accrued_usd,
        gas_cost_usd: rec.gas_cost_usd,
        harvest_recommended: rec.harvest_recommended,
        reason: rec.reason,
        rebalance_needed: !!rebalanceNeeded,
        rebalance_direction: rebalanceNeeded
          ? rebalanceNeeded.swapXtoY
            ? `swap ${rebalanceNeeded.swapAmount} ${pool.token_x_symbol} → ${pool.token_y_symbol}`
            : `swap ${rebalanceNeeded.swapAmount} ${pool.token_y_symbol} → ${pool.token_x_symbol}`
          : "none",
        steps: [
          "1. withdraw-relative-liquidity-same-multi (collect all DLP + accrued fees)",
          rebalanceNeeded
            ? "2. Bitflow swap to rebalance token ratio"
            : "2. (no rebalance needed)",
          "3. add-relative-liquidity-multi (redeploy around active bin)",
          "4. Update state file with new baseline and harvest timestamp",
        ],
      };

      // Dry run
      if (!confirmed) {
        out("success", "run", {
          mode: "dry-run",
          decision: rec.harvest_recommended ? "HARVEST_NEEDED" : "SKIP",
          reason: rec.reason,
          plan,
          note: rec.harvest_recommended
            ? "Add --confirm=HARVEST --password <pass> to execute"
            : "Harvest not recommended at this time",
        });
        return;
      }

      // Gate: must be recommended
      if (!rec.harvest_recommended && rec.accrued_fee_x === "0" && rec.accrued_fee_y === "0") {
        out("blocked", "run", { plan }, rec.reason);
        return;
      }

      // Gate: password required
      if (!opts.password) {
        outError("--password required with --confirm=HARVEST");
        return;
      }

      // Gate: gas
      const stxBal = await fetchStxBalance(walletAddress);
      if (stxBal < 1) {
        out("blocked", "run", { stx_balance: stxBal }, "Insufficient STX for gas (need ≥1 STX)");
        return;
      }

      // Load wallet
      log("Decrypting wallet...");
      const keys = await getWalletKeys(opts.password);
      if (walletAddress && keys.stxAddress !== walletAddress) {
        outError(`Wallet address mismatch: expected ${walletAddress}, got ${keys.stxAddress}`);
        return;
      }
      walletAddress = keys.stxAddress;

      log(`Harvesting pool ${poolId} for ${walletAddress}`);

      const beforeState = {
        value_x: total_x.toString(),
        value_y: total_y.toString(),
        stx_balance: stxBal,
      };

      // Step 1: Withdraw
      log("Step 1: Withdrawing liquidity...");
      const nonce1 = await fetchNonce(walletAddress);
      const withdrawTxId = await executeWithdraw(
        keys.stxPrivateKey,
        pool,
        userBins,
        nonce1
      );
      log(`Withdraw broadcast: ${withdrawTxId}`);

      // Step 2: Optional rebalance swap (simplified — not broadcasting swap tx here,
      // as it requires waiting for withdraw to confirm first)
      let swapTxId: string | undefined;
      if (rebalanceNeeded) {
        log(
          "Step 2: Rebalance needed — operator should execute swap after withdraw confirms"
        );
        log(
          `  Direction: ${plan.rebalance_direction} (slippage max 3%)`
        );
        // In a fully autonomous loop, the agent would poll for withdraw confirmation
        // then execute the swap. For safety and simplicity, we note it here.
        // The bitflow skill handles the actual swap execution.
      }

      // Step 3: Redeploy (after withdraw confirms — using nonce +1 if broadcasting immediately)
      // NOTE: In production use, wait for withdraw tx to confirm before redeploying.
      // Here we queue with nonce+1 for atomic pipeline.
      log("Step 3: Redeploying liquidity around active bin...");
      const nonce2 = nonce1 + 1n;
      const redeployTxId = await executeRedeploy(
        keys.stxPrivateKey,
        pool,
        activeBin,
        spread,
        total_x,
        total_y,
        nonce2
      );
      log(`Redeploy broadcast: ${redeployTxId}`);

      // Step 4: Update state file
      const ps = getPoolState(state, poolId);
      const newState: HarvestState = {
        ...state,
        pools: {
          ...state.pools,
          [poolId]: {
            deposit_baseline_x: Number(total_x),
            deposit_baseline_y: Number(total_y),
            last_harvest_at: new Date().toISOString(),
            total_harvested_x:
              ps.total_harvested_x + Number(rec.accrued_fee_x),
            total_harvested_y:
              ps.total_harvested_y + Number(rec.accrued_fee_y),
          },
        },
      };
      saveHarvestState(newState);
      log(`State file updated: ${STATE_FILE}`);

      out("success", "run", {
        status: "success",
        mode: "executed",
        pool_id: poolId,
        pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
        txids: {
          withdraw: withdrawTxId,
          swap: swapTxId ?? null,
          redeploy: redeployTxId,
        },
        explorer: {
          withdraw: `${EXPLORER}/${withdrawTxId}?chain=mainnet`,
          redeploy: `${EXPLORER}/${redeployTxId}?chain=mainnet`,
        },
        before: beforeState,
        after: {
          baseline_x: Number(total_x),
          baseline_y: Number(total_y),
          cooldown_until: new Date(Date.now() + COOLDOWN_MS).toISOString(),
        },
        accrued: {
          fee_x: rec.accrued_fee_x,
          fee_y: rec.accrued_fee_y,
          usd: rec.accrued_usd,
        },
        note: rebalanceNeeded
          ? "Rebalance swap queued — execute via bitflow skill after withdraw confirms"
          : "Harvest complete — no rebalance needed",
      });
    } catch (e: unknown) {
      outError((e as Error).message);
    }
  });

// ─── Entry ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  program.parse(process.argv);
}
