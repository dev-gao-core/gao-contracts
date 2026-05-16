// Deploy GaoDomainAnchor — DEV/TEST ONLY (Contracts Round 1 CC-4a fix).
//
// **DO NOT USE FOR MAINNET FROM THIS REPO.** The script enforces a
// chain-id allowlist + mainnet banlist + explicit
// `CONFIRM_DEPLOY_ANCHOR=true` env gate. Mainnet anchor deploys live
// in the private ops repo, not here. The previous `deploy-anchor:base`
// npm-script wrapper has been REMOVED from `package.json`.
//
// Usage (dev/test only):
//   npm run deploy-anchor:base-sepolia
//
// To actually broadcast (operator-acknowledged):
//   CONFIRM_DEPLOY_ANCHOR=true \
//     npx hardhat run scripts/deployGaoDomainAnchor.ts --network baseSepolia
//
// Required env (load from .env, NEVER commit secrets):
//   DEPLOYER_PRIVATE_KEY     EOA / hot wallet that signs the deploy.
//                            The contract has no owner — there's
//                            nothing to transfer post-deploy.
//   BASE_SEPOLIA_RPC_URL     RPC endpoint (private with API key).
// Optional:
//   BASESCAN_API_KEY         For optional `verify` step.
//   CONFIRM_DEPLOY_ANCHOR    Set to exactly "true" to broadcast. Any
//                            other value (or unset) runs as dry-run.
//
// After deploy, the script writes:
//
//   abis/GaoDomainAnchor.json                — contract ABI for downstream consumers
//   deployments/<network>/GaoDomainAnchor.json — chain-scoped deployment record
//
// And prints the env-var line the worker needs:
//
//   <KEY>_ANCHOR_CONTRACT_ADDRESS=0x...
//
// For Base Sepolia that's `BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS`. The
// worker then `wrangler secret put`s it and unlocks the prepare →
// submit → reconcile flow.

import * as fs from "node:fs";
import * as path from "node:path";
import { ethers, network } from "hardhat";

/** Chain ids the dev/test anchor deploy will broadcast against, IF
 *  the operator explicitly opts in via `CONFIRM_DEPLOY_ANCHOR=true`.
 *  Mirrors the V3 dev/test deploy script's allowlist for consistency.
 *  Adding a chain requires a reviewed PR. */
const ALLOWED_DEVTEST_CHAIN_IDS: ReadonlySet<number> = new Set([
  // Hardhat in-memory + standalone node — used by tests + local repl.
  31337, 1337,
  // Base Sepolia — the canonical dev/test L2 for Gao.
  84532,
  // Ethereum Sepolia — secondary dev/test target.
  11155111,
  // Sepolia legacy id — kept for completeness.
  5,
]);

/** Mainnet chain ids the script explicitly refuses, even if the
 *  confirm gate were set AND the allowlist were misconfigured.
 *  Belt-and-braces second gate. */
const BANNED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1,          // Ethereum
  8453,       // Base
  10,         // Optimism
  137,        // Polygon
  42161,      // Arbitrum One
  56,         // BNB Smart Chain
  43114,      // Avalanche C-Chain
]);

/** Operator must set this to the literal string "true" to broadcast. */
const CONFIRM_ENV = "CONFIRM_DEPLOY_ANCHOR";

interface DeploymentRecord {
  contractName: string;
  chain: string;
  chainId: number | null;
  address: string;
  deployer: string;
  txHash: string | null;
  deployedAt: string;
  abiPath: string;
  workerEnvVar: string;
}

// Map Hardhat network name → worker env-var key for the anchor contract
// address. Mirrors `gao-id-worker:src/lib/chains.ANCHOR_CHAIN_CATALOG`
// (`<KEY>_ANCHOR_CONTRACT_ADDRESS`).
const WORKER_ENV_VAR_BY_NETWORK: Record<string, string> = {
  base: "BASE_ANCHOR_CONTRACT_ADDRESS",
  baseSepolia: "BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS",
  hardhat: "HARDHAT_ANCHOR_CONTRACT_ADDRESS",
};

