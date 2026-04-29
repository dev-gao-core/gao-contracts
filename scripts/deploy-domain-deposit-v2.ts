// Deploy GaoDomainDepositV2 to Base Sepolia (or another configured network).
//
// What this script does:
//   1. Pre-flight env: refuses to run unless DEPLOYER_PRIVATE_KEY,
//      BASE_SEPOLIA_RPC_URL, GAO_OWNER_ADDRESS, GAO_TREASURY_ADDRESS,
//      and GAO_USDC_ADDRESS are set.
//   2. Confirms the chain is Base Sepolia (or matches DEPLOY_EXPECTED_CHAIN_ID
//      override) before sending any tx.
//   3. Sanity-checks ownership semantics: the deployer can be different
//      from `GAO_OWNER_ADDRESS` (e.g. CI deployer), but we explicitly
//      pass the desired owner into the constructor so post-deploy
//      `owner()` matches the operator's expectation without a separate
//      transferOwnership tx.
//   4. Deploys, waits for the receipt, prints the deployed address.
//   5. Calls `setAllowedToken(USDC, true)`.
//   6. Verifies the deploy via on-chain reads:
//        - owner() == GAO_OWNER_ADDRESS
//        - treasury() == GAO_TREASURY_ADDRESS
//        - allowedTokens(USDC) == true
//        - paused() == false
//        - lockedLiability(USDC) == 0
//        - treasuryWithdrawable(USDC) == 0
//        - totalAffiliateWithdrawable(USDC) == 0
//        - bytecode contains every required selector
//   7. Writes a deployment record to deployments/<network>/GaoDomainDepositV2.json
//      so the worker / FE can pick it up.
//
// What this script does NOT do:
//   - Never broadcasts unless CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V2=true. Default
//     is dry-run: prints what it WOULD do without sending tx.
//   - Never moves funds. Never transfers ownership of an existing contract.
//
// Usage:
//   # dry-run
//   npx hardhat run scripts/deploy-domain-deposit-v2.ts --network baseSepolia
//
//   # real deploy
//   CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V2=true \
//     npx hardhat run scripts/deploy-domain-deposit-v2.ts --network baseSepolia
//
// Required env:
//   DEPLOYER_PRIVATE_KEY    — EOA used to send the deploy tx.
//   BASE_SEPOLIA_RPC_URL    — RPC for the target network.
//   GAO_OWNER_ADDRESS       — desired owner of the deployed contract.
//   GAO_TREASURY_ADDRESS    — desired treasury sink.
//   GAO_USDC_ADDRESS        — token allowlisted post-deploy.
//
// Optional env:
//   DEPLOY_EXPECTED_CHAIN_ID — defaults to 84532 (Base Sepolia).

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { keccak256, toUtf8Bytes } from "ethers";

const DEFAULT_CHAIN_ID = 84532;

