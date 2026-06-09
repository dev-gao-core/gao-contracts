// GaoDomainPaymentV1 — DEV/TEST ONLY deploy script.
//
// **DO NOT USE FOR MAINNET.** The script ALLOWS only the network IDs in
// `ALLOWED_DEVTEST_CHAIN_IDS` (Hardhat in-memory + local node + Base
// Sepolia + Ethereum Sepolia). It HARD-REFUSES to send a single
// transaction on Base mainnet (chainId 8453), Ethereum mainnet (1), or
// any other id not on the allowlist. The mainnet B4 ceremony for
// GaoDomainPaymentV1 is operator-only and lives under `scripts/mainnet/`
// (added in a separate, reviewed step — NOT here).
//
// Operational contract (mirrors deployGaoDomainDepositV3.devtest.ts):
//   1. Pre-flight env: refuses to broadcast unless DEPLOYER_PRIVATE_KEY,
//      the matching RPC, GAO_TREASURY_ADDRESS, and GAO_USDC_ADDRESS are
//      set. No value is ever logged — only PUBLIC checksummed addresses.
//   2. Chain-allowlist gate + mainnet banlist (belt-and-braces).
//   3. Dry-run by default. Broadcasts ONLY when
//      CONFIRM_DEPLOY_PAYMENT_V1=true.
//   4. Bytecode selector pre-check on the compiled artifact.
//   5. On broadcast: deploys with (initialOwner, initialTreasury),
//      allowlists USDC (only when deployer == owner), and verifies
//      on-chain state with RPC tip-lag retries.
//   6. Writes a deployment record under
//      deployments/devtest/<network>/GaoDomainPaymentV1.json — the
//      `devtest/` directory is the explicit NOT-production signal.
//
// What this script does NOT do:
//   - Never logs DEPLOYER_PRIVATE_KEY or any secret.
//   - Never deploys to mainnet (hard chainId guard, fail-closed).
//   - Never updates production BE config.
//   - Never holds or moves user funds — GaoDomainPaymentV1 forwards
//     payments straight to the treasury; there is no escrow balance.
//
// Usage (dev/test):
//   # dry-run on Base Sepolia
//   GAO_TREASURY_ADDRESS=0x... \
//   GAO_USDC_ADDRESS=0x... \
//     npx hardhat run scripts/deployGaoDomainPaymentV1.devtest.ts --network baseSepolia
//
//   # real dev/test deploy
//   CONFIRM_DEPLOY_PAYMENT_V1=true \
//   GAO_OWNER_ADDRESS=0x... \
//   GAO_TREASURY_ADDRESS=0x... \
//   GAO_USDC_ADDRESS=0x... \
//     npx hardhat run scripts/deployGaoDomainPaymentV1.devtest.ts --network baseSepolia

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { keccak256, toUtf8Bytes } from "ethers";

/** Chain ids the dev/test deploy will broadcast against. Any chainId NOT
 *  on this list — including Base mainnet (8453) and Ethereum mainnet (1)
 *  — causes a fail-closed refusal before any tx is sent. Add entries here
 *  only via a reviewed PR. Mirrors deployGaoDomainDepositV3.devtest.ts. */
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

/** Mainnet chain ids the script explicitly refuses, even if the allowlist
 *  were misconfigured. Belt-and-braces second gate. */
const BANNED_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1,        // Ethereum
  8453,     // Base
  10,       // Optimism
  137,      // Polygon
  42161,    // Arbitrum One
  56,       // BNB Smart Chain
  43114,    // Avalanche C-Chain
]);

/** Selectors the deployed GaoDomainPaymentV1 bytecode MUST contain.
 *  Confirms the compiled source matches the expected surface before any
 *  broadcast. */
const REQUIRED_SELECTORS: ReadonlyArray<{ sig: string; name: string }> = [
  { sig: "payForDomain(bytes32,bytes32,string,address,uint256,string,bytes32)", name: "payForDomain" },
  { sig: "setAllowedToken(address,bool)",          name: "setAllowedToken" },
  { sig: "setTreasury(address)",                   name: "setTreasury" },
  { sig: "pause()",                                name: "pause" },
  { sig: "unpause()",                              name: "unpause" },
  { sig: "rescueToken(address,address,uint256)",   name: "rescueToken" },
  { sig: "treasury()",                             name: "treasury" },
  { sig: "allowedTokens(address)",                 name: "allowedTokens" },
  { sig: "invoicePaid(bytes32)",                   name: "invoicePaid" },
  { sig: "owner()",                                name: "owner" },
  { sig: "paused()",                               name: "paused" },
];

function selOf(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(2, 10);
}

