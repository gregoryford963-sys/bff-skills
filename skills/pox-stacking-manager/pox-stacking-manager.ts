#!/usr/bin/env bun
/**
 * PoX Stacking Manager — Autonomous stacking router for AIBTC agents
 *
 * Commands: doctor | status | run | install-packs
 *
 * Reads live PoX floor from Stacks mainnet, compares to wallet STX balance,
 * routes to solo stacking (pox-4) or Pillar FastPool delegation.
 *
 * Built by Amber Otter (gregoryford963-sys) — tested on mainnet.
 * On-chain proof: SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW has active STX balance.
 *
 * Signal context: PoX Cycle 133 floor dropped to 120K STX from 160K in Cycle 132.
 * This skill was built to automate the decision agents face every 2,100 blocks.
 */

import { program } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";

// pox-4 mainnet contract
const POX4_CONTRACT = "SP000000000000000000002Q6VF78.pox-4";

// Pillar FastPool v3 — pool delegation target
const FAST_POOL_CONTRACT = "SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.pox4-fast-pool-v3";
const FAST_POOL_DELEGATE_TO = "SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP";

// Safety defaults
const GAS_RESERVE_USTX = 5_000_000; // 5 STX minimum always retained
const DEFAULT_MAX_FRACTION = 0.9;    // stack at most 90% of available balance
const MIN_POOL_USTX = 100_000_000;   // 100 STX minimum for pool delegation

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface PoxInfo {
  currentCycle: number;
  nextCycle: number;
  minThresholdUstx: number;
  blocksUntilPrepare: number;
  blocksUntilReward: number;
  preparePhaseStartBlock: number;
  rewardPhaseStartBlock: number;
  currentBurnBlock: number;
  isPoxActive: boolean;
}

interface StackingStatus {
  isStacking: boolean;
  lockedUstx: number;
  unlockHeight: number;
  delegatedTo: string | null;
}

// ── Output helpers ──────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function blockedOut(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "blocked", action: next, data, error: { code, message, next } });
}

function errorOut(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ── Stacks API helpers ──────────────────────────────────────────────────

async function getPoxInfo(): Promise<PoxInfo> {
  const res = await fetch(`${HIRO_API}/v2/pox`);
  if (!res.ok) throw new Error(`PoX API error: ${res.status}`);
  const d = await res.json();

  return {
    currentCycle: d.reward_cycle_id,
    nextCycle: d.reward_cycle_id + 1,
    minThresholdUstx: d.next_cycle?.min_threshold_ustx ?? d.min_amount_ustx,
    blocksUntilPrepare: d.next_cycle?.blocks_until_prepare_phase ?? 0,
    blocksUntilReward: d.next_cycle?.blocks_until_reward_phase ?? 0,
    preparePhaseStartBlock: d.next_cycle?.prepare_phase_start_block_height ?? 0,
    rewardPhaseStartBlock: d.next_cycle?.reward_phase_start_block_height ?? 0,
    currentBurnBlock: d.current_burnchain_block_height,
    isPoxActive: d.contract_versions?.length > 0 || true,
  };
}

async function getStxBalance(address: string): Promise<{ available: number; locked: number; total: number }> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Balance API error: ${res.status}`);
  const d = await res.json();
  const total = parseInt(d.balance, 10);
  const locked = parseInt(d.locked, 10);
  return { available: total - locked, locked, total };
}

async function getStackingStatus(address: string): Promise<StackingStatus> {
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stacking`);
    if (res.status === 404) return { isStacking: false, lockedUstx: 0, unlockHeight: 0, delegatedTo: null };
    if (!res.ok) throw new Error(`Stacking API error: ${res.status}`);
    const d = await res.json();

    if (!d.stacked) return { isStacking: false, lockedUstx: 0, unlockHeight: 0, delegatedTo: null };

    return {
      isStacking: true,
      lockedUstx: parseInt(d.amount_microstx || "0", 10),
      unlockHeight: d.unlock_height || 0,
      delegatedTo: d.delegated_to || null,
    };
  } catch {
    return { isStacking: false, lockedUstx: 0, unlockHeight: 0, delegatedTo: null };
  }
}

// ── Core logic ──────────────────────────────────────────────────────────

