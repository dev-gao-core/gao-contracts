// GaoDomainDepositV3 — BASE MAINNET deploy script (B4 ceremony).
//
// **OPERATOR-ONLY.** This script is the canonical Base mainnet
// (chainId 8453) deploy entry for `GaoDomainDepositV3`. It is a
// SIBLING of `scripts/deployGaoDomainDepositV3.devtest.ts` — not a
// replacement. The dev/test script ALLOWS testnets and BANS
// mainnet; this script does the inverse: ALLOWS mainnet only and
// BANS every dev/test chain so a misconfigured `--network` falls
// closed.
//
// The script does NOT broadcast unless the operator sets the
// literal string `"true"` in `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET`.
// Default behaviour (env unset, env=any-other-value) prints what
// it WOULD do and exits 0. No transaction is sent on a dry-run.
//
// Operational contract:
//   1. Chain-allowlist gate (8453 only) + dev/test banlist (refuses
//      hardhat/sepolia/etc.) BEFORE any signer is loaded.
//   2. `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET=true` gate. Any
//      other value (or unset) runs as dry-run.
//   3. Required env: `GAO_OWNER_ADDRESS`, `GAO_TREASURY_ADDRESS`.
//      Treasury MUST be non-zero AND distinct from owner (V3 spec).
//   4. Allowed token defaults to canonical Base mainnet USDC
//      `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. If operator
//      supplies `GAO_USDC_ADDRESS`, the script REFUSES unless it
//      equals the canonical value (defence against typo →
//      depositing into a fake USDC).
//   5. Bytecode selector pre-check on the compiled artifact —
//      mirrors the dev/test script's pre-broadcast guard.
//   6. On broadcast:
//        - deploy `GaoDomainDepositV3(initialOwner, initialTreasury)`
//        - if deployer == initialOwner, call `setAllowedToken(USDC, true)`
//          in a follow-up tx (same pattern as dev/test)
//        - if deployer != initialOwner (Safe / multisig owner), SKIP
//          allowlist and print the exact owner-side follow-up
//   7. Write `deployments/base/GaoDomainDepositV3.json` with public
//      values only (no secret values).
//
// What this script does NOT do:
//   - Never logs `DEPLOYER_PRIVATE_KEY`. Reads it once via the
//     hardhat provider (`network.config.accounts`) without rendering.
//   - Never logs `BASE_RPC_URL` (RPC URLs typically embed API keys).
//   - Never updates production BE config. The on-disk record is
//     consumed manually by the operator after the ceremony.
//   - Never moves V2 funds. Strictly constructor + (optional)
//     setAllowedToken + post-deploy verify.
//
// Usage (operator-only ceremony, trusted workstation):
//
//   # dry-run (default — prints what it would do, no tx sent)
//   GAO_OWNER_ADDRESS=0x...            \
//   GAO_TREASURY_ADDRESS=0x...         \
//     npx hardhat run scripts/mainnet/deployGaoDomainDepositV3.mainnet.ts --network base
//
//   # real deploy (operator-acknowledged)
//   CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET=true \
//   GAO_OWNER_ADDRESS=0x...                       \
//   GAO_TREASURY_ADDRESS=0x...                    \
//     npx hardhat run scripts/mainnet/deployGaoDomainDepositV3.mainnet.ts --network base
//
//   # verify on Basescan
//   BASESCAN_API_KEY=<set> \
//     npx hardhat verify --network base <V3_ADDRESS> <GAO_OWNER_ADDRESS> <GAO_TREASURY_ADDRESS>
//
// Companion runbook: `docs/runbooks/base-mainnet-deploy-b4.md`.

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { keccak256, toUtf8Bytes } from "ethers";

/** Mainnet chain ids the script will broadcast against. Only Base
 *  mainnet is on the allowlist; every other mainnet (Ethereum, OP,
 *  etc.) and every testnet is refused. */
const ALLOWED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  8453, // Base mainnet
]);

/** Dev/test + foreign-mainnet chain ids the script explicitly
 *  refuses, even if the allowlist were misconfigured. Belt-and-
 *  braces second gate.
 *
 *  This is the INVERSE of the dev/test script's banlist: there,
 *  mainnet 8453 is banned; here, testnets + foreign mainnets are
 *  banned so a `--network baseSepolia` typo falls closed. */