function requireEnvAny(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  throw new Error(`Missing required env. Set one of: ${names.join(", ")}.`);
}

function readEnvAny(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function checksumOrThrow(label: string, raw: string): string {
  const t = raw.trim();
  if (!isAddress(t)) throw new Error(`${label} is not a 40-hex EVM address`);
  return ethers.getAddress(t);
}

function firstFromCsv(raw: string): string {
  return raw.split(",")[0]?.trim() ?? "";
}

async function main(): Promise<void> {
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
      `REFUSED: chainId ${chainId} is not in the dev/test allowlist ` +
        `(${Array.from(ALLOWED_DEVTEST_CHAIN_IDS).join(", ")}). ` +
        `Update ALLOWED_DEVTEST_CHAIN_IDS via PR to add a new dev/test chain.`,
    );
  }

  const treasuryRaw = requireEnvAny("GAO_TREASURY_ADDRESS", "PAYMENT_V1_TREASURY_ADDRESS");
  const usdcRaw = firstFromCsv(
    requireEnvAny("GAO_USDC_ADDRESS", "PAYMENT_V1_USDC_ADDRESS", "PAYMENT_V1_ALLOWED_TOKEN_ADDRESSES"),
  );
  const treasuryAddr = checksumOrThrow("treasury", treasuryRaw);
  const usdcAddr = checksumOrThrow("allowed token", usdcRaw);

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer; DEPLOYER_PRIVATE_KEY missing from env.");
  }
  const signerAddr = await signer.getAddress();

  // Owner: explicit env wins; default to the deployer EOA (canonical
  // dev/test pattern). Post-deploy verify confirms owner() matches.
  const ownerEnvRaw = readEnvAny("GAO_OWNER_ADDRESS", "PAYMENT_V1_OWNER_ADDRESS");
  const ownerAddr = ownerEnvRaw ? checksumOrThrow("owner", ownerEnvRaw) : signerAddr;

  console.log("─".repeat(72));
  console.log("Deploy GaoDomainPaymentV1 (DEV/TEST)");
  console.log(`Network:        ${network.name} (chainId ${chainId})`);
  console.log(`Signer:         ${signerAddr}`);
  console.log(`Owner (ctor):   ${ownerAddr}`);
  console.log(`Treasury (ctor):${treasuryAddr}`);
  console.log(`USDC:           ${usdcAddr}`);
  console.log("─".repeat(72));

  const Factory = await ethers.getContractFactory("GaoDomainPaymentV1");
  const art = await artifacts.readArtifact("GaoDomainPaymentV1");
  console.log(`Bytecode length: ${(art.bytecode.length - 2) / 2} bytes`);

  const lower = art.deployedBytecode.toLowerCase();
  let missing = 0;
  for (const s of REQUIRED_SELECTORS) {
    const hex = selOf(s.sig);
    if (!lower.includes(hex)) {
      missing++;
      console.error(`  MISSING selector ${s.name.padEnd(20)} 0x${hex} (${s.sig})`);
    }
  }
  if (missing > 0) {
    throw new Error(
      `${missing} required selector(s) absent in compiled bytecode — refusing to deploy.`,
    );
  }
  console.log(`All ${REQUIRED_SELECTORS.length} required selectors present in compiled bytecode ✓`);

  if (process.env.CONFIRM_DEPLOY_PAYMENT_V1 !== "true") {
    console.log("");
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast (DEV/TEST ONLY), re-run with: CONFIRM_DEPLOY_PAYMENT_V1=true");
    console.log("PASS (dry-run)");
    return;
  }

  console.log("CONFIRM_DEPLOY_PAYMENT_V1=true — deploying.");
  const payment = await Factory.deploy(ownerAddr, treasuryAddr);
  const deployTx = payment.deploymentTransaction();
  console.log(`  deploy tx: ${deployTx?.hash}`);
  await payment.waitForDeployment();
  const paymentAddr = await payment.getAddress();
  console.log(`  deployed:  ${paymentAddr}`);

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

  // Read-after-write helper: a load-balanced RPC may serve a stale
  // replica that still reports the pre-tx value right after a tx mined.
  // Poll the read until `satisfied` holds or the bounded window is
  // exhausted; a transient RPC error is treated like a stale read and
  // keeps polling. Returns the last observed value — the caller decides
  // whether a still-unsatisfied value is fatal (fail-closed).
  async function readUntil<T>(
    label: string,
    fn: () => Promise<T>,
    satisfied: (v: T) => boolean,
    attempts = 10,
    baseDelay = 2000,
  ): Promise<T> {
    let v: T = await fn();
    for (let i = 0; i < attempts && !satisfied(v); i++) {
      const wait = baseDelay + i * 500; // gentle linear backoff
      console.log(`  ${label} not settled (attempt ${i + 1}/${attempts}); retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
      try {
        v = await fn();
      } catch {
        // transient RPC / replica error — keep the last value and retry
      }
    }
    return v;
  }

  const onChainOwner: string = await retryView("owner()", () => payment.owner());
  const deployerIsOwner = onChainOwner.toLowerCase() === signerAddr.toLowerCase();

  let allowlistTxHash: string | null = null;
  let allowlistBlock: number | null = null;
  if (deployerIsOwner) {
    console.log("Setting USDC on the allowlist…");
    const tx1 = await payment.setAllowedToken(usdcAddr, true);
    allowlistTxHash = tx1.hash;
    console.log(`  setAllowedToken tx: ${tx1.hash}`);
    const r1 = await tx1.wait();
    if (!r1 || r1.status !== 1) {
      throw new Error(
        `setAllowedToken tx ${tx1.hash} did not succeed (status ${r1?.status ?? "null"}).`,
      );
    }
    allowlistBlock = r1.blockNumber;
  } else {
    console.warn(
      `Note: deployer ${signerAddr} != post-deploy owner ${onChainOwner}. ` +
        `setAllowedToken must come from the owner; skipping allowlist here. ` +
        `The owner Safe MUST execute setAllowedToken(USDC, true) as its first action.`,
    );
  }

  // Capture the deploy block for the evidence record (non-fatal if the
  // receipt can't be re-fetched).
  let deployBlock: number | null = null;
  try {
    const dr = await deployTx?.wait();
    deployBlock = dr?.blockNumber ?? null;
  } catch {
    /* leave null — not part of the mandatory verification */
  }

  console.log("");
  console.log("Verifying on-chain state…");
  const owner = await retryView("owner()", () => payment.owner());
  const treasury = await retryView("treasury()", () => payment.treasury());
  const paused = await retryView("paused()", () => payment.paused());

  // Read-after-write: when WE set the allowlist inline (deployer ==
  // owner) the tx is mined, but a stale RPC replica may still return
  // allowedTokens=false. Poll until it catches up; fail-closed if it
  // never does. On the Safe-owner path we did NOT set it here, so a
  // false reading is expected and is not polled-to-true.
  let allowed: boolean;
  if (deployerIsOwner) {
    allowed = await readUntil(
      "allowedTokens(USDC)",
      () => payment.allowedTokens(usdcAddr),
      (v) => v === true,
      10,
      2000,
    );
  } else {
    allowed = await retryView("allowedTokens(USDC)", () => payment.allowedTokens(usdcAddr));
  }

  const ownerOk = owner.toLowerCase() === ownerAddr.toLowerCase();
  const treasuryOk = treasury.toLowerCase() === treasuryAddr.toLowerCase();
  // When deployer == owner we set the allowlist inline → it MUST be true
  // after the read-after-write settle. On the Safe path the Safe sets it
  // later, so a false reading there is not a failure.
  const allowedOk = deployerIsOwner ? allowed === true : true;
  const ok = ownerOk && treasuryOk && paused === false && allowedOk;

  console.log(`  owner():               ${owner}  ${ownerOk ? "✓" : "✗"}`);
  console.log(`  treasury():            ${treasury}  ${treasuryOk ? "✓" : "✗"}`);
  console.log(
    `  allowedTokens(USDC):   ${allowed}  ${allowed ? "✓" : deployerIsOwner ? "✗" : "(set by owner Safe)"}`,
  );
  console.log(`  paused():              ${paused}  ${paused === false ? "✓" : "✗"}`);

  if (!ok) {
    throw new Error("Post-deploy verification failed — see ✗ marks above.");
  }

  // Only reached after ALL mandatory checks passed → safe to persist the
  // deployment evidence record.
  const deploymentsDir = path.join(__dirname, "..", "deployments", "devtest", network.name);
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const record = {
    contract: "GaoDomainPaymentV1",
    tier: "devtest",
    network: network.name,
    chainId,
    address: paymentAddr,
    deployer: signerAddr,
    owner,
    treasury,
    allowedToken: usdcAddr,
    allowedTokenActive: allowed,
    deployTxHash: deployTx?.hash ?? null,
    deployBlockNumber: deployBlock,
    setAllowedTokenTxHash: allowlistTxHash,
    setAllowedTokenBlockNumber: allowlistBlock,
    deployedAt: new Date().toISOString(),
    abi: art.abi,
    bytecodeLength: (art.bytecode.length - 2) / 2,
  };
  const recordPath = path.join(deploymentsDir, "GaoDomainPaymentV1.json");
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
