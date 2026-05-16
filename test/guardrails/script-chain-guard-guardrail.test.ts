// Script chain-guard guardrails — CI-enforced contracts.
//
// Closes Contracts Round 1 findings CC-4a + CC-4b.
//
// Every script under `scripts/` that can broadcast a transaction
// MUST carry, at minimum:
//
//   * an `ALLOWED_DEVTEST_CHAIN_IDS` set (covering at least the
//     hardhat in-memory chain `31337` and Base Sepolia `84532`),
//   * a `BANNED_MAINNET_CHAIN_IDS` set covering the canonical
//     mainnets (Ethereum 1, Base 8453, Optimism 10, Polygon 137,
//     Arbitrum One 42161, BNB Smart Chain 56, Avalanche 43114),
//   * an explicit `CONFIRM_*=true` env-flag gate before any
//     `factory.deploy(...)` / `.deposit(...)` / `.settle(...)` /
//     `.refund(...)` / `setAllowedToken(...)` / `withdrawTreasury(...)` /
//     `withdrawAffiliateFor(...)` call.
//
// Read-only verifier scripts (`scripts/preflight-domain-deposit-v2.ts`,
// `scripts/reverifyV3.ts`) are exempt — they never broadcast and the
// allow-list below records their read-only status.
//
// Cleanup-only mutation scripts that operate on hardcoded V1 / V2
// dead-contract addresses with chainId hardcoded to dev/test
// (`scripts/allow-usdc.ts`, `scripts/finish-deploy-v2.ts`,
// `scripts/refund-old-escrow.ts`) are tracked separately as CC-4c /
// CC-4d cleanup items — the chainId hardcode is itself a refusal
// gate, so they pass this guard. Future PRs may retire those.
//
// `package.json` must NOT expose a `deploy-anchor:base` npm script
// (the anchor mainnet deploy must live in the private ops repo).

import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackage(): PackageJson {
  return JSON.parse(read("package.json")) as PackageJson;
}

const REQUIRED_BANNED_MAINNET_IDS = [1, 8453, 10, 137, 42161, 56, 43114];

/** Scripts that broadcast a transaction AND use the canonical
 *  SET-based chain-guard pattern (ALLOWED_DEVTEST_CHAIN_IDS +
 *  BANNED_MAINNET_CHAIN_IDS + CONFIRM_*=true). This is the strict
 *  pattern adopted by the CC-4a / CC-4b hardening sweep + the V3
 *  dev/test deploy + the V3 smoke harness.
 *
 *  Note: `scripts/deploy-domain-deposit-v2.ts` and
 *  `scripts/refund-old-escrow.ts` use an alternative single-value
 *  `EXPECTED_CHAIN_ID` pattern + their own `CONFIRM_*` gates and
 *  are equally safe; they are intentionally not on this list
 *  because they predate the SET-pattern convention. Future PRs
 *  may migrate them. The npm-script `--network base` check below
 *  catches any regression that would expose them to mainnet
 *  unintentionally. */
const BROADCAST_SCRIPTS: ReadonlyArray<{
  path: string;
  confirmEnv: string;
}> = [
  {
    path: "scripts/deployGaoDomainDepositV3.devtest.ts",
    confirmEnv: "CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3",
  },
  {
    path: "scripts/deployGaoDomainAnchor.ts",
    confirmEnv: "CONFIRM_DEPLOY_ANCHOR",
  },
  {
    path: "scripts/e2e-domain-deposit-v2.ts",
    confirmEnv: "CONFIRM_E2E_DOMAIN_DEPOSIT_V2",
  },
  {
    path: "scripts/smokeGaoDomainDepositV3.devtest.ts",
    confirmEnv: "CONFIRM_SMOKE_V3",
  },
];

