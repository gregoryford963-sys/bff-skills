#!/usr/bin/env bun
/**
 * Stackspot Lottery Joiner — Autonomous STX pot participation on Stackspot.app
 *
 * Commands: doctor | run | install-packs
 * Actions (run): list | status --pot-name <n> | join --pot-name <n> --amount <stx> [--confirm]
 *
 * On-chain reads via Hiro read-only endpoint. Writes output MCP params for agent broadcast.
 * Built by 369SunRay — tested on mainnet.
 */

import {
  fetchCallReadOnlyFunction,
  cvToJSON,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Constants ────────────────────────────────────────────────────────────────

const NETWORK = STACKS_MAINNET;
const HIRO_API = "https://api.hiro.so";

const POT_DEPLOYER = "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85";

// Default safety limits
const DEFAULT_MAX_JOIN_STX = 1000;
const GAS_RESERVE_STX = 5;
const MIN_GAS_USTX = GAS_RESERVE_STX * 1_000_000;

interface PotInfo {
  name: string;
  contractName: string;
  maxParticipants: number;
  minAmountStx: number;
}

const KNOWN_POTS: PotInfo[] = [
  { name: "Genesis",       contractName: "Genesis",       maxParticipants: 2,   minAmountStx: 20  },
  { name: "BuildOnBitcoin",contractName: "BuildOnBitcoin",maxParticipants: 10,  minAmountStx: 100 },
  { name: "STXLFG",        contractName: "STXLFG",        maxParticipants: 100, minAmountStx: 21  },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ── Output helpers ───────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function blocked(code: string, message: string, next: string): void {
  out({ status: "blocked", action: next, data: {}, error: { code, message, next } });
}

function fail(code: string, message: string, next: string): void {
  out({ status: "error", action: next, data: {}, error: { code, message, next } });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWalletAddress(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) {
    fail("no_wallet", "No wallet address found. Set STACKS_ADDRESS env var.", "Configure wallet");
    process.exit(1);
  }
  return addr;
}

function parseArgs(): Record<string, string> {
  const result: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.slice(2, eqIdx);
        result[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          // --key value
          result[key] = next;
          i++;
        } else {
          // --flag (boolean)
          result[key] = "true";
        }
      }
    }
  }
  return result;
}

function getCommand(): string {
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Hiro API error: ${res.status}`);
  const d = await res.json() as { balance: string; locked: string };
  return parseInt(d.balance, 10) - parseInt(d.locked || "0", 10);
}

function cvJsonValue(cv: unknown): unknown {
  if (cv === null || cv === undefined) return cv;
  if (typeof cv !== "object") return cv;
  const j = cv as Record<string, unknown>;
  const t = String(j.type || "");
  // Response/ok wrapper — unwrap the value
  if (t.includes("response") || t === "ok") {
    if (j.success === true || j.success === "true") {
      return cvJsonValue(j.value);
    }
    return { error: cvJsonValue(j.value) };
  }
  if (t === "uint" || t === "int") return j.value;
  if (t === "bool") return j.value === "true" || j.value === true;
  if (t === "none") return null;
  if (t === "some" && j.value !== undefined) return cvJsonValue(j.value);
  if (t === "err") return { error: cvJsonValue(j.value) };
  if (t === "tuple" && j.value && typeof j.value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j.value as Record<string, unknown>)) {
      out[k] = cvJsonValue(v);
    }
    return out;
  }
  // Plain object with no type — treat as tuple value map (cvToJSON inlines tuple fields)
  if (!t && typeof j === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) {
      out[k] = cvJsonValue(v);
    }
    return out;
  }
  // Fallback
  return j.value !== undefined ? cvJsonValue(j.value) : cv;
}

async function callPotReadOnly(
  contractName: string,
  functionName: string,
  functionArgs: unknown[] = []
): Promise<unknown> {
  try {
    const result = await fetchCallReadOnlyFunction({
      network: NETWORK,
      contractAddress: POT_DEPLOYER,
      contractName,
      functionName,
      functionArgs: functionArgs as any,
      senderAddress: POT_DEPLOYER,
    });
    const json = cvToJSON(result);
    return cvJsonValue(json);
  } catch (e: any) {
    throw new Error(`Read-only call ${contractName}::${functionName} failed: ${e.message}`);
  }
}

async function getPotState(contractName: string): Promise<{
  potValueUstx: string | null;
  isLocked: boolean | null;
  reachable: boolean;
}> {
  try {
    const [potValue, isLocked] = await Promise.all([
      callPotReadOnly(contractName, "get-pot-value", []).catch(() => null),
      callPotReadOnly(contractName, "is-locked", []).catch(() => null),
    ]);
    return {
      potValueUstx: potValue,
      isLocked: isLocked === true || isLocked === "true" ? true : isLocked === false || isLocked === "false" ? false : null,
      reachable: true,
    };
  } catch {
    return { potValueUstx: null, isLocked: null, reachable: false };
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const address = getWalletAddress();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // STX gas check
  try {
    const bal = await getStxBalance(address);
    checks["stx_gas"] = {
      ok: bal >= MIN_GAS_USTX,
      detail: `${bal} uSTX available (need ${MIN_GAS_USTX} min)`,
    };
  } catch (e: any) {
    checks["stx_gas"] = { ok: false, detail: e.message };
  }

  // Pot reachability
  let reached = 0;
  for (const pot of KNOWN_POTS) {
    try {
      await callPotReadOnly(pot.contractName, "get-pot-value", []);
      reached++;
    } catch {
      // pot unreachable
    }
  }
  checks["pots_reachable"] = {
    ok: reached === KNOWN_POTS.length,
    detail: `${reached}/${KNOWN_POTS.length} pots reachable`,
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  const blockers = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`);

  if (allOk) {
    out({
      status: "success",
      action: "Environment ready. Run with --action=list to see open pots.",
      data: { checks, address },
      error: null,
    });
  } else {
    out({
      status: "blocked",
      action: "Fix blockers before proceeding",
      data: { checks, address, blockers },
      error: {
        code: "doctor_failed",
        message: blockers.join("; "),
        next: "Resolve the listed issues and re-run doctor",
      },
    });
  }
}

