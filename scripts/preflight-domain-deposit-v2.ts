// Preflight verifier for a deployed GaoDomainDepositV2.
//
// Runs against an existing on-chain instance — does NOT deploy. Use this
// after `deploy-domain-deposit-v2.ts` (or any later state change) to
// confirm the contract still satisfies every invariant the worker will
// rely on. Refuses to PASS unless every required selector / view /
// initial value is correct.
//
// Usage:
//   ESCROW_ADDRESS=0x...  \
//     npx hardhat run scripts/preflight-domain-deposit-v2.ts --network baseSepolia
//
// Reads `deployments/<network>/GaoDomainDepositV2.json` if ESCROW_ADDRESS
// is unset. Required env beyond that:
//   GAO_USDC_ADDRESS — token expected on the allowlist.
//   (optional) GAO_OWNER_ADDRESS / GAO_TREASURY_ADDRESS — if set, the
//     script asserts on-chain owner() / treasury() match.
//
// What it checks:
//   - bytecode contains every required selector (REQUIRED_SELECTORS list)
//   - owner() / treasury() match expected (if env-provided)
//   - paused() == false
//   - allowedTokens(USDC) == true
//   - lockedLiability(USDC) / treasuryWithdrawable(USDC) /
//     totalAffiliateWithdrawable(USDC) read without revert
//   - accountedBalance(USDC) == sum of three buckets
//   - excessBalance(USDC) returns successfully (no under-collat revert)
//   - balance invariant balanceOf(this) >= accountedBalance
//   - getDeposit(0x00..0) returns the v2 11-tuple shape (status NONE)
//   - isPending(0x00..0) == false
//
// Read-only — never sends a tx.

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { keccak256, toUtf8Bytes } from "ethers";