const BANNED_NON_BASE_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  // Hardhat in-memory + standalone node
  31337, 1337,
  // Base Sepolia + Ethereum Sepolia
  84532, 11155111, 5,
  // Other L1/L2 mainnets — refuse even if operator passes --network
  // pointing at them.
  1,     // Ethereum
  10,    // Optimism
  137,   // Polygon
  42161, // Arbitrum One
  56,    // BNB Smart Chain
  43114, // Avalanche C-Chain
]);

/** Canonical Base mainnet USDC. Public value. If `GAO_USDC_ADDRESS`
 *  is supplied by the operator, the script refuses unless it
 *  equals this address (case-insensitive). */
const CANONICAL_BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Selectors the deployed V3 bytecode MUST contain. Mirrors the
 *  dev/test deploy script's matrix. */
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
  { sig: "settle(bytes32,address,uint256)",                  name: "settle" },
  { sig: "refund(bytes32)",                                  name: "refund" },
  { sig: "affiliateWithdrawable(address,address)",           name: "affiliateWithdrawable" },
  { sig: "totalAffiliateWithdrawable(address)",              name: "totalAffiliateWithdrawable" },
  { sig: "withdrawAffiliate(address,uint256)",               name: "withdrawAffiliate (V3 LOCK: always reverts)" },
  { sig: "withdrawAffiliateFor(address,address,uint256)",    name: "withdrawAffiliateFor" },
  { sig: "rescueExcessToken(address,address,uint256)",       name: "rescueExcessToken" },
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function checksumOrThrow(label: string, raw: string): string {
  const t = raw.trim();
  if (!isAddress(t)) throw new Error(`${label} is not a 40-hex EVM address`);
  const checksum = ethers.getAddress(t);
  // The V3 contract constructor rejects address(0) for treasury, and
  // OZ Ownable v5 rejects address(0) for the initial owner. We
  // fail-close earlier in the script so the operator does not waste
  // gas on a tx that would revert in the constructor.
  if (checksum.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`REFUSED: ${label} must not be the zero address`);
  }
  return checksum;
}

/** Best-effort current commit lookup. Returns null if `git` is not
 *  available or the repo is not a git checkout (CI tarball). */