// Selectors the deployed bytecode MUST contain. Same list verified
// post-deploy by `preflight-domain-deposit-v2.ts`. Kept in lock-step.
//
// Sources of truth:
//   - GaoDomainDepositV2.sol public surface
//   - Worker spec (every required-functions / required-views entry)
const REQUIRED_SELECTORS: { sig: string; name: string }[] = [
  // Core deposit + reads (ABI-stable with v1 for the wallet flow)
  { sig: "deposit(address,bytes32,bytes32,address,uint256)", name: "deposit" },
  { sig: "getDeposit(bytes32)",                              name: "getDeposit" },
  { sig: "isPending(bytes32)",                               name: "isPending" },
  { sig: "accountedBalance(address)",                        name: "accountedBalance" },
  { sig: "excessBalance(address)",                           name: "excessBalance" },

  // Owner / pause
  { sig: "owner()",                                          name: "owner" },
  { sig: "paused()",                                         name: "paused" },
  { sig: "pause()",                                          name: "pause" },
  { sig: "unpause()",                                        name: "unpause" },

  // Token allowlist
  { sig: "allowedTokens(address)",                           name: "allowedTokens" },
  { sig: "setAllowedToken(address,bool)",                    name: "setAllowedToken" },

  // Treasury
  { sig: "treasury()",                                       name: "treasury" },
  { sig: "setTreasury(address)",                             name: "setTreasury" },
  { sig: "treasuryWithdrawable(address)",                    name: "treasuryWithdrawable" },
  { sig: "withdrawTreasury(address,uint256)",                name: "withdrawTreasury" },

  // Settle (v2 split signature) + refund
  { sig: "settle(bytes32,address,uint256)",                  name: "settle (v2 sig)" },
  { sig: "refund(bytes32)",                                  name: "refund" },

  // Affiliate
  { sig: "affiliateWithdrawable(address,address)",           name: "affiliateWithdrawable" },
  { sig: "totalAffiliateWithdrawable(address)",              name: "totalAffiliateWithdrawable" },
  { sig: "withdrawAffiliate(address,uint256)",               name: "withdrawAffiliate" },
  { sig: "withdrawAffiliateFor(address,address,uint256)",    name: "withdrawAffiliateFor" },

  // Rescue
  { sig: "rescueExcessToken(address,address,uint256)",       name: "rescueExcessToken" },
  { sig: "lockedLiability(address)",                         name: "lockedLiability" },

  // Stats counters (per-token append-only)
  { sig: "totalDeposited(address)",                          name: "totalDeposited" },
  { sig: "totalSettled(address)",                            name: "totalSettled" },
  { sig: "totalRefunded(address)",                           name: "totalRefunded" },
  { sig: "totalTreasuryWithdrawn(address)",                  name: "totalTreasuryWithdrawn" },
  { sig: "totalAffiliateWithdrawn(address)",                 name: "totalAffiliateWithdrawn" },
  { sig: "totalExcessRescued(address)",                      name: "totalExcessRescued" },
];

function selOf(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(2, 10); // 4-byte hex, no 0x
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
  if (!isAddress(t)) throw new Error(`${label} is not a 40-hex EVM address: ${raw}`);
  return ethers.getAddress(t);
}