const REQUIRED_SELECTORS: { sig: string; name: string }[] = [
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
  { sig: "treasuryWithdrawable(address)",                    name: "treasuryWithdrawable" },
  { sig: "withdrawTreasury(address,uint256)",                name: "withdrawTreasury" },
  { sig: "settle(bytes32,address,uint256)",                  name: "settle (v2 sig)" },
  { sig: "refund(bytes32)",                                  name: "refund" },
  { sig: "affiliateWithdrawable(address,address)",           name: "affiliateWithdrawable" },
  { sig: "totalAffiliateWithdrawable(address)",              name: "totalAffiliateWithdrawable" },
  { sig: "withdrawAffiliate(address,uint256)",               name: "withdrawAffiliate" },
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

// Deprecated v1 escrow on Base Sepolia (commit-42b6c2e revision). The
// 9 deposits that were stuck there have been refunded and the contract
// is now empty + DEPRECATED. Calling settle() on it permanently locks
// funds; this preflight script must NEVER green-light it as a v2
// target, no matter how the caller sources the address (env or
// deployments/<network>/GaoDomainDepositV2.json).
const DEPRECATED_V1_ESCROW = "0xcfc746df306fa0c4512ca98f83ac7b6b143c2a13";

function selOf(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(2, 10);
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function assertNotDeprecatedV1(addr: string, source: "env" | "record"): void {
  if (addr.toLowerCase() === DEPRECATED_V1_ESCROW) {
    throw new Error(
      `deprecated v1 escrow address; never use for v2 preflight or settlement. ` +
        `(source: ${source}, value: ${addr})`,
    );
  }
}

function loadDeployedAddress(): string {
  const env = process.env.ESCROW_ADDRESS?.trim();
  if (env) {
    if (!isAddress(env)) throw new Error(`ESCROW_ADDRESS not a valid 40-hex address: ${env}`);
    assertNotDeprecatedV1(env, "env");
    return ethers.getAddress(env);
  }
  const recordPath = path.join(
    __dirname,
    "..",
    "deployments",
    network.name,
    "GaoDomainDepositV2.json",
  );
  if (!fs.existsSync(recordPath)) {
    throw new Error(
      `No ESCROW_ADDRESS env and no deployment record at ${recordPath}. ` +
        `Set ESCROW_ADDRESS or run deploy-domain-deposit-v2.ts first.`,
    );
  }
  const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (!rec.address || !isAddress(rec.address)) {
    throw new Error(`Deployment record at ${recordPath} has no valid address.`);
  }
  assertNotDeprecatedV1(rec.address, "record");
  return ethers.getAddress(rec.address);
}

async function main(): Promise<void> {
  const escrowAddr = loadDeployedAddress();
  const usdcAddr = (() => {
    const v = process.env.GAO_USDC_ADDRESS?.trim();
    if (!v) throw new Error("Missing GAO_USDC_ADDRESS");
    if (!isAddress(v)) throw new Error("GAO_USDC_ADDRESS not a valid address");
    return ethers.getAddress(v);
  })();
  const expectedOwner = process.env.GAO_OWNER_ADDRESS?.trim()
    ? ethers.getAddress(process.env.GAO_OWNER_ADDRESS!.trim())
    : null;
  const expectedTreasury = process.env.GAO_TREASURY_ADDRESS?.trim()
    ? ethers.getAddress(process.env.GAO_TREASURY_ADDRESS!.trim())
    : null;

  console.log("─".repeat(72));
  console.log("Preflight: GaoDomainDepositV2");
  console.log(`Network:    ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Escrow:     ${escrowAddr}`);
  console.log(`USDC:       ${usdcAddr}`);
  console.log(`Expected owner:    ${expectedOwner ?? "(unset, won't assert)"}`);
  console.log(`Expected treasury: ${expectedTreasury ?? "(unset, won't assert)"}`);
  console.log("─".repeat(72));

  const provider = ethers.provider;
  const code = await provider.getCode(escrowAddr);
  if (code === "0x") {
    throw new Error(`No bytecode at ${escrowAddr}.`);
  }
  console.log(`bytecode length: ${(code.length - 2) / 2} bytes`);

  // Selector presence.
  console.log("");
  console.log("Selector check:");
  const lower = code.toLowerCase();
  let missing = 0;
  for (const s of REQUIRED_SELECTORS) {
    const hex = selOf(s.sig);
    const present = lower.includes(hex);
    console.log(`  ${present ? "✓" : "✗"} ${s.name.padEnd(30)} 0x${hex} (${s.sig})`);
    if (!present) missing += 1;
  }
  if (missing > 0) {
    throw new Error(`${missing} required selector(s) missing.`);
  }

  // High-level state via the typed contract.
  const escrow = await ethers.getContractAt("GaoDomainDepositV2", escrowAddr);

  console.log("");
  console.log("State checks:");
  const owner: string = await escrow.owner();
  const treasury: string = await escrow.treasury();
  const paused: boolean = await escrow.paused();
  const allowed: boolean = await escrow.allowedTokens(usdcAddr);
  const locked: bigint = await escrow.lockedLiability(usdcAddr);
  const tw: bigint = await escrow.treasuryWithdrawable(usdcAddr);
  const taw: bigint = await escrow.totalAffiliateWithdrawable(usdcAddr);
  const accounted: bigint = await escrow.accountedBalance(usdcAddr);
  const excess: bigint = await escrow.excessBalance(usdcAddr);
  const stats = {
    deposited: (await escrow.totalDeposited(usdcAddr)) as bigint,
    settled: (await escrow.totalSettled(usdcAddr)) as bigint,
    refunded: (await escrow.totalRefunded(usdcAddr)) as bigint,
    treasuryWithdrawn: (await escrow.totalTreasuryWithdrawn(usdcAddr)) as bigint,
    affiliateWithdrawn: (await escrow.totalAffiliateWithdrawn(usdcAddr)) as bigint,
    excessRescued: (await escrow.totalExcessRescued(usdcAddr)) as bigint,
  };

  // ERC-20 balance via direct view.
  const erc20 = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    usdcAddr,
  );
  const bal: bigint = await erc20.balanceOf(escrowAddr);

  console.log(`  owner():                       ${owner}`);
  console.log(`  treasury():                    ${treasury}`);
  console.log(`  paused():                      ${paused}`);
  console.log(`  allowedTokens(USDC):           ${allowed}`);
  console.log(`  lockedLiability(USDC):         ${locked}`);
  console.log(`  treasuryWithdrawable(USDC):    ${tw}`);
  console.log(`  totalAffiliateWithdrawable:    ${taw}`);
  console.log(`  accountedBalance(USDC):        ${accounted}`);
  console.log(`  excessBalance(USDC):           ${excess}`);
  console.log(`  ERC20.balanceOf(escrow):       ${bal}`);
  console.log(`  totalDeposited(USDC):          ${stats.deposited}`);
  console.log(`  totalSettled(USDC):            ${stats.settled}`);
  console.log(`  totalRefunded(USDC):           ${stats.refunded}`);
  console.log(`  totalTreasuryWithdrawn(USDC):  ${stats.treasuryWithdrawn}`);
  console.log(`  totalAffiliateWithdrawn(USDC): ${stats.affiliateWithdrawn}`);
  console.log(`  totalExcessRescued(USDC):      ${stats.excessRescued}`);

  // Assertions.
  let failed = 0;
  function check(label: string, ok: boolean, hint?: string) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${hint && !ok ? `  [${hint}]` : ""}`);
    if (!ok) failed += 1;
  }

  console.log("");
  console.log("Asserts:");
  if (expectedOwner) {
    check(
      `owner() == GAO_OWNER_ADDRESS`,
      owner.toLowerCase() === expectedOwner.toLowerCase(),
      `expected ${expectedOwner}`,
    );
  }
  if (expectedTreasury) {
    check(
      `treasury() == GAO_TREASURY_ADDRESS`,
      treasury.toLowerCase() === expectedTreasury.toLowerCase(),
      `expected ${expectedTreasury}`,
    );
  }
  check("paused() == false", paused === false);
  check("allowedTokens(USDC) == true", allowed === true);
  check(
    "accountedBalance == locked + treasury + totalAffiliate",
    accounted === locked + tw + taw,
  );
  check("balanceOf(escrow) >= accountedBalance", bal >= accounted);
  check("excessBalance == balanceOf - accountedBalance", excess === bal - accounted);

  // Round-trip getDeposit on bytes32(0): status NONE expected.
  const ZERO32 = "0x" + "00".repeat(32);
  const tup = await escrow.getDeposit(ZERO32);
  check("getDeposit(0).status == NONE", Number(tup[7]) === 0);
  check("isPending(0) == false", (await escrow.isPending(ZERO32)) === false);

  console.log("");
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed — preflight FAIL.`);
  }
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