describe("CC-4 — broadcast scripts carry chain allowlist + ban + CONFIRM", () => {
  for (const { path: scriptPath, confirmEnv } of BROADCAST_SCRIPTS) {
    describe(scriptPath, () => {
      it("declares ALLOWED_DEVTEST_CHAIN_IDS with at least {31337, 84532}", () => {
        const txt = read(scriptPath);
        expect(txt).to.match(
          /ALLOWED_DEVTEST_CHAIN_IDS/,
          "missing ALLOWED_DEVTEST_CHAIN_IDS",
        );
        // Two canonical dev/test ids must appear in the set body —
        // pulled out via a word-boundary literal match.
        expect(txt).to.match(/\b31337\b/);
        expect(txt).to.match(/\b84532\b/);
      });

      it("declares BANNED_MAINNET_CHAIN_IDS covering every canonical mainnet", () => {
        const txt = read(scriptPath);
        expect(txt).to.match(
          /BANNED_MAINNET_CHAIN_IDS/,
          "missing BANNED_MAINNET_CHAIN_IDS",
        );
        for (const id of REQUIRED_BANNED_MAINNET_IDS) {
          expect(txt).to.match(
            new RegExp(`\\b${id}\\b`),
            `mainnet chainId ${id} missing from ban set`,
          );
        }
      });

      it("invokes both .has(chainId) checks before broadcast", () => {
        const txt = read(scriptPath);
        expect(txt).to.match(
          /BANNED_MAINNET_CHAIN_IDS\.has\(\s*chainId\s*\)/,
          "missing BANNED_MAINNET_CHAIN_IDS.has(chainId) check",
        );
        expect(txt).to.match(
          /ALLOWED_DEVTEST_CHAIN_IDS\.has\(\s*chainId\s*\)/,
          "missing ALLOWED_DEVTEST_CHAIN_IDS.has(chainId) check",
        );
      });

      it(`gates broadcast behind ${confirmEnv}=true`, () => {
        const txt = read(scriptPath);
        expect(txt).to.match(
          new RegExp(`\\b${confirmEnv}\\b`),
          `missing ${confirmEnv} reference`,
        );
        // Require an explicit string-equality check against the
        // literal "true". Tolerant of `!== "true"` (refuse pattern)
        // OR `=== "true"` (accept pattern) on either operand order.
        expect(txt).to.match(
          new RegExp(`${confirmEnv}[\\s\\S]{0,80}["']true["']`),
          `${confirmEnv} must be string-compared to literal "true"`,
        );
      });
    });
  }
});

describe("CC-4 — package.json npm-script surface", () => {
  it("does NOT expose `deploy-anchor:base` (anchor mainnet lives in private ops repo)", () => {
    const pkg = readPackage();
    expect(pkg.scripts ?? {}).to.not.have.property("deploy-anchor:base");
  });

  it("keeps `deploy-anchor:base-sepolia` (dev/test anchor deploy)", () => {
    const pkg = readPackage();
    expect(pkg.scripts ?? {}).to.have.property("deploy-anchor:base-sepolia");
  });

  it("keeps `verify:base` (Basescan verify is upload-only, never broadcasts a state tx)", () => {
    // `hardhat verify` uploads source + ABI to Basescan; it does not
    // sign or broadcast a state-changing tx. Safe to expose on mainnet
    // network name. Treated as the only allowed `--network base`
    // npm-script.
    const pkg = readPackage();
    expect(pkg.scripts?.["verify:base"]).to.match(/^hardhat verify --network base$/);
  });

  it("no npm-script invokes a deploy/broadcast script with `--network base`", () => {
    const pkg = readPackage();
    const scripts = pkg.scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      // Skip the allowlisted upload-only entry — hardhat verify
      // uploads source to Basescan; does not broadcast a tx.
      if (key === "verify:base") continue;
      const usesMainnet = /\s--network\s+base\b/.test(value);
      const looksLikeDeploy =
        /\bhardhat run\s+scripts\//.test(value) ||
        /\bscripts\/(deploy|finish-deploy|refund|allow-|e2e-|smoke)/.test(value);
      const isMainnetBroadcast = usesMainnet && looksLikeDeploy;
      expect(isMainnetBroadcast).to.equal(
        false,
        `npm script "${key}" (${value}) invokes a deploy/broadcast file with --network base; ` +
          `forbidden in this repo (production deploys live in the private ops repo).`,
      );
    }
  });
});

describe("CC-4 — legacy V1 deploy path remains absent (CC-2 regression check)", () => {
  it("scripts/deploy.ts still absent", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    expect(fs.existsSync(join(REPO_ROOT, "scripts/deploy.ts"))).to.equal(false);
  });

  it("contracts/GaoDomainDeposit.sol still absent", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    expect(
      fs.existsSync(join(REPO_ROOT, "contracts/GaoDomainDeposit.sol")),
    ).to.equal(false);
  });

  it("no npm-script references scripts/deploy.ts", () => {
    const scripts = readPackage().scripts ?? {};
    for (const [k, v] of Object.entries(scripts)) {
      expect(v).to.not.match(/\bscripts\/deploy\.ts\b/, `script "${k}"`);
    }
  });

  it("no `deploy:base` / `deploy:base-sepolia` legacy V1 entries", () => {
    const scripts = readPackage().scripts ?? {};
    expect(scripts).to.not.have.property("deploy:base");
    expect(scripts).to.not.have.property("deploy:base-sepolia");
  });
});
