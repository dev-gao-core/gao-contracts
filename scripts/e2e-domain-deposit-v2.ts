// End-to-end exercise of a deployed GaoDomainDepositV2.
//
// Sequence (when CONFIRM_E2E_DOMAIN_DEPOSIT_V2=true):
//   1. deposit a small amount under invoiceA (the script's USDC funds itself
//      via the deployer EOA — caller must have ≥ amountA + amountB USDC).
//   2. settle invoiceA with affiliate split (e.g. amountA, 10% to AFFILIATE_TEST).
//   3. withdrawTreasury(USDC, treasuryAmount).
//   4. withdrawAffiliate(USDC, affiliateAmount) — signed by the affiliate
//      key if AFFILIATE_TEST_PRIVATE_KEY is set; otherwise the owner uses
//      withdrawAffiliateFor on behalf of AFFILIATE_TEST.
//   5. deposit a separate amount under invoiceB.
//   6. refund(invoiceB) — funds go back to deployer (the deposit's payer).
//   7. transfer a tiny stray amount into the contract; rescueExcessToken
//      to recover it.
//   8. Print final state + invariant check.
//
// The default mode is dry-run: prints what each step WOULD do (with the
// computed splits) and the current on-chain state, but sends no tx.
// Broadcast requires CONFIRM_E2E_DOMAIN_DEPOSIT_V2=true.
//
// Usage:
//   # dry-run
//   ESCROW_ADDRESS=0x...                                    \
//     AFFILIATE_TEST=0x...                                  \
//     npx hardhat run scripts/e2e-domain-deposit-v2.ts --network baseSepolia
//
//   # broadcast
//   CONFIRM_E2E_DOMAIN_DEPOSIT_V2=true                      \
//     ESCROW_ADDRESS=0x...                                  \
//     AFFILIATE_TEST=0x...                                  \
//     AFFILIATE_TEST_PRIVATE_KEY=0x...                      \
//     E2E_AMOUNT_A=2000000  E2E_AMOUNT_B=1000000  E2E_STRAY=50000 \
//     npx hardhat run scripts/e2e-domain-deposit-v2.ts --network baseSepolia
//
// Required env:
//   ESCROW_ADDRESS              — deployed GaoDomainDepositV2 address.
//   GAO_USDC_ADDRESS            — token to deposit.
//   AFFILIATE_TEST              — affiliate wallet to credit & withdraw.
// Optional:
//   AFFILIATE_TEST_PRIVATE_KEY  — if set, exercises self-withdraw path.
//   E2E_AMOUNT_A / E2E_AMOUNT_B — base units (default 2_000_000 / 1_000_000).
//   E2E_AFFILIATE_BPS           — affiliate share in bps (default 1000 = 10%).
//   E2E_STRAY                   — stray base units (default 50_000).
//   CONFIRM_E2E_DOMAIN_DEPOSIT_V2 — "true" to broadcast.
//
// Read-only by default. Refuses to run on the deprecated v1 escrow.

import { ethers, network } from "hardhat";

const DEPRECATED_V1_ESCROW = "0xcfc746df306fa0c4512ca98f83ac7b6b143c2a13";

function reqEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function intEnv(name: string, dflt: bigint): bigint {
  const v = process.env[name]?.trim();
  if (!v) return dflt;
  return BigInt(v);
}

function fmtUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

