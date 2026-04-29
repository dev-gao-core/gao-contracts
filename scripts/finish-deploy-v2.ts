// One-shot recovery for a deploy that succeeded on-chain but whose
// follow-up steps (setAllowedToken + deployment record) didn't run
// because the script's post-tx read raced the public RPC's
// load-balanced read node.
//
// Idempotent:
//   - If allowedTokens(USDC) is already true, the setAllowedToken tx is skipped.
//   - The deployment record is rewritten unconditionally (timestamp updates).
//
// Required env (same as deploy-domain-deposit-v2.ts plus ESCROW_ADDRESS):
//   DEPLOYER_PRIVATE_KEY  — must equal owner() of the deployed contract
//   BASE_SEPOLIA_RPC_URL
//   GAO_OWNER_ADDRESS
//   GAO_TREASURY_ADDRESS
//   GAO_USDC_ADDRESS
//   ESCROW_ADDRESS         — deployed v2 address
//   DEPLOY_TX_HASH         — optional; recorded into the JSON if provided

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPRECATED_V1_ESCROW = "0xcfc746df306fa0c4512ca98f83ac7b6b143c2a13";

function reqEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function retry<T>(label: string, fn: () => Promise<T>, n = 5, delay = 1500): Promise<T> {
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

async function main(): Promise<void> {
  if (network.config.chainId !== 84532) {
    throw new Error(`Wrong network: expected Base Sepolia (84532), got ${network.config.chainId}`);
  }
  const escrowAddr = ethers.getAddress(reqEnv("ESCROW_ADDRESS"));
  if (escrowAddr.toLowerCase() === DEPRECATED_V1_ESCROW) {
    throw new Error("deprecated v1 escrow address; refusing to operate against it.");
  }
  const usdcAddr = ethers.getAddress(reqEnv("GAO_USDC_ADDRESS"));
  const expectedOwner = ethers.getAddress(reqEnv("GAO_OWNER_ADDRESS"));
  const expectedTreasury = ethers.getAddress(reqEnv("GAO_TREASURY_ADDRESS"));

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer; DEPLOYER_PRIVATE_KEY missing");
  const signerAddr = await signer.getAddress();

  const escrow = await ethers.getContractAt("GaoDomainDepositV2", escrowAddr);

  console.log("─".repeat(72));
  console.log("Finish v2 deploy (post-deploy recovery)");
  console.log(`Network:   ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Escrow:    ${escrowAddr}`);
  console.log(`USDC:      ${usdcAddr}`);
  console.log(`Signer:    ${signerAddr}`);
  console.log("─".repeat(72));

  // Read state with retries to absorb any RPC-node lag.
  const owner: string    = await retry("owner",    () => escrow.owner());
  const treasury: string = await retry("treasury", () => escrow.treasury());
  const paused: boolean  = await retry("paused",   () => escrow.paused());
  const allowed: boolean = await retry("allowed",  () => escrow.allowedTokens(usdcAddr));
  console.log(`owner():               ${owner}`);
  console.log(`treasury():            ${treasury}`);
  console.log(`paused():              ${paused}`);
  console.log(`allowedTokens(USDC):   ${allowed}`);

  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`owner mismatch: on-chain ${owner}, expected ${expectedOwner}`);
  }
  if (treasury.toLowerCase() !== expectedTreasury.toLowerCase()) {
    throw new Error(`treasury mismatch: on-chain ${treasury}, expected ${expectedTreasury}`);
  }
  if (signerAddr.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signerAddr} != owner ${owner}; cannot setAllowedToken.`);
  }

  // Allowlist USDC if needed.
  let allowlistTx: string | null = null;
  if (!allowed) {
    console.log("");
    console.log("Sending setAllowedToken(USDC, true)…");
    const tx = await escrow.setAllowedToken(usdcAddr, true);
    console.log(`  tx: ${tx.hash}`);
    const rec = await tx.wait();
    if (!rec || rec.status !== 1) throw new Error("setAllowedToken reverted");
    allowlistTx = tx.hash;

    // Re-read with retries to make sure the change propagated.
    const allowedAfter: boolean = await retry("allowedAfter", async () => {
      const v = await escrow.allowedTokens(usdcAddr);
      if (!v) throw new Error("not yet propagated");
      return v;
    });
    console.log(`  allowedTokens(USDC) after: ${allowedAfter}`);
  } else {
    console.log("USDC already allowlisted — skipping setAllowedToken.");
  }

  // Final state snapshot.
  const [locked, tw, taw] = await Promise.all([
    retry("locked", () => escrow.lockedLiability(usdcAddr)),
    retry("tw",     () => escrow.treasuryWithdrawable(usdcAddr)),
    retry("taw",    () => escrow.totalAffiliateWithdrawable(usdcAddr)),
  ]);
  console.log("");
  console.log("Final state:");
  console.log(`  lockedLiability(USDC):       ${locked}`);
  console.log(`  treasuryWithdrawable(USDC):  ${tw}`);
  console.log(`  totalAffiliateWithdrawable:  ${taw}`);

  // Write deployment record.
  const art = await artifacts.readArtifact("GaoDomainDepositV2");
  const deploymentsDir = path.join(__dirname, "..", "deployments", network.name);
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const recordPath = path.join(deploymentsDir, "GaoDomainDepositV2.json");
  const record = {
    contract: "GaoDomainDepositV2",
    network: network.name,
    chainId: network.config.chainId,
    address: escrowAddr,
    deployer: signerAddr,
    owner,
    treasury,
    allowedToken: usdcAddr,
    deployTxHash: process.env.DEPLOY_TX_HASH ?? null,
    allowlistTxHash: allowlistTx,
    deployedAt: new Date().toISOString(),
    abi: art.abi,
    bytecodeLength: (art.bytecode.length - 2) / 2,
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log("");
  console.log(`Deployment record written: ${recordPath}`);
  console.log("PASS");
}

main().catch((e) => {
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