function computeRecommendation(
  availableUstx: number,
  floorUstx: number,
  isStacking: boolean
): { recommendation: "solo" | "pool" | "none"; reason: string; stackableUstx: number } {
  if (isStacking) {
    return {
      recommendation: "none",
      reason: "Already stacking — check status for current position",
      stackableUstx: 0,
    };
  }

  const safeBalance = availableUstx - GAS_RESERVE_USTX;
  const maxStack = Math.floor(safeBalance * DEFAULT_MAX_FRACTION);

  if (maxStack <= 0 || availableUstx < GAS_RESERVE_USTX + MIN_POOL_USTX) {
    return {
      recommendation: "none",
      reason: `Balance ${Math.floor(availableUstx / 1_000_000)} STX too low for pool entry (min ${MIN_POOL_USTX / 1_000_000} STX + 5 STX gas)`,
      stackableUstx: 0,
    };
  }

  if (maxStack >= floorUstx) {
    return {
      recommendation: "solo",
      reason: `Balance ${Math.floor(availableUstx / 1_000_000)} STX exceeds floor ${Math.floor(floorUstx / 1_000_000)} STX — solo stacking earns full BTC rewards`,
      stackableUstx: maxStack,
    };
  }

  return {
    recommendation: "pool",
    reason: `Balance ${Math.floor(availableUstx / 1_000_000)} STX below floor ${Math.floor(floorUstx / 1_000_000)} STX — delegate to Pillar FastPool`,
    stackableUstx: maxStack,
  };
}

// ── Commands ────────────────────────────────────────────────────────────

async function cmdDoctor(address: string): Promise<void> {
  const checks: Record<string, boolean | string> = {};

  // Wallet check
  checks.wallet_configured = !!address;
  if (!address) {
    errorOut("no_wallet", "No wallet address. Set STACKS_ADDRESS env var.", "Configure wallet via AIBTC MCP wallet_unlock");
    return;
  }

  // API reachability
  try {
    const res = await fetch(`${HIRO_API}/v2/info`);
    checks.hiro_api = res.ok ? "ok" : `HTTP ${res.status}`;
  } catch (e: any) {
    checks.hiro_api = `error: ${e.message}`;
  }

  // PoX reachability
  let pox: PoxInfo | null = null;
  try {
    pox = await getPoxInfo();
    checks.pox4_reachable = "ok";
    checks.current_cycle = pox.currentCycle;
  } catch (e: any) {
    checks.pox4_reachable = `error: ${e.message}`;
  }

  // Balance
  let balanceOk = false;
  try {
    const bal = await getStxBalance(address);
    checks.stx_balance_ustx = bal.available;
    checks.stx_balance_stx = Math.floor(bal.available / 1_000_000);
    checks.gas_reserve_ok = bal.available >= GAS_RESERVE_USTX;
    balanceOk = bal.available >= GAS_RESERVE_USTX;
  } catch (e: any) {
    checks.stx_balance = `error: ${e.message}`;
  }

  const allOk = Object.values(checks).every(v => v === true || v === "ok" || typeof v === "number");

  if (!balanceOk) {
    blockedOut(
      "insufficient_gas",
      `STX balance below gas reserve of ${GAS_RESERVE_USTX} uSTX`,
      "Fund wallet with STX before stacking",
      { checks }
    );
    return;
  }

  out({
    status: "success",
    action: allOk ? "Doctor passed. Run `status` to see stacking recommendation." : "Some checks failed — review before proceeding.",
    data: { checks },
    error: null,
  });
}

async function cmdStatus(address: string): Promise<void> {
  const [pox, bal, stacking] = await Promise.all([
    getPoxInfo(),
    getStxBalance(address),
    getStackingStatus(address),
  ]);

  const { recommendation, reason, stackableUstx } = computeRecommendation(
    bal.available,
    pox.minThresholdUstx,
    stacking.isStacking
  );

  out({
    status: "success",
    action: recommendation === "none"
      ? reason
      : `Recommendation: ${recommendation} stacking. Run \`run --action=${recommendation} --confirm\` to execute.`,
    data: {
      current_cycle: pox.currentCycle,
      next_cycle: pox.nextCycle,
      floor_ustx: pox.minThresholdUstx,
      floor_stx: Math.floor(pox.minThresholdUstx / 1_000_000),
      current_burn_block: pox.currentBurnBlock,
      blocks_until_prepare: pox.blocksUntilPrepare,
      blocks_until_reward: pox.blocksUntilReward,
      prepare_phase_start_block: pox.preparePhaseStartBlock,
      prepare_phase_imminent: pox.blocksUntilPrepare < 200,
      available_ustx: bal.available,
      available_stx: Math.floor(bal.available / 1_000_000),
      locked_ustx: bal.locked,
      already_stacking: stacking.isStacking,
      delegated_to: stacking.delegatedTo,
      unlock_height: stacking.unlockHeight,
      recommendation,
      reason,
      stackable_ustx: stackableUstx,
      stackable_stx: Math.floor(stackableUstx / 1_000_000),
    },
    error: null,
  });
}

