// GaoDomainDepositV3 — DEV/TEST ONLY deploy script.
//
// **DO NOT USE FOR MAINNET.** The script ALLOWS only the network IDs
// in `ALLOWED_DEVTEST_CHAIN_IDS` (Base Sepolia + Hardhat in-memory
// + Hardhat local node + Sepolia + Ethereum Sepolia). It HARD-REFUSES
// to send a single transaction on Base mainnet (chainId 8453),
// Ethereum mainnet (chainId 1), or any other id not on the allowlist.
//
// Operational contract:
//   1. Pre-flight env: refuses to broadcast unless `DEPLOYER_PRIVATE_KEY`,
//      `BASE_SEPOLIA_RPC_URL` (or matching RPC for the chosen network),
//      `GAO_OWNER_ADDRESS`, `GAO_TREASURY_ADDRESS`, and
//      `GAO_USDC_ADDRESS` are set. None of these values is logged —
//      we log only PUBLIC checksummed addresses, never the deployer
//      private key.
//   2. Chain-allowlist gate. Refuses to broadcast unless the connected
//      chainId is in `ALLOWED_DEVTEST_CHAIN_IDS`.
//   3. Dry-run by default. Sets no state on chain unless the operator
//      passes `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true`. Default exits
//      after printing what it would have done.
//   4. Bytecode selector pre-check on the compiled artifact. Refuses to
//      broadcast on a missing-selector mismatch (compiler / source
//      drift).
//   5. On broadcast: deploys V3 with the operator-supplied
//      `(initialOwner, initialTreasury)`, allowlists USDC, retries
//      every post-deploy view to absorb RPC tip-lag (same pattern as
//      `deploy-domain-deposit-v2.ts`).
//   6. Writes a deployment record to
//      `deployments/devtest/<network>/GaoDomainDepositV3.json`. The
//      `devtest/` directory is the explicit signal that this artifact
//      is NOT production.
//
// What this script does NOT do:
//   - Never logs `DEPLOYER_PRIVATE_KEY`. Reads it once via the
//     hardhat provider (`network.config.accounts`) without rendering.
//   - Never reads `.env` files outside of hardhat's standard dotenv
//     hook. The operator is expected to provision the env via
//     `wrangler secret put` or 1Password-CLI / direnv from a trusted
//     workstation.
//   - Never deploys to mainnet. The chainId allowlist is a hard
//     guard; even a misconfigured `--network` fails closed.
//   - Never updates production BE config. The deployment record
//     under `deployments/devtest/` is consumed by the operator
//     manually; no automated promotion to production.
//   - Never moves V2 funds. Refuses to read V2 storage. Strictly
//     constructor + setAllowedToken + post-deploy verify.
//
// Usage (dev/test):
//   # dry-run on Base Sepolia
//   GAO_OWNER_ADDRESS=0x... \
//   GAO_TREASURY_ADDRESS=0x... \
//   GAO_USDC_ADDRESS=0x... \
//     npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
//
//   # real dev/test deploy
//   CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true \
//   GAO_OWNER_ADDRESS=0x... \
//   GAO_TREASURY_ADDRESS=0x... \
//   GAO_USDC_ADDRESS=0x... \
//     npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
//
// To exercise end-to-end against the hardhat in-memory chain without
// touching any RPC, use `scripts/smokeGaoDomainDepositV3.devtest.ts`
// — that script bypasses this deploy script entirely and is the
// canonical CI / quick-eval path.

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { keccak256, toUtf8Bytes } from "ethers";

/** Chain ids the dev/test deploy will broadcast against. Any chainId
 *  NOT on this list — including Base mainnet (8453) and Ethereum
 *  mainnet (1) — causes a fail-closed refusal before any tx is sent.
 *  Add more entries here only via a reviewed PR. */
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
 *  allowlist were misconfigured. Belt-and-braces second gate. */
const BANNED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1,          // Ethereum
  8453,       // Base
  10,         // Optimism
  137,        // Polygon
  42161,      // Arbitrum One
  56,         // BNB Smart Chain
  43114,      // Avalanche C-Chain
]);

/** Selectors the deployed V3 bytecode MUST contain. Same surface as
 *  V2's selector matrix plus the V3-only `AffiliateSelfWithdrawDisabled`
 *  is NOT a selector — it's a custom error. The selector
 *  `withdrawAffiliate(address,uint256)` is still present on V3 (it
 *  reverts) so it appears here. */
