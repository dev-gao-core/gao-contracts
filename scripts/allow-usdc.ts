// Allowlist USDC on the deployed GaoDomainDeposit escrow (Base Sepolia).
//
// Why this exists: the escrow was deployed without USDC in `allowedTokens`,
// so every deposit() reverts with `TokenNotAllowed()`. Wallet UIs surface
// this as "Network fee: Unavailable" because gas estimation reverts. This
// script flips the on-chain config — no FE / pricing / redeploy involved.
//
// Usage:
//   npx hardhat run scripts/allow-usdc.ts --network baseSepolia
//
// Required env (loaded from contracts/.env, which is gitignored):
//   DEPLOYER_PRIVATE_KEY   — must be the current contract owner.
//   BASE_SEPOLIA_RPC_URL   — private RPC endpoint.
//
// The script is idempotent: if USDC is already allowed it exits PASS
// without sending a tx. It never logs the private key.

import { ethers, network } from "hardhat";

const ESCROW = "0xcFC746DF306Fa0C4512CA98f83aC7B6B143c2a13";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EXPECTED_CHAIN_ID = 84532; // Base Sepolia

// Minimal ABI — only the functions we touch. Avoids depending on the full
// artifact in case the local compile is out of sync with the deployed build.
const ABI = [
  "function owner() view returns (address)",
  "function allowedTokens(address) view returns (bool)",
  "function setAllowedToken(address token, bool allowed) external",
  "event AllowedTokenSet(address indexed token, bool allowed)",
];

async function main(): Promise<void> {
  if (network.config.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong network. Expected chainId ${EXPECTED_CHAIN_ID} (Base Sepolia), got ${network.config.chainId}. ` +
        `Run with: npx hardhat run scripts/allow-usdc.ts --network baseSepolia`,
    );
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error(
      "No signer available — set DEPLOYER_PRIVATE_KEY in contracts/.env",
    );
  }

  const signerAddr = await signer.getAddress();
  const escrow = new ethers.Contract(ESCROW, ABI, signer);

  console.log("─".repeat(70));
  console.log(`Network:   ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Escrow:    ${ESCROW}`);
  console.log(`USDC:      ${USDC}`);
  console.log(`Signer:    ${signerAddr}`);
  console.log("─".repeat(70));

  // Owner gate — surface a clear message if the loaded key isn't the owner,
  // rather than letting the onlyOwner modifier revert on-chain.
  const owner: string = await escrow.owner();
  console.log(`Owner:     ${owner}`);
  if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddr} is not the contract owner ${owner}. ` +
        `Run this from the owning EOA / multisig instead.`,
    );
  }

  // Before
  const before: boolean = await escrow.allowedTokens(USDC);
  console.log(`allowedTokens(USDC) before:  ${before}`);

  if (before) {
    console.log("");
    console.log("USDC is already allowed — no transaction sent.");
    console.log("PASS");
    return;
  }

  // Send tx
  console.log("Sending setAllowedToken(USDC, true)…");
  const tx = await escrow.setAllowedToken(USDC, true);
  console.log(`  tx hash:   ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Transaction had no receipt — RPC dropped it?");
  }
  console.log(`  block:     ${receipt.blockNumber}`);
  console.log(`  status:    ${receipt.status === 1 ? "success" : "FAILED"}`);
  console.log(`  gas used:  ${receipt.gasUsed.toString()}`);
  if (receipt.status !== 1) {
    throw new Error("Transaction reverted on-chain.");
  }

  // After
  const after: boolean = await escrow.allowedTokens(USDC);
  console.log(`allowedTokens(USDC) after:   ${after}`);

  if (!after) {
    throw new Error(
      "Post-tx read still returns false. Did the tx actually mutate state?",
    );
  }

  console.log("");
  console.log("PASS");
}

main().catch((e) => {
  // Never log the signer's private key. Hardhat's ethers wrapper does not
  // include it in error objects, but stay defensive: print only the message.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
