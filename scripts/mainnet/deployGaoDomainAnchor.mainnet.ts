// GaoDomainAnchor — BASE MAINNET deploy script (B4 ceremony).
//
// **OPERATOR-ONLY.** This script is the canonical Base mainnet
// (chainId 8453) deploy entry for `GaoDomainAnchor`. It is a
// SIBLING of `scripts/deployGaoDomainAnchor.ts` — not a
// replacement. The dev/test script ALLOWS testnets and BANS
// mainnet; this script does the inverse: ALLOWS mainnet only and
// BANS every dev/test chain so a misconfigured `--network` falls
// closed.
//
// The script does NOT broadcast unless the operator sets the
// literal string `"true"` in `CONFIRM_DEPLOY_ANCHOR_MAINNET`.
// Default behaviour (env unset, env=any-other-value) prints what
// it WOULD do and exits 0. No transaction is sent on a dry-run.
//
// Operational contract:
//   1. Chain-allowlist gate (8453 only) + dev/test banlist (refuses
//      hardhat/sepolia/etc.) BEFORE any signer is loaded.
//   2. `CONFIRM_DEPLOY_ANCHOR_MAINNET=true` gate. Any other value
//      (or unset) runs as dry-run.
//   3. No constructor args. No owner / no access control on the
//      contract surface (see contracts/GaoDomainAnchor.sol comment).
//   4. Write `deployments/base/GaoDomainAnchor.json` with public
//      values only (no secret values).
//
// What this script does NOT do:
//   - Never logs `DEPLOYER_PRIVATE_KEY` or `BASE_RPC_URL`.
//   - Never updates production BE config. The on-disk record is
//     consumed manually by the operator after the ceremony.
//
// Usage (operator-only ceremony, trusted workstation):
//
//   # dry-run (default — prints what it would do, no tx sent)
//   npx hardhat run scripts/mainnet/deployGaoDomainAnchor.mainnet.ts --network base
//
//   # real deploy (operator-acknowledged)
//   CONFIRM_DEPLOY_ANCHOR_MAINNET=true \
//     npx hardhat run scripts/mainnet/deployGaoDomainAnchor.mainnet.ts --network base
//
//   # verify on Basescan (no constructor args)
//   BASESCAN_API_KEY=<set> \
//     npx hardhat verify --network base <ANCHOR_ADDRESS>
//
// Companion runbook: `docs/runbooks/base-mainnet-deploy-b4.md`.

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { ethers, network } from "hardhat";

/** Mainnet chain ids the script will broadcast against. Only Base
 *  mainnet. */
const ALLOWED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  8453, // Base mainnet
]);

/** Dev/test + foreign-mainnet chain ids the script explicitly
 *  refuses. Inverse of the dev/test script. */
const BANNED_NON_BASE_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  31337, 1337,             // hardhat
  84532, 11155111, 5,      // sepolia
  1, 10, 137, 42161, 56, 43114, // foreign mainnets
]);

/** Worker env-var key for the Base mainnet anchor address. Mirrors
 *  the dev/test script's WORKER_ENV_VAR_BY_NETWORK["base"] entry
 *  and `gao-id-worker:src/lib/chains.ts` catalog. */
const WORKER_ENV_VAR_BASE = "BASE_ANCHOR_CONTRACT_ADDRESS";

interface DeploymentRecord {
  contract: string;
  tier: string;
  network: string;
  chainId: number;
  address: string;
  deployer: string;
  deployTxHash: string | null;
  constructorArgs: Record<string, never>;
  deployedAt: string;
  sourceCommit: string | null;
  workerEnvVar: string;
  abiPath: string;
  notes: string[];
}

/** Best-effort current commit lookup. Returns null if `git` is not
 *  available or the repo is not a git checkout. */
