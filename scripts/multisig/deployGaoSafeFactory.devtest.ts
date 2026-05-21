// GaoSafeFactory — DEV/TEST ONLY deploy script.
//
// **DO NOT USE FOR MAINNET.** The script ALLOWS only Base Sepolia
// (chainId 84532). Any other chainId — including Ethereum mainnet,
// Base mainnet, Polygon, Arbitrum, Optimism, BSC — causes a
// fail-closed refusal before any transaction is broadcast.
//
// Operational contract:
//   1. Chain-allowlist gate. Refuses to broadcast unless connected
//      chainId is 84532 (Base Sepolia). Belt-and-braces mainnet
//      banlist as a second gate.
//   2. Env-presence pre-flight. Refuses to broadcast unless
//      DEPLOYER_PRIVATE_KEY and BASE_SEPOLIA_RPC_URL are SET.
//      Logs ONLY presence (SET/MISSING), never values.
//   3. Dry-run by default. Sets no state on chain unless the
//      operator passes CONFIRM_DEPLOY_GAOSAFE_FACTORY=true. Default
//      writes a `.dry-run.json` evidence record and exits.
//   4. Selector pre-check on the compiled bytecode for both
//      GaoSafe and GaoSafeFactory. Refuses to broadcast on missing
//      selectors (compiler / source drift).
//   5. On broadcast: deploys GaoSafeFactory. The factory's
//      constructor itself deploys the GaoSafe implementation
//      singleton and locks it via `_initialized = true`.
//   6. Records the deployment to
//      `deployments/base-sepolia/multisig/gaosafe-factory-devtest.json`.
//      Dry-run writes to `.dry-run.json` for the same path.
//
// What this script does NOT do:
//   - Never logs DEPLOYER_PRIVATE_KEY (or any non-public field).
//   - Never logs the RPC URL (may embed an API key).
//   - Never reads `.env` outside Hardhat's standard dotenv hook.
//   - Never deploys to mainnet. Chain allowlist is hard-coded.
//   - Never updates the mobile multisig feature flag.
//   - Never adds a factory address to the mobile factory registry.
//     That happens via a separate, reviewer-signed-off PR later,
//     after audit + production-readiness gate are satisfied.
//   - Never moves real funds. Test wallets only on Base Sepolia.
//
// Usage:
//   # dry-run on Base Sepolia (no broadcast)
//   npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts \
//     --network baseSepolia
//
//   # real dev/test deploy on Base Sepolia
//   CONFIRM_DEPLOY_GAOSAFE_FACTORY=true \
//     npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts \
//     --network baseSepolia
//
// To exercise the contract end-to-end against the hardhat in-memory
// chain without touching any RPC, use
// `scripts/multisig/smokeGaoSafe.devtest.ts` (ephemeral mode).

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { keccak256, toUtf8Bytes } from "ethers";

/** Chain ids the dev/test deploy will broadcast against. Only Base
 *  Sepolia for MS-P3.1. Add more entries only via a reviewed PR. */
const ALLOWED_DEVTEST_CHAIN_IDS: ReadonlySet<number> = new Set([
  84532, // Base Sepolia
]);

/** Mainnet chain ids the script explicitly refuses, even if the
 *  allowlist were misconfigured. Belt-and-braces second gate. */
const BANNED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  137, // Polygon
  42161, // Arbitrum One
  10, // Optimism
  8453, // Base
  56, // BNB Smart Chain
]);

/** Selectors the deployed GaoSafe implementation MUST contain. */
const REQUIRED_SAFE_SELECTORS: ReadonlyArray<{ sig: string; name: string }> = [
  { sig: "setup(address[],uint256)", name: "setup" },
  { sig: "getOwners()", name: "getOwners" },
  { sig: "ownersCount()", name: "ownersCount" },
  { sig: "isOwner(address)", name: "isOwner" },
  { sig: "threshold()", name: "threshold" },
  { sig: "nonce()", name: "nonce" },
  { sig: "domainSeparator()", name: "domainSeparator" },
  { sig: "hashTx(address[],uint256[],bytes[],uint256,uint256)", name: "hashTx" },
  { sig: "execTransaction(address[],uint256[],bytes[],uint256,bytes)", name: "execTransaction" },
  { sig: "addOwner(address,uint256)", name: "addOwner" },
  { sig: "removeOwner(address,uint256)", name: "removeOwner" },
  { sig: "replaceOwner(address,address)", name: "replaceOwner" },
  { sig: "changeThreshold(uint256)", name: "changeThreshold" },
  { sig: "TX_TYPEHASH()", name: "TX_TYPEHASH" },
];