async function main(): Promise<void> {
  const escrowAddr = ethers.getAddress(reqEnv("ESCROW_ADDRESS"));
  if (escrowAddr.toLowerCase() === DEPRECATED_V1_ESCROW) {
    throw new Error(
      `ESCROW_ADDRESS points at the deprecated v1 contract ${DEPRECATED_V1_ESCROW}. ` +
        `This script is for v2 only.`,
    );
  }
  const usdcAddr = ethers.getAddress(reqEnv("GAO_USDC_ADDRESS"));
  const affiliate = ethers.getAddress(reqEnv("AFFILIATE_TEST"));

  const amountA = intEnv("E2E_AMOUNT_A", 2_000_000n);   // 2 USDC
  const amountB = intEnv("E2E_AMOUNT_B", 1_000_000n);   // 1 USDC
  const stray   = intEnv("E2E_STRAY",      50_000n);    // 0.05 USDC
  const affBps  = intEnv("E2E_AFFILIATE_BPS", 1000n);   // 10 %

  if (affBps > 10000n) throw new Error("E2E_AFFILIATE_BPS must be ≤ 10000");
  const affAmount = (amountA * affBps) / 10000n;
  const treasuryAmount = amountA - affAmount;

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer; DEPLOYER_PRIVATE_KEY missing.");
  const signerAddr = await signer.getAddress();

  const escrow = await ethers.getContractAt("GaoDomainDepositV2", escrowAddr);
  const usdc = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) external returns (bool)",
      "function transfer(address,uint256) external returns (bool)",
    ],
    usdcAddr,
  );

  console.log("─".repeat(72));
  console.log("E2E exercise: GaoDomainDepositV2");
  console.log(`Network:        ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Escrow:         ${escrowAddr}`);
  console.log(`USDC:           ${usdcAddr}`);
  console.log(`Signer (depo):  ${signerAddr}`);
  console.log(`Affiliate:      ${affiliate}`);
  console.log(`amountA:        ${fmtUsdc(amountA)}  (split → treasury ${fmtUsdc(treasuryAmount)} + affiliate ${fmtUsdc(affAmount)} @ ${affBps} bps)`);
  console.log(`amountB:        ${fmtUsdc(amountB)}  (will be refunded)`);
  console.log(`stray:          ${fmtUsdc(stray)}  (will be rescued)`);
  console.log("─".repeat(72));

  const [owner, treasury, paused, allowed]: [string, string, boolean, boolean] = await Promise.all([
    escrow.owner(),
    escrow.treasury(),
    escrow.paused(),
    escrow.allowedTokens(usdcAddr),
  ]);
  console.log(`owner():        ${owner}`);
  console.log(`treasury():     ${treasury}`);
  console.log(`paused():       ${paused}`);
  console.log(`allowedTokens(USDC): ${allowed}`);
  if (!allowed) throw new Error("USDC is not allowlisted on the deployed escrow. Run setAllowedToken first.");
  if (paused) throw new Error("Escrow is paused. Cannot run e2e until unpause.");

  // Pre-balance check.
  const myBal: bigint = await usdc.balanceOf(signerAddr);
  console.log(`signer USDC balance: ${fmtUsdc(myBal)}`);
  if (myBal < amountA + amountB + stray) {
    throw new Error(
      `Signer needs at least ${fmtUsdc(amountA + amountB + stray)} USDC; has ${fmtUsdc(myBal)}.`,
    );
  }

  if (process.env.CONFIRM_E2E_DOMAIN_DEPOSIT_V2 !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast, re-run with: CONFIRM_E2E_DOMAIN_DEPOSIT_V2=true");
    console.log("PASS (dry-run)");
    return;
  }

  // Seeds — keccak256(utf8(string)) gives bytes32 invoiceId / domainHash.
  const seed = `e2e_${Date.now()}`;
  const invoiceA = ethers.keccak256(ethers.toUtf8Bytes(`${seed}_A`));
  const invoiceB = ethers.keccak256(ethers.toUtf8Bytes(`${seed}_B`));
  const domainA = ethers.keccak256(ethers.toUtf8Bytes(`${seed}-a.gao`));
  const domainB = ethers.keccak256(ethers.toUtf8Bytes(`${seed}-b.gao`));

  // 1. depositA
  console.log("");
  console.log("[1] deposit A");
  await (await usdc.approve(escrowAddr, amountA)).wait();
  const tx1 = await escrow.deposit(signerAddr /* buyer */, invoiceA, domainA, usdcAddr, amountA);
  console.log(`  tx: ${tx1.hash}`);
  await tx1.wait();

  // 2. settle A with affiliate split
  console.log("");
  console.log("[2] settle A (affiliate split)");
  const tx2 = await escrow.settle(invoiceA, affiliate, affAmount);
  console.log(`  tx: ${tx2.hash}`);
  await tx2.wait();

  // 3. withdrawTreasury
  console.log("");
  console.log("[3] withdrawTreasury");
  const tx3 = await escrow.withdrawTreasury(usdcAddr, treasuryAmount);
  console.log(`  tx: ${tx3.hash}`);
  await tx3.wait();

  // 4. withdrawAffiliate (self if key provided, else owner-on-behalf)
  console.log("");
  console.log("[4] withdrawAffiliate");
  const affKey = process.env.AFFILIATE_TEST_PRIVATE_KEY?.trim();
  if (affKey) {
    const affWallet = new ethers.Wallet(
      affKey.startsWith("0x") ? affKey : `0x${affKey}`,
      ethers.provider,
    );
    if ((await affWallet.getAddress()).toLowerCase() !== affiliate.toLowerCase()) {
      throw new Error("AFFILIATE_TEST_PRIVATE_KEY does not match AFFILIATE_TEST address.");
    }
    const tx4 = await escrow.connect(affWallet).withdrawAffiliate(usdcAddr, affAmount);
    console.log(`  tx (self): ${tx4.hash}`);
    await tx4.wait();
  } else {
    const tx4 = await escrow.withdrawAffiliateFor(affiliate, usdcAddr, affAmount);
    console.log(`  tx (owner-on-behalf): ${tx4.hash}`);
    await tx4.wait();
  }

  // 5. depositB
  console.log("");
  console.log("[5] deposit B");
  await (await usdc.approve(escrowAddr, amountB)).wait();
  const tx5 = await escrow.deposit(signerAddr, invoiceB, domainB, usdcAddr, amountB);
  console.log(`  tx: ${tx5.hash}`);
  await tx5.wait();

  // 6. refund B
  console.log("");
  console.log("[6] refund B");
  const tx6 = await escrow.refund(invoiceB);
  console.log(`  tx: ${tx6.hash}`);
  await tx6.wait();

  // 7. stray + rescue
  console.log("");
  console.log("[7] stray transfer + rescueExcessToken");
  const txStray = await usdc.transfer(escrowAddr, stray);
  console.log(`  stray tx: ${txStray.hash}`);
  await txStray.wait();
  const tx7 = await escrow.rescueExcessToken(usdcAddr, signerAddr, stray);
  console.log(`  rescue tx: ${tx7.hash}`);
  await tx7.wait();

  // 8. final state + invariant
  console.log("");
  console.log("[8] final state");
  const [locked, tw, taw, accounted, excess]: [bigint, bigint, bigint, bigint, bigint] =
    await Promise.all([
      escrow.lockedLiability(usdcAddr),
      escrow.treasuryWithdrawable(usdcAddr),
      escrow.totalAffiliateWithdrawable(usdcAddr),
      escrow.accountedBalance(usdcAddr),
      escrow.excessBalance(usdcAddr),
    ]);
  const finalBal: bigint = await usdc.balanceOf(escrowAddr);
  console.log(`  lockedLiability:           ${fmtUsdc(locked)}`);
  console.log(`  treasuryWithdrawable:      ${fmtUsdc(tw)}`);
  console.log(`  totalAffiliateWithdrawable:${fmtUsdc(taw)}`);
  console.log(`  accountedBalance:          ${fmtUsdc(accounted)}`);
  console.log(`  excessBalance:             ${fmtUsdc(excess)}`);
  console.log(`  ERC20.balanceOf(escrow):   ${fmtUsdc(finalBal)}`);
  if (finalBal < accounted) throw new Error("Invariant broken: balance < accounted");
  console.log("");
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