function readSourceCommit(): string | null {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd: path.join(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // ── Guard 1: chainId gates (run BEFORE any signer load) ──────────
  const chainId = network.config.chainId;
  if (typeof chainId !== "number") {
    throw new Error(
      "REFUSED: network.config.chainId is undefined. Specify --network base.",
    );
  }
  if (BANNED_NON_BASE_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is NOT Base mainnet (8453). ` +
        `This is the MAINNET anchor deploy script — testnets and foreign ` +
        `mainnets are banlisted. For Base Sepolia, use ` +
        `scripts/deployGaoDomainAnchor.ts.`,
    );
  }
  if (!ALLOWED_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is not in the mainnet allowlist ` +
        `(${Array.from(ALLOWED_MAINNET_CHAIN_IDS).join(", ")}). ` +
        `Update ALLOWED_MAINNET_CHAIN_IDS via PR to add a new mainnet target.`,
    );
  }

  // ── Guard 2: explicit confirm flag ───────────────────────────────
  const confirm = (process.env.CONFIRM_DEPLOY_ANCHOR_MAINNET ?? "").trim();
  if (confirm !== "true") {
    console.log("─".repeat(70));
    console.log(`Network:    ${network.name} (chainId ${chainId})`);
    console.log("DRY-RUN — no transactions sent.");
    console.log("To broadcast (BASE MAINNET, OPERATOR-ONLY), re-run with:");
    console.log("  CONFIRM_DEPLOY_ANCHOR_MAINNET=true");
    console.log("─".repeat(70));
    return;
  }

  // ── Signer ───────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer available — set DEPLOYER_PRIVATE_KEY in .env");
  }
  const deployerAddress = await deployer.getAddress();

  console.log("─".repeat(70));
  console.log("Deploy GaoDomainAnchor — BASE MAINNET (B4 ceremony)");
  console.log(`Network:   ${network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployerAddress}`);
  console.log("CONFIRM_DEPLOY_ANCHOR_MAINNET=true — deploying.");
  console.log("─".repeat(70));

  const factory = await ethers.getContractFactory("GaoDomainAnchor");
  const anchor = await factory.deploy();
  const tx = anchor.deploymentTransaction();
  if (tx) {
    console.log(`Deploy tx:  ${tx.hash}`);
  }
  await anchor.waitForDeployment();
  const address = await anchor.getAddress();

  console.log("");
  console.log("GaoDomainAnchor deployed at:");
  console.log(`  ${address}`);
  console.log("");

  // ── Write ABI export (idempotent — matches dev/test pattern) ──────
  const artifact = await import(
    `${process.cwd()}/artifacts/contracts/GaoDomainAnchor.sol/GaoDomainAnchor.json`
  );
  const abisDir = path.resolve(process.cwd(), "abis");
  if (!fs.existsSync(abisDir)) fs.mkdirSync(abisDir, { recursive: true });
  const abiPath = path.join(abisDir, "GaoDomainAnchor.json");
  fs.writeFileSync(
    abiPath,
    JSON.stringify(
      { contractName: "GaoDomainAnchor", abi: (artifact as { abi: unknown }).abi },
      null,
      2,
    ),
  );
  console.log(`ABI:        ${path.relative(process.cwd(), abiPath)}`);

  // ── Write deployment record ──────────────────────────────────────
  // Path: `deployments/base/GaoDomainAnchor.json` — kebab `base`
  // matches the on-disk convention used by GaoDomainAnchor's
  // base-sepolia record at `deployments/base-sepolia/`.
  const deploymentsDir = path.resolve(process.cwd(), "deployments", "base");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const record: DeploymentRecord = {
    contract: "GaoDomainAnchor",
    tier: "production",
    network: "base",
    chainId,
    address,
    deployer: deployerAddress,
    deployTxHash: tx?.hash ?? null,
    constructorArgs: {},
    deployedAt: new Date().toISOString(),
    sourceCommit: readSourceCommit(),
    workerEnvVar: WORKER_ENV_VAR_BASE,
    abiPath: path.relative(process.cwd(), abiPath),
    notes: [
      "Base mainnet (chainId 8453) production deploy.",
      "No constructor args. No owner. Public append-only anchor log.",
      "Users self-anchor via their own wallet; no backend signer involved.",
    ],
  };
  const recordPath = path.join(deploymentsDir, "GaoDomainAnchor.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`Record:     ${path.relative(process.cwd(), recordPath)}`);

  console.log("");
  console.log("─".repeat(70));
  console.log("Next steps (operator-driven, NOT auto):");
  console.log(`  1. npx hardhat verify --network base ${address}`);
  console.log(`  2. Wrangler-secret-put on gao-id-worker-prod:`);
  console.log(`        ${WORKER_ENV_VAR_BASE}=${address}`);
  console.log("─".repeat(70));
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