const REQUIRED_SELECTORS: ReadonlyArray<{ sig: string; name: string }> = [
  { sig: "deposit(address,bytes32,bytes32,address,uint256)", name: "deposit" },
  { sig: "getDeposit(bytes32)",                              name: "getDeposit" },
  { sig: "isPending(bytes32)",                               name: "isPending" },
  { sig: "accountedBalance(address)",                        name: "accountedBalance" },
  { sig: "excessBalance(address)",                           name: "excessBalance" },
  { sig: "owner()",                                          name: "owner" },
  { sig: "paused()",                                         name: "paused" },
  { sig: "pause()",                                          name: "pause" },
  { sig: "unpause()",                                        name: "unpause" },
  { sig: "allowedTokens(address)",                           name: "allowedTokens" },
  { sig: "setAllowedToken(address,bool)",                    name: "setAllowedToken" },
  { sig: "treasury()",                                       name: "treasury" },
  { sig: "setTreasury(address)",                             name: "setTreasury" },
  { sig: "withdrawTreasury(address,uint256)",                name: "withdrawTreasury" },
  { sig: "settle(bytes32,address,uint256)",                  name: "settle (v2/v3 sig)" },
  { sig: "refund(bytes32)",                                  name: "refund" },
  { sig: "affiliateWithdrawable(address,address)",           name: "affiliateWithdrawable" },
  { sig: "totalAffiliateWithdrawable(address)",              name: "totalAffiliateWithdrawable" },
  { sig: "withdrawAffiliate(address,uint256)",               name: "withdrawAffiliate (V3: always reverts)" },
  { sig: "withdrawAffiliateFor(address,address,uint256)",    name: "withdrawAffiliateFor" },
  { sig: "rescueExcessToken(address,address,uint256)",       name: "rescueExcessToken" },
  { sig: "lockedLiability(address)",                         name: "lockedLiability" },
  { sig: "totalDeposited(address)",                          name: "totalDeposited" },
  { sig: "totalSettled(address)",                            name: "totalSettled" },
  { sig: "totalRefunded(address)",                           name: "totalRefunded" },
  { sig: "totalTreasuryWithdrawn(address)",                  name: "totalTreasuryWithdrawn" },
  { sig: "totalAffiliateWithdrawn(address)",                 name: "totalAffiliateWithdrawn" },
  { sig: "totalExcessRescued(address)",                      name: "totalExcessRescued" },
];