function readSourceCommit(): string | null {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd: path.join(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // ── Guard 1: chainId gates (run BEFORE any signer load) ──────────
  const chainId = network.config.chainId;
  if (chainId === undefined) {
    throw new Error("network.config.chainId is undefined — refusing.");
  }
  if (BANNED_NON_BASE_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is NOT Base mainnet (8453). ` +
        `This is the MAINNET deploy script — testnets and foreign ` +
        `mainnets are banlisted. For Base Sepolia, use ` +
        `scripts/deployGaoDomainDepositV3.devtest.ts.`,
    );
  }
  if (!ALLOWED_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSED: chainId ${chainId} is not in the mainnet allowlist ` +
        `(${Array.from(ALLOWED_MAINNET_CHAIN_IDS).join(", ")}). ` +
        `Update ALLOWED_MAINNET_CHAIN_IDS via PR to add a new mainnet target.`,
    );
  }

  // ── Env: owner / treasury / USDC ─────────────────────────────────
  const ownerRaw    = requireEnv("GAO_OWNER_ADDRESS");
  const treasuryRaw = requireEnv("GAO_TREASURY_ADDRESS");
  const ownerAddr    = checksumOrThrow("owner",    ownerRaw);
  const treasuryAddr = checksumOrThrow("treasury", treasuryRaw);

  // Treasury distinct from owner (V3 contract spec: "Distinct from
  // owner so the controller can be separated from the revenue-
  // receiving wallet").
  if (ownerAddr.toLowerCase() === treasuryAddr.toLowerCase()) {
    throw new Error(
      "REFUSED: GAO_TREASURY_ADDRESS must be DISTINCT from GAO_OWNER_ADDRESS. " +
        "The V3 spec separates controller from revenue-receiving wallet.",
    );
  }

  // USDC: default to canonical Base mainnet USDC. Operator MAY pass
  // `GAO_USDC_ADDRESS` for explicitness; if so, it MUST equal the
  // canonical value (no typo, no testnet, no fork-token).
  const usdcSupplied = process.env.GAO_USDC_ADDRESS?.trim();
  const usdcAddr = (() => {
    const canonical = ethers.getAddress(CANONICAL_BASE_USDC);
    if (!usdcSupplied) return canonical;
    if (!isAddress(usdcSupplied)) {
      throw new Error("GAO_USDC_ADDRESS is not a 40-hex EVM address");
    }
    const supplied = ethers.getAddress(usdcSupplied);
    if (supplied !== canonical) {
      throw new Error(
        `REFUSED: GAO_USDC_ADDRESS (${supplied}) does not equal the canonical ` +
          `Base mainnet USDC (${canonical}). The mainnet script will not ` +
          `allowlist a non-canonical token.`,
      );
    }
    return supplied;
  })();

  // ── Signer ───────────────────────────────────────────────────────
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer available — set DEPLOYER_PRIVATE_KEY in .env");
  }
  const signerAddr = await signer.getAddress();

  console.log("─".repeat(72));
  console.log("Deploy GaoDomainDepositV3 — BASE MAINNET (B4 ceremony)");
  console.log(`Network:         ${network.name} (chainId ${chainId})`);
  console.log(`Deployer:        ${signerAddr}`);
  console.log(`Initial owner:   ${ownerAddr}`);
  console.log(`Initial treasury:${treasuryAddr}`);
  console.log(`Allowed token:   ${usdcAddr} (Base mainnet USDC, canonical)`);
  console.log("─".repeat(72));

  if (signerAddr.toLowerCase() === ownerAddr.toLowerCase()) {
    console.log("NOTE: deployer == initialOwner. After deploy the script");
    console.log("      will call setAllowedToken(USDC, true) in a follow-up tx.");
  } else {
    console.log("NOTE: deployer != initialOwner.");
    console.log("      Recommended: initialOwner is a Safe / multisig.");
    console.log("      The script will NOT call setAllowedToken — the owner");
    console.log("      MUST call setAllowedToken(USDC, true) from the Safe");
    console.log("      after deploy. Required for /v2/contracts/health to");
    console.log("      go healthy.");
  }
  console.log("─".repeat(72));

  // ── Bytecode selector pre-check ──────────────────────────────────
  const Factory = await ethers.getContractFactory("GaoDomainDepositV3");
  const art = await artifacts.readArtifact("GaoDomainDepositV3");
  console.log(`Bytecode length: ${(art.bytecode.length - 2) / 2} bytes`);

  const lower = art.deployedBytecode.toLowerCase();
  let missing = 0;
  for (const s of REQUIRED_SELECTORS) {
    const hex = selOf(s.sig);
    if (!lower.includes(hex)) {
      missing++;
      console.error(`  MISSING selector ${s.name.padEnd(48)} 0x${hex} (${s.sig})`);
    }
  }
  if (missing > 0) {
    throw new Error(
      `${missing} required selector(s) absent in compiled bytecode — refusing to deploy.`,
    );
  }
  console.log(`All ${REQUIRED_SELECTORS.length} required selectors present in compiled bytecode ✓`);

  // ── Confirm gate ──────────────────────────────────────────────────
  const confirm = (process.env.CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET ?? "").trim();
  if (confirm !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast (BASE MAINNET, OPERATOR-ONLY), re-run with:");
    console.log("  CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET=true");
    console.log("PASS (dry-run)");
    return;
  }

  console.log("CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET=true — deploying.");
  const escrow = await Factory.deploy(ownerAddr, treasuryAddr);
  const deployTx = escrow.deploymentTransaction();
  console.log(`  deploy tx: ${deployTx?.hash}`);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`  deployed:  ${escrowAddr}`);

  async function retryView<T>(
    label: string,
    fn: () => Promise<T>,
    n = 5,
    delay = 2000,
  ): Promise<T> {
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

  // ── Optional follow-up: setAllowedToken when deployer == owner ───
  let setAllowedTokenTxHash: string | null = null;
  const onChainOwner: string = await retryView("owner()", () => escrow.owner());
  if (onChainOwner.toLowerCase() === signerAddr.toLowerCase()) {
    console.log("Setting USDC on the allowlist (deployer == owner)…");
    const tx1 = await escrow.setAllowedToken(usdcAddr, true);
    setAllowedTokenTxHash = tx1.hash;
    console.log(`  setAllowedToken tx: ${tx1.hash}`);
    await tx1.wait();
  } else {
    console.log("Skipping setAllowedToken — deployer is not the owner.");
    console.log(`Owner (${onChainOwner}) MUST call from the Safe / multisig:`);
    console.log(`  GaoDomainDepositV3(${escrowAddr}).setAllowedToken(`);
    console.log(`    ${usdcAddr}, // canonical Base mainnet USDC`);
    console.log(`    true`);
    console.log(`  )`);
  }

  // ── Post-deploy verify ──────────────────────────────────────────
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
  // When deployer != owner, allowedTokens(USDC) is EXPECTED to be
  // false at this point (owner must call setAllowedToken from Safe).
  // We still PASS the verify since the contract is otherwise healthy;
  // the artifact records `allowedToken: false` so the operator can
  // close it out post-Safe-call.
  const deployerIsOwner = onChainOwner.toLowerCase() === signerAddr.toLowerCase();
  const allowedExpected = deployerIsOwner ? true : false;
  const ok =
    owner.toLowerCase()    === ownerAddr.toLowerCase() &&
    treasury.toLowerCase() === treasuryAddr.toLowerCase() &&
    allowed === allowedExpected &&
    paused === false &&
    locked === 0n && tw === 0n && taw === 0n;

  console.log(`  owner():                       ${owner}  ${owner.toLowerCase() === ownerAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  treasury():                    ${treasury}  ${treasury.toLowerCase() === treasuryAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  allowedTokens(USDC):           ${allowed}  ${allowed === allowedExpected ? "✓" : "✗"} (expected ${allowedExpected})`);
  console.log(`  paused():                      ${paused}  ${paused === false ? "✓" : "✗"}`);
  console.log(`  lockedLiability(USDC):         ${locked}  ${locked === 0n ? "✓" : "✗"}`);
  console.log(`  treasuryWithdrawable(USDC):    ${tw}  ${tw === 0n ? "✓" : "✗"}`);
  console.log(`  totalAffiliateWithdrawable:    ${taw}  ${taw === 0n ? "✓" : "✗"}`);

  if (!ok) {
    throw new Error("Post-deploy verification failed — see ✗ marks above.");
  }

  // ── Persist deployment record ────────────────────────────────────
  // Path: `deployments/base/GaoDomainDepositV3.json` (kebab `base`
  // matches the on-disk convention used by GaoDomainAnchor's
  // base-sepolia deploy; signals MAINNET via the absence of any
  // `devtest/` parent segment).
  const deploymentsDir = path.join(__dirname, "..", "..", "deployments", "base");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const sourceCommit = readSourceCommit();
  const record = {
    contract: "GaoDomainDepositV3",
    tier: "production",
    network: "base",
    chainId,
    address: escrowAddr,
    deployer: signerAddr,
    owner,
    treasury,
    allowedToken: usdcAddr,
    allowedTokenSet: allowed,
    deployTxHash: deployTx?.hash ?? null,
    setAllowedTokenTxHash,
    constructorArgs: {
      initialOwner: ownerAddr,
      initialTreasury: treasuryAddr,
    },
    deployedAt: new Date().toISOString(),
    sourceCommit,
    bytecodeLength: (art.bytecode.length - 2) / 2,
    abi: art.abi,
    notes: [
      "Base mainnet (chainId 8453) production deploy.",
      "Allowed token is the canonical Base mainnet USDC.",
      deployerIsOwner
        ? "Deployer == initialOwner; setAllowedToken executed inline."
        : "Deployer != initialOwner; owner MUST call setAllowedToken from the Safe / multisig before /v2/contracts/health goes healthy.",
    ],
  };
  const recordPath = path.join(deploymentsDir, "GaoDomainDepositV3.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log("");
  console.log(`Deployment record written: ${recordPath}`);

  console.log("");
  console.log("─".repeat(72));
  console.log("Next steps (operator-driven, NOT auto):");
  console.log(`  1. npx hardhat verify --network base ${escrowAddr} \\`);
  console.log(`        ${ownerAddr} \\`);
  console.log(`        ${treasuryAddr}`);
  if (!deployerIsOwner) {
    console.log(`  2. Owner Safe / multisig calls setAllowedToken(${usdcAddr}, true)`);
    console.log(`     on ${escrowAddr}.`);
  }
  console.log(`  3. Pin GAO_DOMAIN_ESCROW_ADDRESS=${escrowAddr} in`);
  console.log(`     gao-id-worker-ops wrangler.prod.template.toml.`);
  console.log("─".repeat(72));
  console.log("PASS");
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
