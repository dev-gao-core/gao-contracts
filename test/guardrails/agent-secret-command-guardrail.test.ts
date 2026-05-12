// Agent secret-handling guardrails — enforced via static checks
// (hardhat/mocha + chai). Mirrors the vitest version in the
// gao-id-worker repo; the assertion surface is identical.
//
// CI-enforced contracts:
//   1. CLAUDE.md §4 (this repo) carries the BAN list summary.
//   2. docs/security/agent-secret-handling.md exists, non-empty,
//      and carries the canonical BAN-list summary.
//   3. No committed deploy / scripts/ file logs a banned env value.
//   4. No committed evidence doc carries a secret-shaped literal.
//   5. Strict banned literals appear ONLY in the two designated
//      docs + this test file's BANNED_COMMAND_LITERALS constant.

import { expect } from "chai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const SECRET_DOC = join(REPO_ROOT, "docs/security/agent-secret-handling.md");
const GUARDRAIL_SELF = join(__dirname, "agent-secret-command-guardrail.test.ts");

const BANNED_COMMAND_LITERALS: ReadonlyArray<string> = [
  "cat .env",
  "less .env",
  "more .env",
  "head .env",
  "tail .env",
  "hexdump .env",
  "hexdump -C .env",
  "xxd .env",
  "od .env",
  "strings .env",
  "echo $DEPLOYER_PRIVATE_KEY",
  "printenv",
  "set | grep",
  "export | grep",
  "console.log(process.env.DEPLOYER_PRIVATE_KEY)",
  "console.log(JSON.stringify(process.env))",
  "print(os.environ['DEPLOYER_PRIVATE_KEY'])",
  "print(dict(os.environ))",
  "gh secret list",
  "gh secret set",
  "gh secret delete",
  "wrangler secret list",
  "wrangler secret put",
  "wrangler secret delete",
  "aws secretsmanager get-secret-value",
  "gcloud secrets versions access",
];

const SCRIPT_SCAN_PATHS: ReadonlyArray<string> = ["scripts", "tools"];
const EVIDENCE_SCAN_PATHS: ReadonlyArray<string> = [
  "docs/deployments/devtest",
  "docs/deployments/staging",
];

const ALWAYS_SKIP: ReadonlyArray<string> = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "artifacts",
  "cache",
  "typechain-types",
  "deployments", // contains JSON deploy records; not a source-scan target
];

function walk(dir: string, accept: (p: string) => boolean): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (ALWAYS_SKIP.includes(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out = out.concat(walk(p, accept));
    } else if (accept(p)) {
      out.push(p);
    }
  }
  return out;
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stripLineAndBlockComments(s: string): string {
  const noBlocks = s.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function stripMarkdownLineComments(s: string): string {
  // Loop until fixed point so a hostile input containing a
  // partial comment fragment can't survive a single replace
  // pass (CodeQL js/incomplete-multi-character-sanitization).
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/<!--[\s\S]*?-->/g, "");
  } while (cur !== prev);
  return cur;
}

describe("CLAUDE.md §4 — Agent secret-handling", () => {
  const claude = readSafe(CLAUDE_MD);

  it("CLAUDE.md exists and is non-empty", () => {
    expect(claude).to.not.equal(null);
    expect((claude ?? "").length).to.be.greaterThan(0);
  });

  it("CLAUDE.md has a section header naming agent secret-handling", () => {
    expect(claude ?? "").to.match(/Agent secret-handling/i);
  });

  for (const lit of BANNED_COMMAND_LITERALS) {
    it(`CLAUDE.md mentions banned literal: ${JSON.stringify(lit)}`, () => {
      expect(
        (claude ?? "").includes(lit),
        `expected CLAUDE.md to list banned literal ${JSON.stringify(lit)}`,
      ).to.equal(true);
    });
  }
});

describe("docs/security/agent-secret-handling.md", () => {
  const doc = readSafe(SECRET_DOC);

  it("exists and is non-empty", () => {
    expect(doc).to.not.equal(null);
    expect((doc ?? "").length).to.be.greaterThan(1000);
  });

  it("declares a BAN list", () => {
    expect(doc ?? "").to.match(/BAN list/i);
  });

  it("declares an ALLOW list with the canonical name-only command", () => {
    expect(doc ?? "").to.match(/ALLOW list/i);
    expect(doc ?? "").to.contain(`readFileSync('.env','utf8')`);
    expect(doc ?? "").to.contain(`(process.env[k] ? 'SET' : 'MISSING')`);
  });

  it("declares the production rule for keys (no .env, use HSM/KMS/MPC/vendor)", () => {
    expect(doc ?? "").to.match(/HSM/);
    expect(doc ?? "").to.match(/KMS/);
    expect(doc ?? "").to.match(/MPC/);
  });

  it("declares an incident-response sequence", () => {
    expect(doc ?? "").to.match(/incident/i);
    expect(doc ?? "").to.match(/rotation/i);
  });
});