function selOf(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(2, 10);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function checksumOrThrow(label: string, raw: string): string {
  const t = raw.trim();
  if (!isAddress(t)) throw new Error(`${label} is not a 40-hex EVM address`);
  return ethers.getAddress(t);
}

async function main(): Promise<void> {
  const chainId = network.config.chainId;
  if (chainId === undefined) {
    throw new Error("network.config.chainId is undefined — refusing.");
  }
  // Belt + braces: fail closed if the connected chain is mainnet,
  // even if (somehow) it ended up on the allowlist.
  if (BANNED_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is a mainnet. This script is dev/test only.`,
    );
  }
  if (!ALLOWED_DEVTEST_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is not in the dev/test allowlist ` +
        `(${Array.from(ALLOWED_DEVTEST_CHAIN_IDS).join(", ")}). ` +
        `Update ALLOWED_DEVTEST_CHAIN_IDS via PR to add a new dev/test chain.`,
    );
  }

  const ownerAddr    = checksumOrThrow("GAO_OWNER_ADDRESS",    requireEnv("GAO_OWNER_ADDRESS"));
  const treasuryAddr = checksumOrThrow("GAO_TREASURY_ADDRESS", requireEnv("GAO_TREASURY_ADDRESS"));
  const usdcAddr     = checksumOrThrow("GAO_USDC_ADDRESS",     requireEnv("GAO_USDC_ADDRESS"));

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer; DEPLOYER_PRIVATE_KEY missing from env.");
  }
  const signerAddr = await signer.getAddress();

  console.log("─".repeat(72));
  console.log("Deploy GaoDomainDepositV3 (DEV/TEST)");
  console.log(`Network:        ${network.name} (chainId ${chainId})`);
  console.log(`Signer:         ${signerAddr}`);
  console.log(`Owner (ctor):   ${ownerAddr}`);
  console.log(`Treasury (ctor):${treasuryAddr}`);
  console.log(`USDC:           ${usdcAddr}`);
  console.log("─".repeat(72));

  const Factory = await ethers.getContractFactory("GaoDomainDepositV3");
  const art = await artifacts.readArtifact("GaoDomainDepositV3");
  console.log(`Bytecode length: ${(art.bytecode.length - 2) / 2} bytes`);

  const lower = art.deployedBytecode.toLowerCase();
  let missing = 0;
  for (const s of REQUIRED_SELECTORS) {
    const hex = selOf(s.sig);
    if (!lower.includes(hex)) {
      missing++;
      console.error(`  MISSING selector ${s.name.padEnd(36)} 0x${hex} (${s.sig})`);
    }
  }
  if (missing > 0) {
    throw new Error(
      `${missing} required selector(s) absent in compiled bytecode — refusing to deploy.`,
    );
  }
  console.log(`All ${REQUIRED_SELECTORS.length} required selectors present in compiled bytecode ✓`);

  // V3-specific selector check — `withdrawAffiliate` must be present
  // AND must revert. We can't probe the revert pre-deploy, but the
  // presence check confirms the V2-compat selector exists.

  if (process.env.CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3 !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast (DEV/TEST ONLY), re-run with: CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true");
    console.log("PASS (dry-run)");
    return;
  }

  console.log("CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true — deploying.");
  const escrow = await Factory.deploy(ownerAddr, treasuryAddr);
  const deployTx = escrow.deploymentTransaction();
  console.log(`  deploy tx: ${deployTx?.hash}`);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`  deployed:  ${escrowAddr}`);

  async function retryView<T>(label: string, fn: () => Promise<T>, n = 5, delay = 1500): Promise<T> {
    let last: unknown;
    for (let i = 0; i < n; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (i === n - 1) break;
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
    throw new Error(`${label} failed after ${n} retries: ${(last as Error)?.message ?? last}`);
  }

  const onChainOwner: string = await retryView("owner()", () => escrow.owner());
  if (onChainOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    console.warn(
      `Note: deployer ${signerAddr} != post-deploy owner ${onChainOwner}. ` +
        `setAllowedToken must come from the owner; skipping allowlist here.`,
    );
  } else {
    console.log("Setting USDC on the allowlist…");
    const tx1 = await escrow.setAllowedToken(usdcAddr, true);
    console.log(`  setAllowedToken tx: ${tx1.hash}`);
    await tx1.wait();
  }

  console.log("");
  console.log("Verifying on-chain state…");
  const [owner, treasury, allowed, paused, locked, tw, taw] = await Promise.all([
    retryView("owner()",                       () => escrow.owner()),
    retryView("treasury()",                    () => escrow.treasury()),
    retryView("allowedTokens(USDC)",           () => escrow.allowedTokens(usdcAddr)),
    retryView("paused()",                      () => escrow.paused()),
    retryView("lockedLiability(USDC)",         () => escrow.lockedLiability(usdcAddr)),
    retryView("treasuryWithdrawable(USDC)",    () => escrow.treasuryWithdrawable(usdcAddr)),
    retryView("totalAffiliateWithdrawable",    () => escrow.totalAffiliateWithdrawable(usdcAddr)),
  ]);
  const ok =
    owner.toLowerCase()    === ownerAddr.toLowerCase() &&
    treasury.toLowerCase() === treasuryAddr.toLowerCase() &&
    allowed === true &&
    paused === false &&
    locked === 0n && tw === 0n && taw === 0n;

  console.log(`  owner():                       ${owner}  ${owner.toLowerCase() === ownerAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  treasury():                    ${treasury}  ${treasury.toLowerCase() === treasuryAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  allowedTokens(USDC):           ${allowed}  ${allowed ? "✓" : "✗"}`);
  console.log(`  paused():                      ${paused}  ${paused === false ? "✓" : "✗"}`);
  console.log(`  lockedLiability(USDC):         ${locked}  ${locked === 0n ? "✓" : "✗"}`);
  console.log(`  treasuryWithdrawable(USDC):    ${tw}  ${tw === 0n ? "✓" : "✗"}`);
  console.log(`  totalAffiliateWithdrawable:    ${taw}  ${taw === 0n ? "✓" : "✗"}`);

  if (!ok) {
    throw new Error("Post-deploy verification failed — see ✗ marks above.");
  }

  // Persist deployment record under deployments/devtest/<network>/
  // — explicit signal that the artifact is NOT production.
  const deploymentsDir = path.join(__dirname, "..", "deployments", "devtest", network.name);
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const record = {
    contract: "GaoDomainDepositV3",
    tier: "devtest",
    network: network.name,
    chainId,
    address: escrowAddr,
    deployer: signerAddr,
    owner,
    treasury,
    allowedToken: usdcAddr,
    deployTxHash: deployTx?.hash ?? null,
    deployedAt: new Date().toISOString(),
    abi: art.abi,
    bytecodeLength: (art.bytecode.length - 2) / 2,
  };
  const recordPath = path.join(deploymentsDir, "GaoDomainDepositV3.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log("");
  console.log(`Deployment record written: ${recordPath}`);
  console.log("");
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
