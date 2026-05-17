# GaoSafe Genesis — CI Hardening

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. This document records the post-merge CI hardening that was added immediately after PR #17 was merged into `main`. The hardening is **CI infrastructure only**: no contract source, no ABI, and no consuming-app integration is changed.

---

## 1. Why this hardening exists

PR #17 merged `contracts/multisig/GaoSafe.sol` + `contracts/multisig/GaoSafeFactory.sol` + the 56-case test matrix + the two ABI JSON outputs. CodeQL static analysis (managed by GitHub's default code-scanning, not an in-repo workflow) ran green on that PR, but **the repo had no in-repo GitHub Actions workflow that compiled Solidity or ran `hardhat test`**. Local Hardhat runs were the only gate.

Before the gaokey-mobile consumer wires in the Genesis ABI, two CI-floor improvements are appropriate:

1. **A first-party `contracts-ci.yml` workflow** that runs `npx hardhat compile` and `npx hardhat test` on every PR targeting `main` and on every push to `main`. This catches anything that would only surface from a Hardhat compile or test run — stack-too-deep regressions, broken guardrails, regressions in the 235+ -case suite, dependency updates that break the build.
2. **A contracts-side `multisig-no-address-literals` guardrail** mirroring the gaokey-mobile sibling guardrail. Both repos now enforce the same rule: no GaoSafe / GaoSafeFactory address may appear in source / tests / scripts / docs outside an explicit, reviewer-signed-off allowlist sentinel.

Neither change touches a contract, an ABI, the package.json, the Hardhat config, or any consuming-app file. The PR is strictly additive CI infrastructure.

---

## 2. `.github/workflows/contracts-ci.yml`

### 2.1 Triggers

- `pull_request` to `main` — pre-merge gate.
- `push` to `main` — post-merge tip stays green and direct pushes are also caught.

### 2.2 Permissions

```yaml
permissions:
  contents: read
```

The workflow cannot write to the repo, cannot push tags, cannot create releases, cannot publish packages. It can only read source.

### 2.3 Concurrency

```yaml
concurrency:
  group: contracts-ci-${{ github.ref }}
  cancel-in-progress: true
```

A new commit on the same ref cancels any in-flight run for that ref. Saves CI cost and keeps the latest commit as the source of truth.

### 2.4 Steps

| Step | Command | Notes |
|---|---|---|
| Checkout | `actions/checkout@v4` | First-party, pinned to major-version tag. |
| Setup Node.js | `actions/setup-node@v4` with `node-version: '20'`, `cache: 'npm'` | Single Node 20; matches local-dev baseline. Future hardening PR can introduce a matrix. |
| Install | `npm ci` | Strict lockfile install. Deterministic. |
| Compile | `npx hardhat compile` | Surfaces compile failures with clear attribution before tests run. |
| Test | `npx hardhat test` | Full suite, no `--bail` — every case reports pass/fail so triage is comprehensive. |

### 2.5 What the workflow does NOT do

- ❌ No deploy. No `npx hardhat run scripts/...`.
- ❌ No `hardhat verify`. No Basescan / Etherscan upload.
- ❌ No `--network` flag. The only network used is hardhat's in-memory chain (chainId 31337).
- ❌ No `secrets.*` reference. The workflow consumes zero secrets.
- ❌ No `process.env` reads beyond what hardhat itself does internally for the in-memory network.
- ❌ No `npx ts-node scripts/multisig/exportGaoSafeAbi.ts` — ABIs are committed alongside the contracts; CI does not re-export.
- ❌ No coverage, fuzz, Slither, or Mythril runs — explicitly out of scope (see §4).

---

## 3. `test/guardrails/multisig-no-address-literals.test.ts`

### 3.1 What it scans

| Directory | File extensions in scope |
|---|---|
| `contracts/multisig/**` | `.sol` |
| `test/multisig/**` | `.ts`, `.tsx` |
| `scripts/multisig/**` | `.ts`, `.tsx` |
| `docs/multisig/**` | `.md` |

ABI JSON outputs under `abis/multisig/` are intentionally out of scope. ABI JSON is bytecode-derived (function signatures, parameter types, event topics) and contains no 40-character hex address literals by construction.

### 3.2 Rule

A line containing an unmarked 40-character hex literal (`0x[0-9a-fA-F]{40}`, word-bounded) is an offender. Any line containing the case-insensitive marker `allow-address-literal:` is skipped — used only for documented test fixtures or, once the consuming-app production-readiness gate has been met, for a single runbook-sourced factory address per chain in a separate reviewed PR.

### 3.3 Initial state

At commit time, **zero offenders, zero allowlist entries**. The guardrail ships with an empty allowlist because no GaoSafe / GaoSafeFactory address has been deployed anywhere yet.

### 3.4 Why a contracts-side guard is needed

The gaokey-mobile repo already enforces the rule via `gaokey-mobile/src/multisig/__tests__/noAddressLiterals.test.ts`. A contracts-side analogue is necessary because:

- A future deployment runbook could land an address in `docs/multisig/` or `scripts/multisig/` first (the contracts repo is the authoritative deployment record).
- Without the contracts-side guard, a stale or test address in a markdown doc or a one-off script could pass review and then propagate to the mobile consumer via cut-and-paste.

Both repos now enforce identical semantics. The address registry that the mobile app actually consumes (`gaokey-mobile/src/multisig/config.ts`) remains empty until the consuming-app production-readiness gate is satisfied for a target chain.

---

## 4. Out of scope for this PR

Each item below is a candidate for a separate hardening PR, **never** a same-PR add. Bundling them would inflate review surface without a clear failure mode driving the inclusion.

- **Node-version matrix.** PR #18 ships single Node 20. A 20 + 22 matrix is a small follow-up.
- **Exact-SHA action pinning.** PR #18 uses `actions/checkout@v4` and `actions/setup-node@v4`. Exact-SHA pinning is a separate supply-chain-hardening PR.
- **Coverage reporting.** `solidity-coverage` is a single-dependency add but expands surface — out of scope.
- **Gas reporter.** Deferred to the post-audit hardening pass.
- **Static analysis (Slither / Mythril).** Each is a non-trivial CI integration with its own configuration surface — separately scoped.
- **Fuzz harness (Echidna / Foundry fuzz).** Same.
- **`.nvmrc` / `engines` pin.** Worth doing; intentionally not bundled with this PR.
- **CodeQL workflow file.** GitHub's managed default CodeQL is currently doing the JS/TS static analysis; making it an in-repo workflow is orthogonal.

---

## 5. Verification

Local commands run before commit (all green on the branch head):

```
npx hardhat compile                                                       # clean
npx hardhat test test/guardrails/multisig-no-address-literals.test.ts     # 3 cases pass
npx hardhat test                                                          # full suite — 238 expected passing
```

Expected CI outcome on every PR targeting `main` and on every push to `main`: 238 passing (179 pre-existing + 56 multisig + 3 new guardrail cases).

---

## 6. Non-goals for the workflow

- **Not a release pipeline.** No publishing, no tagging, no version bumping.
- **Not a deployment pipeline.** No mainnet, no testnet, no broadcast of any kind.
- **Not a coverage gate.** Coverage thresholds and per-file matrices are deliberately deferred.
- **Not a secrets carrier.** The workflow has zero secrets configured and the workflow file declares no `env:` block populated from `secrets.*`.

The workflow's sole purpose is to assert that the repo's Hardhat compile and test invariants hold on every change that touches `main`.
