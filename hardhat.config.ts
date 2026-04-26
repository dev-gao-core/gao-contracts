import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

// Load env from .env (gitignored). NEVER commit a real .env.
dotenv.config();

// Reads env without falling back to a placeholder address. Returns
// undefined when unset so Hardhat's default network selection isn't
// surprised by a string like "0xPLACEHOLDER".
function readPrivateKey(): string[] {
  const pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) return [];
  // Tolerate a missing 0x prefix.
  return [pk.startsWith("0x") ? pk : `0x${pk}`];
}

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "";
const BASE_RPC = process.env.BASE_RPC_URL ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Output the canonical metadata so block explorers (Basescan,
      // Etherscan) can verify against the same source map / settings.
      metadata: { bytecodeHash: "ipfs" },
    },
  },
  paths: {
    // Standard Hardhat layout: contracts/ holds the .sol files,
    // contracts/test/ holds Solidity-only test mocks (MockERC20 etc.),
    // test/ holds TypeScript test files.
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      // In-memory chain. `npx hardhat test` uses this by default.
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: readPrivateKey(),
    },
    base: {
      url: BASE_RPC,
      chainId: 8453,
      accounts: readPrivateKey(),
    },
  },
  etherscan: {
    // Basescan etherscan-format API key. One key works for both
    // Sepolia + mainnet under the unified Etherscan v2 API.
    apiKey: {
      base: process.env.BASESCAN_API_KEY ?? "",
      baseSepolia: process.env.BASESCAN_API_KEY ?? "",
    },
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
};

export default config;