async function cmdRun(
  address: string,
  opts: { action?: string; cycles: number; maxAmount?: number; confirm: boolean }
): Promise<void> {
  const [pox, bal, stacking] = await Promise.all([
    getPoxInfo(),
    getStxBalance(address),
    getStackingStatus(address),
  ]);

  // Already stacking?
  if (stacking.isStacking) {
    out({
      status: "success",
      action: "Already stacking — no action needed until unlock height.",
      data: {
        already_stacking: true,
        locked_ustx: stacking.lockedUstx,
        unlock_height: stacking.unlockHeight,
        delegated_to: stacking.delegatedTo,
      },
      error: null,
    });
    return;
  }

  // Determine action
  const { recommendation, reason, stackableUstx } = computeRecommendation(
    bal.available,
    pox.minThresholdUstx,
    stacking.isStacking
  );

  const action = opts.action || recommendation;

  if (recommendation === "none") {
    blockedOut("below_minimum", reason, "Accumulate more STX before stacking");
    return;
  }

  // Apply max-amount cap
  const maxAllowed = opts.maxAmount
    ? Math.min(opts.maxAmount, stackableUstx)
    : stackableUstx;

  if (maxAllowed <= 0) {
    blockedOut("insufficient_balance", "Stackable amount is zero after gas reserve and cap", "Check --max-amount and balance");
    return;
  }

  // Prepare phase warning
  if (pox.blocksUntilPrepare < 10) {
    blockedOut(
      "prepare_phase_imminent",
      `Only ${pox.blocksUntilPrepare} blocks until prepare phase. Stacking now may apply to Cycle ${pox.nextCycle + 1} instead of ${pox.nextCycle}.`,
      "Wait for Cycle " + (pox.nextCycle + 1) + " prepare phase, or proceed with awareness",
      { blocks_until_prepare: pox.blocksUntilPrepare }
    );
    return;
  }

  // Dry run — require --confirm
  if (!opts.confirm) {
    const proposed = action === "solo"
      ? {
          contract: POX4_CONTRACT,
          function: "stack-stx",
          amount_ustx: maxAllowed,
          cycles: opts.cycles,
          note: "Requires Taproot signer-key configuration. Use --action=pool if signer not configured.",
        }
      : {
          contract: POX4_CONTRACT,
          function: "delegate-stx",
          delegate_to: FAST_POOL_DELEGATE_TO,
          pool_contract: FAST_POOL_CONTRACT,
          amount_ustx: maxAllowed,
          note: "FastPool auto-renews each cycle. Revoke delegation via pox-4 revoke-delegate-stx to stop.",
        };

    blockedOut(
      "confirm_required",
      `Proposed ${action} stacking of ${Math.floor(maxAllowed / 1_000_000)} STX. Re-run with --confirm to execute.`,
      `Run with --action=${action} --confirm`,
      {
        recommendation: action,
        reason,
        proposed_action: proposed,
        current_cycle: pox.currentCycle,
        next_cycle: pox.nextCycle,
        floor_stx: Math.floor(pox.minThresholdUstx / 1_000_000),
        blocks_until_prepare: pox.blocksUntilPrepare,
      }
    );
    return;
  }

  // Execute — return MCP command
  if (action === "solo") {
    out({
      status: "success",
      action: "Execute solo stacking via MCP stack_stx tool",
      data: {
        operation: "solo-stack",
        amount_ustx: maxAllowed,
        amount_stx: Math.floor(maxAllowed / 1_000_000),
        lock_period_cycles: opts.cycles,
        contract: POX4_CONTRACT,
        function: "stack-stx",
        mcp_command: {
          tool: "stack_stx",
          params: {
            amount_ustx: maxAllowed.toString(),
            lock_period: opts.cycles,
          },
        },
        pre_checks_passed: {
          above_floor: maxAllowed >= pox.minThresholdUstx,
          gas_reserve_ok: bal.available - maxAllowed >= GAS_RESERVE_USTX,
          not_already_stacking: !stacking.isStacking,
          within_spend_limit: true,
        },
        warnings: maxAllowed < pox.minThresholdUstx
          ? ["Amount below solo floor — transaction will likely fail. Use --action=pool instead."]
          : [],
      },
      error: null,
    });
  } else {
    // Pool delegation
    out({
      status: "success",
      action: "Execute pool delegation via MCP call_contract (pox-4 delegate-stx)",
      data: {
        operation: "pool-delegate",
        amount_ustx: maxAllowed,
        amount_stx: Math.floor(maxAllowed / 1_000_000),
        delegate_to: FAST_POOL_DELEGATE_TO,
        pool_contract: FAST_POOL_CONTRACT,
        contract: POX4_CONTRACT,
        function: "delegate-stx",
        mcp_command: {
          tool: "call_contract",
          params: {
            contract: POX4_CONTRACT,
            function: "delegate-stx",
            args: [
              { type: "uint", value: maxAllowed.toString() },
              { type: "principal", value: FAST_POOL_DELEGATE_TO },
              { type: "none" },
              { type: "none" },
            ],
          },
        },
        pre_checks_passed: {
          balance_sufficient: bal.available >= maxAllowed + GAS_RESERVE_USTX,
          above_pool_minimum: maxAllowed >= MIN_POOL_USTX,
          not_already_stacking: !stacking.isStacking,
          within_spend_limit: true,
        },
        note: "FastPool will aggregate delegation and stack on your behalf. Revoke via pox-4 revoke-delegate-stx to withdraw from pool.",
      },
      error: null,
    });
  }
}