async function main(): Promise<void> {
  const expectedChainId = Number.parseInt(
    process.env.DEPLOY_EXPECTED_CHAIN_ID ?? String(DEFAULT_CHAIN_ID),
    10,
  );
  if (network.config.chainId !== expectedChainId) {
    throw new Error(
      `Wrong network. Expected chainId ${expectedChainId}, got ${network.config.chainId}. ` +
        `Use --network baseSepolia (or override DEPLOY_EXPECTED_CHAIN_ID).`,
    );
  }

  // Required env.
  requireEnv("DEPLOYER_PRIVATE_KEY"); // implicit via hardhat.config readPrivateKey()
  const ownerAddr    = checksumOrThrow("GAO_OWNER_ADDRESS",    requireEnv("GAO_OWNER_ADDRESS"));
  const treasuryAddr = checksumOrThrow("GAO_TREASURY_ADDRESS", requireEnv("GAO_TREASURY_ADDRESS"));
  const usdcAddr     = checksumOrThrow("GAO_USDC_ADDRESS",     requireEnv("GAO_USDC_ADDRESS"));

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer; DEPLOYER_PRIVATE_KEY missing.");
  const signerAddr = await signer.getAddress();

  console.log("─".repeat(72));
  console.log("Deploy GaoDomainDepositV2");
  console.log(`Network:     ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Signer:      ${signerAddr}`);
  console.log(`Owner (ctor): ${ownerAddr}`);
  console.log(`Treasury (ctor): ${treasuryAddr}`);
  console.log(`USDC:        ${usdcAddr}`);
  console.log("─".repeat(72));

  // Compile is implicit on `npx hardhat run`; we just sanity-check the
  // artifact exists.
  const Factory = await ethers.getContractFactory("GaoDomainDepositV2");
  const art = await artifacts.readArtifact("GaoDomainDepositV2");
  console.log(`Bytecode length: ${(art.bytecode.length - 2) / 2} bytes`);

  // Local selector pre-check on the un-deployed bytecode. Catches a
  // compiler / source mismatch before we burn gas.
  const lower = art.deployedBytecode.toLowerCase();
  let missing = 0;
  for (const s of REQUIRED_SELECTORS) {
    const hex = selOf(s.sig);
    const present = lower.includes(hex);
    if (!present) {
      missing += 1;
      console.error(`  MISSING selector ${s.name.padEnd(28)} 0x${hex} (${s.sig})`);
    }
  }
  if (missing > 0) {
    throw new Error(
      `${missing} required selector(s) not in compiled bytecode — refusing to deploy.`,
    );
  }
  console.log(`All ${REQUIRED_SELECTORS.length} required selectors present in compiled bytecode ✓`);

  // Dry-run gate.
  if (process.env.CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V2 !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast, re-run with: CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V2=true");
    console.log("PASS (dry-run)");
    return;
  }

  // Real deploy.
  console.log("CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V2=true — deploying.");
  const escrow = await Factory.deploy(ownerAddr, treasuryAddr);
  const deployTx = escrow.deploymentTransaction();
  console.log(`  deploy tx: ${deployTx?.hash}`);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`  deployed:  ${escrowAddr}`);

  // The public Base Sepolia RPC load-balances eth_call across nodes
  // that can lag the write node by a block. waitForDeployment() resolves
  // as soon as ONE node sees the contract; the next eth_call may hit a
  // different node still on `latest - 1`, returning "0x" (no bytecode)
  // which ethers surfaces as BAD_DATA on a subsequent decode. We retry
  // every post-deploy view to absorb that lag.
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

  // Allowlist USDC. The deploy signer must equal owner() — Ownable
  // assigns ownership inside the constructor, so this only works when
  // signer == ownerAddr. We surface a clear error if not.
  const onChainOwner: string = await retryView("owner()", () => escrow.owner());
  if (onChainOwner.toLowerCase() !== signerAddr.toLowerCase()) {
    console.warn(
      `Note: deployer ${signerAddr} != post-deploy owner ${onChainOwner}. ` +
        `setAllowedToken/setTreasury/etc. must come from the owner; skipping allowlist here.`,
    );
  } else {
    console.log("Setting USDC on the allowlist…");
    const tx1 = await escrow.setAllowedToken(usdcAddr, true);
    console.log(`  setAllowedToken tx: ${tx1.hash}`);
    await tx1.wait();
  }

  // Post-deploy verification (retried for the same RPC-lag reason).
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

  console.log(`  owner():                       ${owner}                ${owner.toLowerCase() === ownerAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  treasury():                    ${treasury}             ${treasury.toLowerCase() === treasuryAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  allowedTokens(USDC):           ${allowed}              ${allowed ? "✓" : "✗"}`);
  console.log(`  paused():                      ${paused}               ${paused === false ? "✓" : "✗"}`);
  console.log(`  lockedLiability(USDC):         ${locked}               ${locked === 0n ? "✓" : "✗"}`);
  console.log(`  treasuryWithdrawable(USDC):    ${tw}                   ${tw === 0n ? "✓" : "✗"}`);
  console.log(`  totalAffiliateWithdrawable:    ${taw}                  ${taw === 0n ? "✓" : "✗"}`);

  if (!ok) {
    throw new Error("Post-deploy verification failed — see ✗ marks above.");
  }

  // Persist deployment record. Network name comes from hardhat.
  const deploymentsDir = path.join(__dirname, "..", "deployments", network.name);
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const record = {
    contract: "GaoDomainDepositV2",
    network: network.name,
    chainId: network.config.chainId,
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
  const recordPath = path.join(deploymentsDir, "GaoDomainDepositV2.json");
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
