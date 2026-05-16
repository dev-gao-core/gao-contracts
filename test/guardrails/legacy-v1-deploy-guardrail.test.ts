// Legacy V1 deploy-path absence — CI-enforced contracts.
//
// Closes Contracts Round 1 finding CC-2: prevent accidental V1
// mainnet broadcast via any legacy entry. V3 is canonical.
//
// V1 source, V1 tests, and the V1 deploy script have been removed
// from this repo. This guardrail makes the removal stick:
//
//   1. `package.json` MUST NOT declare any `deploy:base` /
//      `deploy:base-sepolia` script. Both previously invoked the
//      legacy V1 deploy file. The npm-script surface for deploy
//      is now: `deploy-anchor:base-sepolia` and
//      `deploy-anchor:base` (anchor contract only).
//   2. No npm-script value MAY reference `scripts/deploy.ts`. That
//      file was the V1 deploy entrypoint and has been deleted.
//   3. The V1 deploy script file (`scripts/deploy.ts`) MUST NOT
//      exist in-tree.
//   4. The V1 contract source (`contracts/GaoDomainDeposit.sol`)
//      MUST NOT exist in-tree. V2/V3 do not inherit from V1; the
//      deletion is safe.
//   5. The V1 test file (`test/GaoDomainDeposit.test.ts`) MUST NOT
//      exist in-tree.
//   6. `README.md` MUST NOT contain `npm run deploy:base` or
//      `npm run deploy:base-sepolia` instructions. Operator-facing
//      docs steer to the V3 dev/test script.
//
// V2 source (`contracts/GaoDomainDepositV2.sol`) is intentionally
// preserved because the V3 test file references it for ABI
// compatibility migration coverage.

import { expect } from "chai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const README = join(REPO_ROOT, "README.md");
const LEGACY_DEPLOY_SCRIPT = join(REPO_ROOT, "scripts", "deploy.ts");
const LEGACY_CONTRACT = join(REPO_ROOT, "contracts", "GaoDomainDeposit.sol");
const LEGACY_TEST = join(REPO_ROOT, "test", "GaoDomainDeposit.test.ts");

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as PackageJson;
}

function readReadme(): string {
  return readFileSync(README, "utf8");
}

describe("CC-2 — legacy V1 deploy: npm-script surface", () => {
  it("does NOT declare a `deploy:base` script", () => {
    expect(readPackage().scripts ?? {}).to.not.have.property("deploy:base");
  });

  it("does NOT declare a `deploy:base-sepolia` script", () => {
    expect(readPackage().scripts ?? {}).to.not.have.property(
      "deploy:base-sepolia",
    );
  });

  it("does NOT reference `scripts/deploy.ts` from any npm-script value", () => {
    const scripts = readPackage().scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      expect(value).to.not.match(
        /\bscripts\/deploy\.ts\b/,
        `npm script "${key}" must not invoke the legacy V1 deploy file`,
      );
    }
  });

  it("STILL exposes the anchor (dev/test only) + verify helpers (no over-removal)", () => {
    // CC-4a follow-up: `deploy-anchor:base` (the anchor mainnet
    // wrapper) was removed in the PR that hardens
    // `deployGaoDomainAnchor.ts`. Anchor mainnet deploys live in
    // the private ops repo. The dev/test anchor wrapper stays.
    const scripts = readPackage().scripts ?? {};
    expect(scripts).to.have.property("compile");
    expect(scripts).to.have.property("test");
    expect(scripts).to.have.property("verify:base-sepolia");
    expect(scripts).to.have.property("verify:base");
    expect(scripts).to.have.property("deploy-anchor:base-sepolia");
    expect(scripts).to.not.have.property("deploy-anchor:base");
  });
});

describe("CC-2 — legacy V1 source/test/deploy files removed", () => {
  it("scripts/deploy.ts does NOT exist", () => {
    expect(existsSync(LEGACY_DEPLOY_SCRIPT)).to.equal(false);
  });

  it("contracts/GaoDomainDeposit.sol (V1 contract) does NOT exist", () => {
    expect(existsSync(LEGACY_CONTRACT)).to.equal(false);
  });

  it("test/GaoDomainDeposit.test.ts (V1 tests) does NOT exist", () => {
    expect(existsSync(LEGACY_TEST)).to.equal(false);
  });

  it("V2 contract source is preserved for V3 ABI-compat coverage", () => {
    // Defence-in-depth: V3 test file references V2 for migration
    // ABI compat. If V2 were ever removed too, V3's
    // `ethers.getContractFactory("GaoDomainDepositV2")` call would
    // fail. We pin V2's presence here so the V3 test stays green.
    expect(existsSync(join(REPO_ROOT, "contracts", "GaoDomainDepositV2.sol"))).to.equal(true);
  });

  it("V3 contract source is the canonical entry", () => {
    expect(existsSync(join(REPO_ROOT, "contracts", "GaoDomainDepositV3.sol"))).to.equal(true);
  });

  it("V3 dev/test deploy script is the canonical deploy entry", () => {
    expect(
      existsSync(
        join(REPO_ROOT, "scripts", "deployGaoDomainDepositV3.devtest.ts"),
      ),
    ).to.equal(true);
  });
});

describe("CC-2 — README does not recommend the legacy V1 npm scripts", () => {
  // The README may MENTION the legacy names in a negation
  // ("`deploy:base` is gone") for historical clarity. What it MUST
  // NOT contain is the actual INVOCATION pattern — `npm run
  // deploy:base` or `npm run deploy:base-sepolia` — which would
  // tell an operator to run the legacy entrypoint.

  it("does NOT contain an `npm run deploy:base-sepolia` invocation", () => {
    expect(readReadme()).to.not.match(/\bnpm run deploy:base-sepolia\b/);
  });

  it("does NOT contain an `npm run deploy:base` invocation", () => {
    // Word-boundary after `deploy:base` ensures we don't accidentally
    // match the allowed `npm run deploy-anchor:base` (different
    // command — `deploy-anchor` not `deploy`) or `verify:base`.
    expect(readReadme()).to.not.match(/\bnpm run deploy:base(?:-sepolia)?\b/);
  });
});
