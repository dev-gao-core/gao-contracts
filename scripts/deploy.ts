// Deploy GaoDomainDeposit + (optionally) allowlist USDC.
//
// Usage:
//   npm run deploy:base-sepolia     # test
//   npm run deploy:base             # mainnet (only with explicit operator approval)
//
// Required env (load from contracts/.env, NEVER commit secrets):
//   DEPLOYER_PRIVATE_KEY     EOA / hot wallet that signs the deploy.
//                            Production should switch ownership to a
//                            multisig immediately after deploy.
//   BASE_SEPOLIA_RPC_URL     RPC endpoint (private with API key).
//   BASE_RPC_URL             same, for mainnet.
// Optional:
//   GAO_OWNER_ADDRESS        Final owner (multisig). Defaults to deployer.
//   GAO_USDC_ADDRESS         If set, the deploy script calls
//                            setAllowedToken(USDC, true) in a follow-up
//                            tx so the contract is immediately depositable.
//   BASESCAN_API_KEY         For optional `verify` step.
//
// After deploy, capture the printed line:
//
//   GAO_DOMAIN_ESCROW_ADDRESS=0x...
//
// and set it on the worker:
//
//   npx wrangler secret put GAO_DOMAIN_ESCROW_ADDRESS
//   npx wrangler secret put GAO_USDC_ADDRESS    # if not already set
//   npx wrangler deploy

import { ethers, network } from "hardhat";

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer available — set DEPLOYER_PRIVATE_KEY in contracts/.env",
    );
  }

  const initialOwner =
    (process.env.GAO_OWNER_ADDRESS ?? "").trim() || (await deployer.getAddress());
  const usdcAddress = (process.env.GAO_USDC_ADDRESS ?? "").trim();

  console.log("─".repeat(70));
  console.log(`Network:        ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer:       ${await deployer.getAddress()}`);
  console.log(`Initial owner:  ${initialOwner}`);
  console.log(`Allowlist USDC: ${usdcAddress || "(skipped — set GAO_USDC_ADDRESS to enable)"}`);
  console.log("─".repeat(70));

  const factory = await ethers.getContractFactory("GaoDomainDeposit");
  const escrow = await factory.deploy(initialOwner);
  const tx = escrow.deploymentTransaction();
  if (tx) {
    console.log(`Deploy tx:      ${tx.hash}`);
  }
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();

  console.log("");
  console.log(`✅ GaoDomainDeposit deployed at:`);
  console.log(`   ${address}`);
  console.log("");

  // Optional follow-up — allowlist USDC so the contract is immediately
  // useful. Requires the deployer to currently hold ownership (it
  // does, since we just deployed). If owner is a multisig set via
  // GAO_OWNER_ADDRESS, the deployer here is no longer the owner —
  // skip and emit a clear hint.
  if (usdcAddress) {
    if ((await escrow.owner()).toLowerCase() !== (await deployer.getAddress()).toLowerCase()) {
      console.log(
        `⚠️  Skipped allowlisting ${usdcAddress}: ownership belongs to ${initialOwner}.`,
      );
      console.log(
        `   Run from the multisig:  setAllowedToken(${usdcAddress}, true)`,
      );
    } else {
      console.log(`Allowlisting USDC ${usdcAddress}…`);
      const allowTx = await escrow.setAllowedToken(usdcAddress, true);
      await allowTx.wait();
      console.log(`   tx: ${allowTx.hash}`);
    }
  }

  console.log("");
  console.log("─".repeat(70));
  console.log("Copy this into your worker secrets:");
  console.log("");
  console.log(`  GAO_DOMAIN_ESCROW_ADDRESS=${address}`);
  if (usdcAddress) console.log(`  GAO_USDC_ADDRESS=${usdcAddress}`);
  console.log("");
  console.log("Then:");
  console.log("  npx wrangler secret put GAO_DOMAIN_ESCROW_ADDRESS");
  if (usdcAddress) console.log("  npx wrangler secret put GAO_USDC_ADDRESS");
  console.log("  npx wrangler deploy");
  console.log("─".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