// Map Hardhat network name → on-disk directory name. Hardhat uses
// camelCase ("baseSepolia") but the worker + every doc uses
// kebab-case ("base-sepolia"); we record the kebab form so a copy-
// paste from `deployments/base-sepolia/...` stays consistent.
const DIR_NAME_BY_NETWORK: Record<string, string> = {
  baseSepolia: "base-sepolia",
  hardhat: "hardhat",
};

async function main(): Promise<void> {
  // ── Guard 1: chainId gates (run BEFORE any signer load) ──────────
  //
  // We refuse mainnet unconditionally and refuse anything outside the
  // dev/test allowlist. These checks run BEFORE `ethers.getSigners()`
  // so a misconfigured `--network` cannot even spin up a signer that
  // could later broadcast.
  const chainId = network.config.chainId;
  if (typeof chainId !== "number") {
    throw new Error(
      "REFUSED: network.config.chainId is undefined. Specify a known --network.",
    );
  }
  if (BANNED_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is a mainnet. This anchor deploy script is ` +
        `dev/test only. Mainnet anchor deploy lives in the private ops repo.`,
    );
  }
  if (!ALLOWED_DEVTEST_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is not on the anchor dev/test allowlist ` +
        `(${Array.from(ALLOWED_DEVTEST_CHAIN_IDS).join(", ")}). ` +
        `Update ALLOWED_DEVTEST_CHAIN_IDS via PR to add a new dev/test chain.`,
    );
  }

  // ── Guard 2: explicit confirm flag ────────────────────────────────
  //
  // Even on an allowlisted dev/test chain, the script runs as a
  // dry-run unless the operator sets the literal `"true"` value.
  // Any other value (including unset / whitespace / "True" /
  // "TRUE" / "1" / "yes") refuses to broadcast.
  const confirm = (process.env[CONFIRM_ENV] ?? "").trim();
  if (confirm !== "true") {
    console.log("─".repeat(70));
    console.log(`Network:    ${network.name} (chainId ${chainId})`);
    console.log(`DRY-RUN — no transactions sent.`);
    console.log(`To broadcast (DEV/TEST ONLY), re-run with: ${CONFIRM_ENV}=true`);
    console.log("─".repeat(70));
    return;
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer available — set DEPLOYER_PRIVATE_KEY in .env",
    );
  }
  const deployerAddress = await deployer.getAddress();
  const networkName = network.name;

  console.log("─".repeat(70));
  console.log(`Network:    ${networkName} (chainId ${chainId})`);
  console.log(`Deployer:   ${deployerAddress}`);
  console.log(`${CONFIRM_ENV}=true — deploying.`);
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
  console.log(`✅ GaoDomainAnchor deployed at:`);
  console.log(`   ${address}`);
  console.log("");

  // ── Write ABI export ───────────────────────────────────────────────
  //
  // Hardhat's `artifacts/` already holds the full artifact JSON, but
  // downstream tools (like `gao-id-worker`) only need the ABI array.
  // Mirror the convention to a stable path so the worker can import
  // it without depending on Hardhat's artifact directory layout.
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

  // ── Write deployment record ─────────────────────────────────────────
  const dirName = DIR_NAME_BY_NETWORK[networkName] ?? networkName;
  const deploymentsDir = path.resolve(process.cwd(), "deployments", dirName);
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const record: DeploymentRecord = {
    contractName: "GaoDomainAnchor",
    chain: dirName,
    chainId,
    address,
    deployer: deployerAddress,
    txHash: tx?.hash ?? null,
    deployedAt: new Date().toISOString(),
    abiPath: path.relative(process.cwd(), abiPath),
    workerEnvVar: WORKER_ENV_VAR_BY_NETWORK[networkName] ?? "ANCHOR_CONTRACT_ADDRESS",
  };
  const recordPath = path.join(deploymentsDir, "GaoDomainAnchor.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`Record:     ${path.relative(process.cwd(), recordPath)}`);

  console.log("");
  console.log("─".repeat(70));
  console.log("Set this on the worker:");
  console.log("");
  console.log(`  ${record.workerEnvVar}=${address}`);
  console.log("");
  console.log("Then:");
  console.log(`  npx wrangler secret put ${record.workerEnvVar}`);
  console.log("  npx wrangler deploy");
  console.log("─".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