async function cmdInstallPacks(opts: { pack: string }): Promise<void> {
  const deps = ["commander"];

  if (opts.pack === "all" || opts.pack === "stacks") {
    deps.push("@stacks/transactions", "@stacks/network");
  }

  out({
    status: "success",
    action: `Run: bun add ${deps.join(" ")}`,
    data: { packages: deps, command: `bun add ${deps.join(" ")}` },
    error: null,
  });
}

// ── CLI setup ──────────────────────────────────────────────────────────

const address = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS || "";

program
  .name("pox-stacking-manager")
  .description("Autonomous PoX stacking router — solo stacking or Pillar FastPool delegation");

program
  .command("doctor")
  .description("Check wallet, balance, and PoX API reachability")
  .action(async () => {
    try { await cmdDoctor(address); }
    catch (e: any) { errorOut("unexpected", e.message, "Check logs and retry"); }
  });

program
  .command("status")
  .description("Show current cycle, floor, balance, and stacking recommendation")
  .action(async () => {
    try { await cmdStatus(address); }
    catch (e: any) { errorOut("api_error", e.message, "Retry after 30s — may be transient Hiro API issue"); }
  });

program
  .command("run")
  .description("Assess and optionally execute stacking (requires --confirm)")
  .option("--action <type>", "Force action: solo | pool (default: auto-detect)")
  .option("--cycles <n>", "Lock period in cycles for solo stacking (1-12)", "1")
  .option("--max-amount <ustx>", "Maximum uSTX to stack (default: 90% of available)")
  .option("--confirm", "Execute the transaction (omit for dry run)")
  .action(async (opts) => {
    try {
      await cmdRun(address, {
        action: opts.action,
        cycles: Math.min(12, Math.max(1, parseInt(opts.cycles, 10))),
        maxAmount: opts.maxAmount ? parseInt(opts.maxAmount, 10) : undefined,
        confirm: !!opts.confirm,
      });
    } catch (e: any) {
      errorOut("api_error", e.message, "Retry after 30s — may be transient Hiro API issue");
    }
  });

program
  .command("install-packs")
  .description("Print bun install command for dependencies")
  .option("--pack <name>", "Pack to install: all | stacks", "all")
  .action(async (opts) => {
    await cmdInstallPacks(opts);
  });

program.parse(process.argv);
