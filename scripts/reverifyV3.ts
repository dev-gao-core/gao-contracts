// Re-verify a freshly-deployed V3 against the operator-supplied
// expected state. Runs read-only against the live RPC; never broadcasts.
//
// Usage:
//   V3_ADDRESS=0x... \
//   V3_TREASURY_ADDRESS=0x... \
//   V3_ALLOWED_TOKEN_ADDRESSES=0x... \
//     npx hardhat run scripts/reverifyV3.ts --network baseSepolia

import { ethers, network } from "hardhat";

async function main(): Promise<void> {
  const v3 = process.env.V3_ADDRESS?.trim();
  const treasury = process.env.V3_TREASURY_ADDRESS?.trim();
  const usdc = (process.env.V3_ALLOWED_TOKEN_ADDRESSES?.split(",")[0]?.trim() ?? "");
  if (!v3 || !treasury || !usdc) {
    throw new Error("V3_ADDRESS / V3_TREASURY_ADDRESS / V3_ALLOWED_TOKEN_ADDRESSES required");
  }
  console.log(`Network: ${network.name} (chainId ${network.config.chainId})`);
  console.log(`V3:       ${v3}`);
  console.log(`treasury: ${treasury}`);
  console.log(`USDC:     ${usdc}`);

  const escrow = await ethers.getContractAt("GaoDomainDepositV3", v3);

  const owner    = await escrow.owner();
  const treas    = await escrow.treasury();
  const allowed  = await escrow.allowedTokens(usdc);
  const paused   = await escrow.paused();
  const locked   = await escrow.lockedLiability(usdc);
  const tw       = await escrow.treasuryWithdrawable(usdc);
  const taw      = await escrow.totalAffiliateWithdrawable(usdc);

  console.log("");
  console.log("Re-verify reads:");
  console.log(`  owner():                       ${owner}`);
  console.log(`  treasury():                    ${treas}     (expected ${treasury}) ${treas.toLowerCase() === treasury.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  allowedTokens(USDC):           ${allowed}  ${allowed === true ? "✓" : "✗"}`);
  console.log(`  paused():                      ${paused}  ${paused === false ? "✓" : "✗"}`);
  console.log(`  lockedLiability(USDC):         ${locked}  ${locked === 0n ? "✓" : "✗"}`);
  console.log(`  treasuryWithdrawable(USDC):    ${tw}  ${tw === 0n ? "✓" : "✗"}`);
  console.log(`  totalAffiliateWithdrawable:    ${taw}  ${taw === 0n ? "✓" : "✗"}`);

  const ok =
    treas.toLowerCase() === treasury.toLowerCase() &&
    allowed === true &&
    paused === false &&
    locked === 0n && tw === 0n && taw === 0n;
  if (!ok) {
    console.error("");
    console.error("FAIL — see ✗ rows above.");
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