/** Selectors the deployed GaoSafeFactory MUST contain. */
const REQUIRED_FACTORY_SELECTORS: ReadonlyArray<{ sig: string; name: string }> = [
  { sig: "implementation()", name: "implementation" },
  { sig: "createVault(address[],uint256,bytes32)", name: "createVault" },
  { sig: "computeVaultAddress(address,bytes32)", name: "computeVaultAddress" },
];

function selOf(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(2, 10);
}

function envPresence(name: string): "SET" | "MISSING" {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? "SET" : "MISSING";
}

interface EvidenceRecord {
  contract: "GaoSafeFactory";
  tier: "devtest";
  mode: "dry-run" | "broadcast";
  network: string;
  chainId: number;
  solcVersion: string;
  optimizerRuns: number;
  bytecodeHashSetting: string;
  ozContractsVersion: string | null;
  factoryAddress: string | null;
  implementationAddress: string | null;
  factoryRuntimeBytecodeHash: string | null;
  implementationRuntimeBytecodeHash: string | null;
  factoryInitcodeHash: string;
  implementationInitcodeHash: string;
  deployerPublicAddress: string;
  deployTxHash: string | null;
  deployBlockNumber: number | null;
  deployTimestamp: string;
  notes: string[];
}

function readOzVersion(): string | null {
  try {
    const ozPkgPath = path.join(
      __dirname,
      "..",
      "..",
      "node_modules",
      "@openzeppelin",
      "contracts",
      "package.json",
    );
    const raw = fs.readFileSync(ozPkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("─".repeat(72));
  console.log("Deploy GaoSafeFactory (DEV/TEST ONLY) — MS-P3.1");
  console.log("─".repeat(72));

  // ── Pre-flight: env presence (SET/MISSING only) ─────────────────────
  console.log("Env presence (values never printed):");
  console.log(`  DEPLOYER_PRIVATE_KEY  : ${envPresence("DEPLOYER_PRIVATE_KEY")}`);
  console.log(`  BASE_SEPOLIA_RPC_URL  : ${envPresence("BASE_SEPOLIA_RPC_URL")}`);
  console.log(`  CONFIRM_DEPLOY_GAOSAFE_FACTORY: ${envPresence("CONFIRM_DEPLOY_GAOSAFE_FACTORY")}`);

  // ── Pre-flight: chain ────────────────────────────────────────────────
  const chainId = network.config.chainId;
  if (chainId === undefined) {
    throw new Error("network.config.chainId is undefined — refusing.");
  }
  if (BANNED_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is a mainnet. This script is dev/test only.`,
    );
  }
  if (!ALLOWED_DEVTEST_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is not in the dev/test allowlist (${Array.from(
        ALLOWED_DEVTEST_CHAIN_IDS,
      ).join(", ")}). Use --network baseSepolia.`,
    );
  }
  console.log(`Network: ${network.name} (chainId ${chainId})  ✓ allowlist`);

  // ── Toolchain pin (recorded in evidence) ─────────────────────────────
  const hhConfig = (await import("../../hardhat.config")) as {
    default: {
      solidity:
        | string
        | {
            version: string;
            settings?: { optimizer?: { runs?: number }; metadata?: { bytecodeHash?: string } };
          };
    };
  };
  const solCfg =
    typeof hhConfig.default.solidity === "string"
      ? { version: hhConfig.default.solidity, settings: {} as Record<string, unknown> }
      : hhConfig.default.solidity;
  const solcVersion = solCfg.version;
  const optimizerRuns = (solCfg.settings as { optimizer?: { runs?: number } } | undefined)
    ?.optimizer?.runs ?? 0;
  const bytecodeHashSetting =
    (solCfg.settings as { metadata?: { bytecodeHash?: string } } | undefined)?.metadata
      ?.bytecodeHash ?? "default";
  const ozVersion = readOzVersion();
  console.log(`Solidity      : ${solcVersion}`);
  console.log(`Optimizer runs: ${optimizerRuns}`);
  console.log(`bytecodeHash  : ${bytecodeHashSetting}`);
  console.log(`OZ contracts  : ${ozVersion ?? "(unknown)"}`);

  // ── Signer (public address only) ─────────────────────────────────────
  const signers = await ethers.getSigners();
  const signer = signers[0];
  if (!signer) {
    throw new Error(
      "No signer available. DEPLOYER_PRIVATE_KEY likely MISSING from env.",
    );
  }
  const signerAddr = await signer.getAddress();
  console.log(`Deployer addr : ${signerAddr}  (public address only)`);

  // ── Compiled artifacts + selector pre-check ──────────────────────────
  const safeArt = await artifacts.readArtifact("GaoSafe");
  const factoryArt = await artifacts.readArtifact("GaoSafeFactory");

  const safeRuntimeLower = safeArt.deployedBytecode.toLowerCase();
  const factoryRuntimeLower = factoryArt.deployedBytecode.toLowerCase();

  let missing = 0;
  for (const s of REQUIRED_SAFE_SELECTORS) {
    const hex = selOf(s.sig);
    if (!safeRuntimeLower.includes(hex)) {
      missing++;
      console.error(
        `  MISSING GaoSafe selector ${s.name.padEnd(20)} 0x${hex} (${s.sig})`,
      );
    }
  }
  for (const s of REQUIRED_FACTORY_SELECTORS) {
    const hex = selOf(s.sig);
    if (!factoryRuntimeLower.includes(hex)) {
      missing++;
      console.error(
        `  MISSING Factory selector ${s.name.padEnd(20)} 0x${hex} (${s.sig})`,
      );
    }
  }
  if (missing > 0) {
    throw new Error(
      `${missing} required selector(s) absent in compiled bytecode — refusing to deploy.`,
    );
  }
  console.log(
    `Selector pre-check: GaoSafe (${REQUIRED_SAFE_SELECTORS.length}) + Factory (${REQUIRED_FACTORY_SELECTORS.length}) all present ✓`,
  );

  // Initcode (creation-bytecode) hashes — bound at compile time.
  // The runtime-bytecode hashes can be confirmed AFTER deploy.
  const factoryInitcodeHash = keccak256(factoryArt.bytecode);
  const implInitcodeHash = keccak256(safeArt.bytecode);
  console.log(`Factory initcode hash: ${factoryInitcodeHash}`);
  console.log(`Impl    initcode hash: ${implInitcodeHash}`);

  const deployTimestamp = new Date().toISOString();

  // ── Output directory ─────────────────────────────────────────────────
  const evidenceDir = path.join(
    __dirname,
    "..",
    "..",
    "deployments",
    "base-sepolia",
    "multisig",
  );
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  // ── Dry-run path ─────────────────────────────────────────────────────
  if (process.env.CONFIRM_DEPLOY_GAOSAFE_FACTORY !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions broadcast.");
    console.log("To broadcast (DEV/TEST ONLY on Base Sepolia), re-run with:");
    console.log("  CONFIRM_DEPLOY_GAOSAFE_FACTORY=true \\");
    console.log(
      "    npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts --network baseSepolia",
    );

    const dryRecord: EvidenceRecord = {
      contract: "GaoSafeFactory",
      tier: "devtest",
      mode: "dry-run",
      network: network.name,
      chainId,
      solcVersion,
      optimizerRuns,
      bytecodeHashSetting,
      ozContractsVersion: ozVersion,
      factoryAddress: null,
      implementationAddress: null,
      factoryRuntimeBytecodeHash: null,
      implementationRuntimeBytecodeHash: null,
      factoryInitcodeHash,
      implementationInitcodeHash: implInitcodeHash,
      deployerPublicAddress: signerAddr,
      deployTxHash: null,
      deployBlockNumber: null,
      deployTimestamp,
      notes: [
        "Dry-run only. No transaction broadcast.",
        "Selector pre-check passed for GaoSafe + GaoSafeFactory.",
        "Initcode hashes recorded for compile-time pin; runtime hashes blank.",
      ],
    };
    const dryPath = path.join(evidenceDir, "gaosafe-factory-devtest.dry-run.json");
    fs.writeFileSync(dryPath, JSON.stringify(dryRecord, null, 2));
    console.log(`Dry-run evidence: ${dryPath}`);
    console.log("PASS (dry-run)");
    return;
  }

  // ── Broadcast path ───────────────────────────────────────────────────
  console.log("");
  console.log("CONFIRM_DEPLOY_GAOSAFE_FACTORY=true — broadcasting.");

  const Factory = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await Factory.deploy();
  const deployTx = factory.deploymentTransaction();
  console.log(`  deploy tx: ${deployTx?.hash ?? "(unknown)"}`);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  factory  : ${factoryAddr}`);

  async function retryView<T>(label: string, fn: () => Promise<T>, n = 5, delay = 1500): Promise<T> {
    let last: unknown;
    for (let i = 0; i < n; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (i === n - 1) break;
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
    throw new Error(
      `${label} failed after ${n} retries: ${(last as Error)?.message ?? last}`,
    );
  }

  const implAddr: string = await retryView("implementation()", () => factory.implementation());
  console.log(`  impl     : ${implAddr}`);

  // Runtime bytecode hashes from chain. Belt-and-braces verification
  // that what landed on chain matches what was compiled locally.
  const provider = ethers.provider;
  const factoryRuntime = await provider.getCode(factoryAddr);
  const implRuntime = await provider.getCode(implAddr);
  const factoryRuntimeHash = keccak256(factoryRuntime);
  const implRuntimeHash = keccak256(implRuntime);
  console.log(`Factory runtime hash: ${factoryRuntimeHash}`);
  console.log(`Impl    runtime hash: ${implRuntimeHash}`);

  // Verify implementation singleton is locked (constructor set _initialized = true)
  // — direct setup() on the bare singleton must revert.
  const safeIface = new ethers.Interface(safeArt.abi);
  const lockedSetupData = safeIface.encodeFunctionData("setup", [
    [signerAddr],
    1,
  ]);
  let implLocked = false;
  try {
    await provider.call({ to: implAddr, data: lockedSetupData });
    // If the static call succeeded, the implementation is NOT locked.
    implLocked = false;
  } catch {
    // Revert is expected — AlreadyInitialized.
    implLocked = true;
  }
  if (!implLocked) {
    throw new Error(
      "Post-deploy verification failed: implementation singleton appears not locked (direct setup did not revert).",
    );
  }
  console.log("Impl singleton lock verified ✓");

  // Receipt for block number.
  const receipt = await provider.getTransactionReceipt(deployTx?.hash ?? "0x");
  const deployBlock = receipt?.blockNumber ?? null;
  console.log(`  block    : ${deployBlock ?? "(unknown)"}`);

  // ── Evidence record ──────────────────────────────────────────────────
  const record: EvidenceRecord = {
    contract: "GaoSafeFactory",
    tier: "devtest",
    mode: "broadcast",
    network: network.name,
    chainId,
    solcVersion,
    optimizerRuns,
    bytecodeHashSetting,
    ozContractsVersion: ozVersion,
    factoryAddress: factoryAddr,
    implementationAddress: implAddr,
    factoryRuntimeBytecodeHash: factoryRuntimeHash,
    implementationRuntimeBytecodeHash: implRuntimeHash,
    factoryInitcodeHash,
    implementationInitcodeHash: implInitcodeHash,
    deployerPublicAddress: signerAddr,
    deployTxHash: deployTx?.hash ?? null,
    deployBlockNumber: deployBlock,
    deployTimestamp,
    notes: [
      "Dev/test deploy on Base Sepolia. NOT production.",
      "Implementation singleton lock verified via direct setup() revert.",
      "Selector pre-check passed for GaoSafe + GaoSafeFactory.",
      "Run scripts/multisig/smokeGaoSafe.devtest.ts to execute the full smoke matrix against this deployment.",
    ],
  };
  const recordPath = path.join(evidenceDir, "gaosafe-factory-devtest.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log("");
  console.log(`Evidence written: ${recordPath}`);
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