async function cmdList(): Promise<void> {
  const pots = await Promise.all(
    KNOWN_POTS.map(async (pot) => {
      const state = await getPotState(pot.contractName);
      return {
        name: pot.name,
        contract: `${POT_DEPLOYER}.${pot.contractName}`,
        minAmountStx: pot.minAmountStx,
        maxParticipants: pot.maxParticipants,
        potValueUstx: state.potValueUstx,
        isLocked: state.isLocked,
        reachable: state.reachable,
      };
    })
  );

  const open = pots.filter((p) => p.reachable && p.isLocked === false);

  out({
    status: "success",
    action:
      open.length > 0
        ? `${open.length} open pot(s) found. Use --action=join --pot-name <name> --amount <stx>.`
        : "No open pots found. All pots may be locked or unreachable.",
    data: { total: pots.length, open: open.length, pots },
    error: null,
  });
}

async function cmdStatus(potName: string): Promise<void> {
  const known = KNOWN_POTS.find(
    (p) => p.contractName.toLowerCase() === potName.toLowerCase()
  );
  const contractName = known ? known.contractName : potName;

  let potValue: unknown = null;
  let isLocked: unknown = null;
  let configs: unknown = null;

  try {
    [potValue, isLocked, configs] = await Promise.all([
      callPotReadOnly(contractName, "get-pot-value", []).catch(() => null),
      callPotReadOnly(contractName, "is-locked", []).catch(() => null),
      callPotReadOnly(contractName, "get-configs", []).catch(() => null),
    ]);
  } catch (e: any) {
    fail("read_failed", e.message, "Check pot name and retry");
    return;
  }

  out({
    status: "success",
    action: isLocked
      ? "Pot is locked — stacking cycle in progress. Wait for cycle to end."
      : "Pot is open. Use --action=join to participate.",
    data: {
      contractName,
      contract: `${POT_DEPLOYER}.${contractName}`,
      minAmountStx: known?.minAmountStx ?? null,
      maxParticipants: known?.maxParticipants ?? null,
      potValueUstx: potValue,
      isLocked,
      configs,
    },
    error: null,
  });
}