describe("scripts don't log banned env values", () => {
  const LOGGED_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    /console\.(log|error|warn|info)\s*\([^)]*process\.env\.[A-Z0-9_]*(?:PRIVATE|SECRET|MNEMONIC|RPC_URL|API_KEY|HMAC|PEM|SEED)[A-Z0-9_]*[^)]*\)/,
    /process\.stdout\.write\s*\([^)]*process\.env\.[A-Z0-9_]*(?:PRIVATE|SECRET|MNEMONIC|RPC_URL|API_KEY|HMAC|PEM|SEED)/,
    /console\.(log|error|warn|info)\s*\([^)]*JSON\.stringify\s*\(\s*process\.env\s*\)/,
    /console\.(log|error|warn|info)\s*\(\s*process\.env\s*\)/,
  ];

  for (const scanPath of SCRIPT_SCAN_PATHS) {
    const root = join(REPO_ROOT, scanPath);
    const files = walk(root, (p) => /\.(ts|js|cjs|mjs|sh)$/.test(p));
    if (files.length === 0) continue;

    for (const f of files) {
      const rel = relative(REPO_ROOT, f);
      it(`script ${rel} does not log a banned env value`, () => {
        const raw = readSafe(f);
        expect(raw).to.not.equal(null);
        const stripped = stripLineAndBlockComments(raw ?? "");
        for (const pat of LOGGED_SECRET_PATTERNS) {
          expect(
            pat.test(stripped),
            `${rel} matches banned log pattern ${pat}`,
          ).to.equal(false);
        }
      });
    }
  }
});

describe("evidence docs do not carry secret-shaped literals", () => {
  const SECRET_HEX_PATTERNS: ReadonlyArray<RegExp> = [
    /(PRIVATE_KEY|MNEMONIC|SEED PHRASE)[^a-zA-Z][^\n]{0,80}0x[0-9a-fA-F]{64}/i,
    /BEGIN [A-Z ]*PRIVATE KEY/,
    /[?&]apiKey=[A-Za-z0-9_-]{16,}/i,
    /\.alchemyapi\.io\/v2\/[A-Za-z0-9_-]{8,}/i,
    /\.infura\.io\/v3\/[A-Za-z0-9_-]{8,}/i,
    /quiknode\.pro\/[A-Za-z0-9_-]{8,}/i,
  ];

  const allFiles: string[] = [];
  for (const scanPath of EVIDENCE_SCAN_PATHS) {
    const root = join(REPO_ROOT, scanPath);
    const files = walk(root, (p) => p.endsWith(".md"));
    for (const f of files) allFiles.push(f);
  }

  if (allFiles.length === 0) {
    it("no evidence-doc directory present — nothing to scan (OK)", () => {
      expect(allFiles).to.deep.equal([]);
    });
  } else {
    for (const f of allFiles) {
      const rel = relative(REPO_ROOT, f);
      it(`evidence ${rel} does not carry a secret-shaped literal`, () => {
        const raw = readSafe(f);
        expect(raw).to.not.equal(null);
        const stripped = stripMarkdownLineComments(raw ?? "");
        for (const pat of SECRET_HEX_PATTERNS) {
          expect(
            pat.test(stripped),
            `${rel} matches secret-shaped pattern ${pat}`,
          ).to.equal(false);
        }
      });
    }
  }
});

describe("banned-command literals do not leak into unrelated source", () => {
  const ALLOWED_OCCURRENCE_PATHS: ReadonlyArray<string> = [
    relative(REPO_ROOT, CLAUDE_MD),
    relative(REPO_ROOT, SECRET_DOC),
    relative(REPO_ROOT, GUARDRAIL_SELF),
  ];

  const STRICT_OCCURRENCE_LITERALS: ReadonlyArray<string> = [
    "console.log(process.env.DEPLOYER_PRIVATE_KEY)",
    "console.log(JSON.stringify(process.env))",
    "hexdump -C .env",
  ];

  const SOURCE_ROOTS = ["contracts", "scripts", "tools", "test", "docs"];

  for (const lit of STRICT_OCCURRENCE_LITERALS) {
    it(`literal ${JSON.stringify(lit)} only appears in designated docs/test`, () => {
      const offenders: string[] = [];
      for (const r of SOURCE_ROOTS) {
        const files = walk(join(REPO_ROOT, r), (p) =>
          /\.(ts|js|cjs|mjs|sh|md|sol)$/.test(p),
        );
        for (const f of files) {
          const rel = relative(REPO_ROOT, f);
          if (ALLOWED_OCCURRENCE_PATHS.includes(rel)) continue;
          const raw = readSafe(f);
          if (raw && raw.includes(lit)) {
            offenders.push(rel);
          }
        }
      }
      expect(
        offenders,
        `literal leaked into: ${offenders.join(", ")}`,
      ).to.deep.equal([]);
    });
  }
});
