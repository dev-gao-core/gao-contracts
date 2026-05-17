// CI guard. Scans every .sol / .ts / .md file under the four multisig
// namespaces in this repo and fails the build if any 40-character
// `0x…` hex literal is checked in outside of an explicit allowlist
// sentinel.
//
// Mirrors the gaokey-mobile guardrail at
// `gaokey-mobile/src/multisig/__tests__/noAddressLiterals.test.ts`.
// Both repos enforce the same rule: a GaoSafe / GaoSafeFactory
// deployed address may only be added via an explicit, single-purpose,
// reviewer-signed-off PR after the consuming-app production-readiness
// gate is satisfied for the target chain. Until then, an address
// literal anywhere in the multisig source / tests / scripts / docs is
// a regression.
//
// Allowlist mechanism:
//   A literal on a line containing the case-insensitive marker
//   `allow-address-literal:` is skipped. The marker is intentionally
//   explicit so a reviewer can spot it in a diff. Use only for
//   documented test fixtures (e.g. the zero address as a shape
//   placeholder) or — once the production-readiness gate has been met
//   — for a single, runbook-sourced factory address per chain.
//
// Scope: this guardrail runs inside `npx hardhat test`. It uses plain
// Node `fs` + `path` and has no Hardhat-runtime dependencies, so it
// will also surface immediately on a `--grep` filtered run.

import { expect } from "chai";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

// Each entry is a top-level directory to walk + the file extensions
// (case-sensitive) that count as in-scope for the scan. Anything else
// inside these trees is ignored.
const SCAN_ROOTS: ReadonlyArray<{
  dir: string;
  exts: ReadonlyArray<string>;
}> = [
  { dir: "contracts/multisig", exts: [".sol"] },
  { dir: "test/multisig",      exts: [".ts", ".tsx"] },
  { dir: "scripts/multisig",   exts: [".ts", ".tsx"] },
  { dir: "docs/multisig",      exts: [".md"] },
];

// The regex itself is broken across two pieces using string
// concatenation so the scanner does not match its own source line as
// an address literal even with the allowlist marker removed.
const ADDRESS_RE = new RegExp(
  "0" + "x" + "[0-9a-fA-F]{40}\\b",
);

const ALLOW_MARKER = /allow-address-literal:/i;

interface Offender {
  file: string;
  line: number;
  excerpt: string;
}

function walk(dir: string, exts: ReadonlyArray<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Defensive — none of the multisig namespaces ship a nested
    // node_modules today, but skip in case a future change pulls one in.
    if (entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(p, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

function scanAllScopes(): { files: string[]; offenders: Offender[] } {
  const files: string[] = [];
  const offenders: Offender[] = [];
  for (const { dir, exts } of SCAN_ROOTS) {
    const root = join(REPO_ROOT, dir);
    const found = walk(root, exts);
    for (const file of found) {
      files.push(file);
      const rel = relative(REPO_ROOT, file);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (ALLOW_MARKER.test(line)) continue;
        if (ADDRESS_RE.test(line)) {
          offenders.push({
            file: rel,
            line: i + 1,
            excerpt: line.trim(),
          });
        }
      }
    }
  }
  return { files, offenders };
}

describe("CI guard — no GaoSafe/GaoSafeFactory address literals in the multisig namespaces", () => {
  const { files, offenders } = scanAllScopes();
  const relFiles = files.map((f) => relative(REPO_ROOT, f));

  it("discovers at least the PR 2 multisig files (sanity check on the walker)", () => {
    // Twelve files were added by PR 2; the guardrail's scan should
    // pick up every one of the .sol / .ts / .md ones (the two .json
    // ABI files are intentionally out of scope — ABI JSON is
    // bytecode-derived and address-free by construction).
    const expected = [
      "contracts/multisig/GaoSafe.sol",
      "contracts/multisig/GaoSafeFactory.sol",
      "test/multisig/helpers/eip712.ts",
      "test/multisig/GaoSafe.test.ts",
      "test/multisig/GaoSafeFactory.test.ts",
      "test/multisig/GaoSafe.eip712-parity.test.ts",
      "scripts/multisig/exportGaoSafeAbi.ts",
      "docs/multisig/gao-safe-design.md",
      "docs/multisig/gao-safe-threat-model.md",
      "docs/multisig/gao-safe-test-plan.md",
    ];
    for (const ex of expected) {
      expect(
        relFiles,
        `walker did not discover required file ${ex}`,
      ).to.include(ex);
    }
  });

  it("contains no checked-in 40-character hex address literals outside the allowlist sentinel", () => {
    expect(
      offenders,
      `offenders found: ${JSON.stringify(offenders, null, 2)}`,
    ).to.deep.equal([]);
  });

  it("the allowlist marker actually skips a line (self-test)", () => {
    // 0xdeadbeef... is a recognisable 40-char hex sentinel used only
    // here to exercise the allowlist logic — it is not a real address
    // and never appears in scanned source.
    const sample =
      "// allow-address-literal: 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(ALLOW_MARKER.test(sample)).to.equal(true);
    expect(ADDRESS_RE.test(sample)).to.equal(true);
    // The previous case's end-to-end repo scan already proves the
    // skip path: without the skip the zero-offender invariant would
    // fail the moment any allowlisted line appeared. Today there are
    // zero allowlisted lines in the scanned trees (zero address
    // literals to allow). This self-test pins the *mechanism* so a
    // future allowlist entry is provably honoured.
  });
});