async function cmdJoin(
  potName: string,
  amountStx: number,
  maxJoinStx: number,
  confirm: boolean
): Promise<void> {
  const address = getWalletAddress();

  // Find pot
  const known = KNOWN_POTS.find(
    (p) => p.contractName.toLowerCase() === potName.toLowerCase()
  );
  const contractName = known ? known.contractName : potName;
  const minStx = known?.minAmountStx ?? 1;

  // Validate amount
  if (amountStx <= 0) {
    fail("invalid_amount", "--amount must be a positive STX value", "Specify a valid --amount");
    return;
  }

  if (amountStx < minStx) {
    blocked(
      "below_minimum",
      `${amountStx} STX < minimum ${minStx} STX for pot ${contractName}`,
      `Use --amount at least ${minStx}`
    );
    return;
  }

  if (amountStx > maxJoinStx) {
    blocked(
      "exceeds_limit",
      `${amountStx} STX > max-join-stx limit of ${maxJoinStx} STX`,
      `Reduce --amount or set --max-join-stx=${amountStx} to override`
    );
    return;
  }

  // Check pot state
  const state = await getPotState(contractName);
  if (!state.reachable) {
    fail("pot_unreachable", `Contract ${POT_DEPLOYER}.${contractName} not reachable`, "Check pot name");
    return;
  }
  if (state.isLocked === true) {
    blocked(
      "pot_locked",
      `Pot ${contractName} is locked — stacking cycle in progress`,
      "Wait for cycle to end or choose a different pot"
    );
    return;
  }

  // Check STX balance
  let stxBalance = 0;
  try {
    stxBalance = await getStxBalance(address);
  } catch (e: any) {
    fail("balance_check_failed", e.message, "Check Hiro API connectivity");
    return;
  }

  const amountUstx = amountStx * 1_000_000;
  const reserveUstx = GAS_RESERVE_STX * 1_000_000;

  if (stxBalance < amountUstx + reserveUstx) {
    blocked(
      "insufficient_balance",
      `Balance ${stxBalance} uSTX < required ${amountUstx + reserveUstx} uSTX (${amountStx} STX + ${GAS_RESERVE_STX} STX gas reserve)`,
      `Reduce --amount or fund wallet. Available for join: ${Math.floor(Math.max(0, stxBalance - reserveUstx) / 1_000_000)} STX`
    );
    return;
  }

  const safetyChecks = {
    pot_not_locked: true,
    balance_sufficient: true,
    gas_reserve_ok: true,
    within_spend_limit: true,
  };

  if (!confirm) {
    // Dry run
    out({
      status: "success",
      action: `DRY RUN — Pass --confirm to execute. Joining ${contractName} with ${amountStx} STX.`,
      data: {
        dry_run: true,
        pot_name: contractName,
        amount_stx: amountStx,
        amount_ustx: amountUstx,
        contract: `${POT_DEPLOYER}.${contractName}`,
        function: "join-pot",
        gas_reserve_stx: GAS_RESERVE_STX,
        stx_balance_ustx: stxBalance,
        safety_checks_passed: true,
        safety_checks: safetyChecks,
      },
      error: null,
    });
    return;
  }

  // Confirmed — output MCP execution params
  out({
    status: "success",
    action: "Execute join via MCP stackspot_join_pot tool",
    data: {
      dry_run: false,
      mcp_command: {
        tool: "stackspot_join_pot",
        params: {
          contractName,
          amount: amountUstx.toString(),
        },
      },
      pre_checks_passed: safetyChecks,
      pot_name: contractName,
      amount_stx: amountStx,
      amount_ustx: amountUstx,
      contract: `${POT_DEPLOYER}.${contractName}`,
      stx_balance_before_ustx: stxBalance,
    },
    error: null,
  });
}

async function cmdInstallPacks(): Promise<void> {
  out({
    status: "success",
    action: "Run the install command below to add required packages",
    data: { command: "bun add @stacks/transactions @stacks/network" },
    error: null,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const cmd = getCommand();
const args = parseArgs();

(async () => {
  switch (cmd) {
    case "doctor":
      await cmdDoctor();
      break;

    case "run": {
      const action = args["action"] || "";
      switch (action) {
        case "list":
          await cmdList();
          break;
        case "status": {
          const potName = args["pot-name"] || args["pot_name"];
          if (!potName) {
            fail("missing_arg", "--pot-name is required for status", "Pass --pot-name <name>");
            break;
          }
          await cmdStatus(potName);
          break;
        }
        case "join": {
          const potName = args["pot-name"] || args["pot_name"];
          const amountStx = parseFloat(args["amount"] || "0");
          const maxJoinStx = parseFloat(args["max-join-stx"] || String(DEFAULT_MAX_JOIN_STX));
          const confirm = "confirm" in args;

          if (!potName) {
            fail("missing_arg", "--pot-name is required for join", "Pass --pot-name <name>");
            break;
          }
          if (!amountStx) {
            fail("missing_arg", "--amount is required for join (in STX)", "Pass --amount <stx>");
            break;
          }
          await cmdJoin(potName, amountStx, maxJoinStx, confirm);
          break;
        }
        default:
          fail(
            "unknown_action",
            `Unknown action: ${action || "(none)"}. Valid: list | status | join`,
            "Pass --action=list | status | join"
          );
      }
      break;
    }

    case "install-packs":
      await cmdInstallPacks();
      break;

    default:
      out({
        status: "error",
        action: "Pass a command: doctor | run | install-packs",
        data: {
          usage:
            "bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts doctor\n" +
            "bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run --action list\n" +
            "bun run stackspot-lottery-joiner/stackspot-lottery-joiner.ts run --action join --pot-name STXLFG --amount 21",
        },
        error: {
          code: "missing_command",
          message: "No command provided",
          next: "Pass doctor | run | install-packs",
        },
      });
  }
})();
