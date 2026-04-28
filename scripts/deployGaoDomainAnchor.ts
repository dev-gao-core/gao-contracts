// Deploy GaoDomainAnchor.
//
// Usage:
//   npm run deploy-anchor:base-sepolia      # test
//   npm run deploy-anchor:base              # mainnet (only with explicit operator approval)
//
// Required env (load from .env, NEVER commit secrets):
//   DEPLOYER_PRIVATE_KEY     EOA / hot wallet that signs the deploy.
//                            The contract has no owner — there's
//                            nothing to transfer post-deploy.
//   BASE_SEPOLIA_RPC_URL     RPC endpoint (private with API key).
//   BASE_RPC_URL             same, for mainnet.
// Optional:
//   BASESCAN_API_KEY         For optional `verify` step.
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
// For Base Sepolia that's `BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS`; for
// Base mainnet it's `BASE_ANCHOR_CONTRACT_ADDRESS`. The worker then
// `wrangler secret put`s these and unlocks the prepare → submit →
// reconcile flow.

import * as fs from "node:fs";
import * as path from "node:path";
import { ethers, network } from "hardhat";

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
  base: "base",
  baseSepolia: "base-sepolia",
  hardhat: "hardhat",
};

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer available — set DEPLOYER_PRIVATE_KEY in .env",
    );
  }
  const deployerAddress = await deployer.getAddress();
  const networkName = network.name;
  const chainId = network.config.chainId ?? null;

  console.log("─".repeat(70));
  console.log(`Network:    ${networkName} (chainId ${chainId ?? "?"})`);
  console.log(`Deployer:   ${deployerAddress}`);
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
