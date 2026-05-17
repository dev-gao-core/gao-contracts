// Export the GaoSafe Genesis + GaoSafeFactory ABIs to abis/multisig/.
//
// This script READS local Hardhat compilation artifacts and WRITES
// JSON ABI files under `abis/multisig/`. It does NOT broadcast any
// transaction, does NOT touch any RPC, and does NOT read any
// environment variable. Safe to run on any machine without secrets.
//
// Output shape mirrors the existing `abis/GaoDomainAnchor.json`
// convention: `{ contractName, abi }`. The ABI is consumed by
// gaokey-mobile PR 3 at a pinned gao-contracts commit sha.
//
// Usage:
//
//   npx hardhat compile                       # ensure artifacts/ is fresh
//   npx ts-node scripts/multisig/exportGaoSafeAbi.ts
//
// The script is intentionally idempotent — re-running with no source
// changes produces byte-identical outputs.

import * as fs from "node:fs";
import * as path from "node:path";

interface HardhatArtifact {
  contractName: string;
  abi: unknown[];
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_ROOT = path.join(REPO_ROOT, "artifacts", "contracts", "multisig");
const OUTPUT_ROOT = path.join(REPO_ROOT, "abis", "multisig");

const TARGETS: ReadonlyArray<{ artifactRel: string; outputName: string }> = [
  {
    artifactRel: path.join("GaoSafe.sol", "GaoSafe.json"),
    outputName: "GaoSafe.json",
  },
  {
    artifactRel: path.join("GaoSafeFactory.sol", "GaoSafeFactory.json"),
    outputName: "GaoSafeFactory.json",
  },
];

function readArtifact(relPath: string): HardhatArtifact {
  const fullPath = path.join(ARTIFACTS_ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Artifact not found at ${fullPath}. Run \`npx hardhat compile\` first.`,
    );
  }
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("contractName" in parsed) ||
    !("abi" in parsed)
  ) {
    throw new Error(`Artifact at ${fullPath} is missing contractName/abi.`);
  }
  const obj = parsed as { contractName: unknown; abi: unknown };
  if (typeof obj.contractName !== "string" || !Array.isArray(obj.abi)) {
    throw new Error(`Artifact at ${fullPath} has wrong shape.`);
  }
  return { contractName: obj.contractName, abi: obj.abi as unknown[] };
}

function writeAbi(outputName: string, contractName: string, abi: unknown[]) {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const outPath = path.join(OUTPUT_ROOT, outputName);
  const body = JSON.stringify({ contractName, abi }, null, 2) + "\n";
  fs.writeFileSync(outPath, body, "utf8");
  return outPath;
}

function main() {
  console.log("→ exporting GaoSafe Genesis ABIs");
  for (const { artifactRel, outputName } of TARGETS) {
    const { contractName, abi } = readArtifact(artifactRel);
    const out = writeAbi(outputName, contractName, abi);
    console.log(`  wrote ${path.relative(REPO_ROOT, out)} (${contractName})`);
  }
  console.log("✓ done");
}

main();
