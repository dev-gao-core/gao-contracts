# GaoSafe Genesis — Auditor Onboarding

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until an independent smart-contract audit and the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) are satisfied.

This document is the single landing page for an external smart-contract auditor engaging on GaoSafe Genesis. It gives the auditor everything needed to reproduce the build, run the test suite, and find the canonical reference docs.

---

## 1. What is being audited

| Item | Value |
|---|---|
| Product | GaoSafe Genesis — institutional-baseline M-of-N multisign vault |
| Repository | [`dev-gao-core/gao-contracts`](.) |
| Branch | `main` |
| In-scope files | [`contracts/multisig/GaoSafe.sol`](../../contracts/multisig/GaoSafe.sol), [`contracts/multisig/GaoSafeFactory.sol`](../../contracts/multisig/GaoSafeFactory.sol) |
| Out-of-scope code | Everything else under `contracts/` (`GaoDomain*` is reviewed separately) |
| Out-of-scope deps | `node_modules/@openzeppelin/**` (OZ is reviewed independently — pinned to a specific version, see §3) |
| Genesis non-goals | See [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) |
| What this contract is | On-chain Safe-style M-of-N multisig with EOA owners + EIP-712 typed-data signatures |
| What this contract is **NOT** | **NOT** MPC / TSS. No key shares, no DKG, no threshold-signing protocol. Each owner is an independent EOA signing on its own. |

---

## 2. Commit pin and audit target

| Pin | Value |
|---|---|
| Audit target commit | The `main` branch tip at audit engagement time. Auditor must record the exact 40-char SHA in their report cover page. |
| Source pin for the mobile ABI consumer | `gao-contracts@ac14411` (PR #17 — "feat(multisig): add GaoSafe Genesis and factory with tests and ABIs") |
| CI hardening head | `gao-contracts@fe6ee43` (PR #18 — "chore(ci): add contracts-ci workflow + multisig no-address-literals guardrail") |
| Property-test + advisory-Slither head | `gao-contracts@a9e98a5` (PR #19 — "test(multisig): add property tests and advisory Slither workflow") |
| Mobile-side consumer | `gaokey-mobile/src/multisig/` at the matching ABI commit ([`gaokey-mobile/src/multisig/abis.ts`](../../../gaokey-mobile/src/multisig/abis.ts)) |

The mobile consumer pins the ABI by commit AND by SHA-256 of the ABI JSON. The current pin is byte-identical to the local working copy — see [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) for the proof.

---

## 3. Toolchain pin

| Item | Value |
|---|---|
| Solidity | `0.8.24` (locked in [`hardhat.config.ts`](../../hardhat.config.ts)) |
| Optimizer | enabled, `runs: 200` |
| Metadata `bytecodeHash` | `ipfs` (explorer-verifiable) |
| OpenZeppelin Contracts | declared `^5.0.2`, locked at `5.6.1` in `package-lock.json` — see §10 known item |
| Hardhat | `^2.22.0` |
| ethers | `^6.13.0` |
| Node | 20 LTS (the CI runner uses `actions/setup-node@v4` with LTS) |

The toolchain pin is the same pin used by `gaokey-mobile/src/multisig/ProposalBuilder.ts` for off-chain digest parity. Mismatching versions silently invalidate the JS↔contract digest parity claim.

---

## 4. Reproduce locally

```bash
cd gao-contracts
npm ci
npx hardhat compile          # full Solidity build via solc 0.8.24, optimizer 200 runs
npx hardhat test \
  test/multisig/GaoSafe.test.ts \
  test/multisig/GaoSafeFactory.test.ts \
  test/multisig/GaoSafe.eip712-parity.test.ts \
  test/multisig/GaoSafe.invariants.test.ts \
  test/multisig/GaoSafe.fuzz-signatures.test.ts \
  test/multisig/GaoSafeFactory.fuzz-create2.test.ts \
  test/guardrails/multisig-no-address-literals.test.ts
```

Expected at audit-target commit on `main`:

- `npx hardhat compile` → `Nothing to compile` after first build (or full build on a fresh checkout); no errors, no warnings on the multisig files.
- `npx hardhat test ...` → 73 passing (70 multisig + 3 guardrail).

No network calls. No funds. No mainnet RPC. No `.env` needed for compile / test — they execute against Hardhat's in-memory chain (chainId 31337).

---

## 5. Reference docs (canonical)

Read these before starting in this order:

1. [gao-safe-design.md](./gao-safe-design.md) — full architecture, lifecycle, EIP-712 layout, what is in vs out of Genesis scope.
2. [gao-safe-threat-model.md](./gao-safe-threat-model.md) — STRIDE per primitive, asset table, adversary model.
3. [gao-safe-invariants.md](./gao-safe-invariants.md) — invariants matrix (I1–I10), each with its property test and seed protocol.
4. [gao-safe-test-plan.md](./gao-safe-test-plan.md) — 56 point cases + 14 property cases.
5. [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) — Slither posture and config rationale.
6. [gao-safe-ci-hardening.md](./gao-safe-ci-hardening.md) — `contracts-ci.yml` + address-literals guardrail.
7. [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) — explicit non-goals + currently-tracked known items.
8. [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) — ABI sha256 pin + JS-side digest parity.
9. [audit-readiness-checklist.md](./audit-readiness-checklist.md) — operator-facing readiness checklist.

---

## 6. Scope of the contract — quick map

| Primitive | Location | One-liner |
|---|---|---|
| Owner-set & threshold storage | [`GaoSafe.sol:80-86`](../../contracts/multisig/GaoSafe.sol#L80) | `_owners[]`, `isOwner` map, `threshold`, `nonce`, `_initialized` |
| EIP-712 domain (clone-safe, manual) | [`GaoSafe.sol:205-215`](../../contracts/multisig/GaoSafe.sol#L205) | Computed every call from `block.chainid` + `address(this)` |
| `TX_TYPEHASH` | [`GaoSafe.sol:73-75`](../../contracts/multisig/GaoSafe.sol#L73) | `GaoMultisigTx(uint256 chainId,address vault,uint256 nonce,bytes32 targetsHash,bytes32 valuesHash,bytes32 dataHash,uint256 expiry)` |
| `hashTx` digest builder | [`GaoSafe.sol:233-263`](../../contracts/multisig/GaoSafe.sol#L233) | All three sub-hashes + struct-hash + typed-data wrap |
| `setup` (one-shot per clone) | [`GaoSafe.sol:169-187`](../../contracts/multisig/GaoSafe.sol#L169) | Owner & threshold validation; emits `Setup` |
| `execTransaction` | [`GaoSafe.sol:280-334`](../../contracts/multisig/GaoSafe.sol#L280) | NotSetup guard → length parity → expiry → bundle-size → digest → verify → nonce++ → inner calls |
| `_verifySignatures` | [`GaoSafe.sol:340-356`](../../contracts/multisig/GaoSafe.sol#L340) | Strict-ascending owner-only recovery; `tryRecover` error → `NotAnOwner` |
| `_executeCalls` | [`GaoSafe.sol:363-374`](../../contracts/multisig/GaoSafe.sol#L363) | All-or-nothing inner-call loop |
| Owner mutators (`onlySelf`) | [`GaoSafe.sol:390-461`](../../contracts/multisig/GaoSafe.sol#L390) | `addOwner` / `removeOwner` / `replaceOwner` / `changeThreshold` |
| Funds ingress | [`GaoSafe.sol:478-480`](../../contracts/multisig/GaoSafe.sol#L478) | `receive()` with bare-implementation refusal via `_IMPLEMENTATION_SELF` |
| Factory `createVault` | [`GaoSafeFactory.sol:63-72`](../../contracts/multisig/GaoSafeFactory.sol#L63) | Deployer-bound salt + EIP-1167 clone + setup + event |
| Factory `computeVaultAddress` | [`GaoSafeFactory.sol:78-85`](../../contracts/multisig/GaoSafeFactory.sol#L78) | Pure read for pre-deploy address derivation |

---

## 7. Bytecode hash, deployed addresses, audit report cross-link

These three items are intentionally **TBD until audit finishes** — they are operator-only artifacts gated on audit sign-off and the production-readiness gate:

| Item | When pinned |
|---|---|
| Implementation singleton runtime-bytecode hash (per chosen solc + optimizer pin) | Pinned in the deployment runbook PR after the auditor signs off and the runbook lands |
| Per-chain factory deployed addresses | Added one-by-one to `gaokey-mobile/src/multisig/config.ts` via single-purpose PRs, each carrying audit report + bytecode hash + reviewer + security sign-off |
| Audit report reference | Linked from `gao-safe-design.md` §10 in the same PR that lands the report |

The auditor does NOT need a deployed address to perform the review. Genesis is a **static-bytecode** review.

---

## 8. What the operator expects from the report

Per the mobile-side production-readiness gate ([`gaokey-mobile/docs/multisig/production-readiness-gate.md`](../../../gaokey-mobile/docs/multisig/production-readiness-gate.md) §1):

| Deliverable | Format |
|---|---|
| Findings list | One row per finding: ID, severity (Critical / High / Medium / Low / Informational), location (file:line), description, suggested remediation, recommendation accepted-or-rejected (operator fills the last column post-review) |
| Severity definitions | Auditor-defined; please include the definitions used so the operator can normalise across firms |
| Methodology | Manual review + tools used (slither version, mythril version, fuzz seed, fuzz time budget, etc.) |
| Cross-references | Link each finding to the relevant section of [gao-safe-threat-model.md](./gao-safe-threat-model.md) or [gao-safe-invariants.md](./gao-safe-invariants.md) if it overlaps |
| Acceptance criteria for re-review | Auditor confirms remediation of every critical / high finding in writing |

---

## 9. Reporting channel and pacing

- The operator is responsible for engagement-letter scope. The auditor's day-to-day questions should go to a single named operator contact via the engagement-letter channel.
- The repo's GitHub Issues are NOT used as the audit reporting channel. Use the firm's standard delivery format.
- A pre-engagement Q&A session is welcomed. Schedule via the operator contact.

---

## 10. Known items to flag during onboarding

| Item | Severity hint | Note |
|---|---|---|
| OZ caret pin `^5.0.2` resolves to `5.6.1` in `package-lock.json`. | Low — likely acceptance, may suggest tighter pin | Auditor may suggest pinning to `5.6.1` exact (or whichever pin lands). Operator decision is recorded in the audit-readiness-checklist. |
| `slither.config.json` excludes `naming-convention` and `solc-version` detectors. | Informational | Documented rationale in [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) §1. |
| Slither workflow is advisory only (continue-on-error). | Informational | Documented in [gao-safe-ci-hardening.md](./gao-safe-ci-hardening.md). |
| No deploy script for `GaoSafeFactory` is shipped in this repo. | Out-of-scope by design | Deployment runbook lands in a separate, operator-only PR post-audit. |
| `_IMPLEMENTATION_SELF` immutable + `receive()` bare-impl refusal is intentionally subtle. | Worth a careful read | Pinned by `GaoSafe.test.ts` #36 and #39. See [gao-safe-design.md](./gao-safe-design.md) §3 for the rationale. |
| `tryRecover` rejection mapped to `NotAnOwner`. | Worth a careful read | Distinct from a recovered-but-not-an-owner case. Both revert with the same selector, by design — a digest-mutation oracle is the only signal exposed externally. |

See [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) for the full list.

---

## 11. Quick sanity assertions an auditor can run in 60 seconds

```bash
# 1. Verify the ABI is byte-identical to what mobile pins.
shasum -a 256 abis/multisig/GaoSafe.json
# expected: ee21f7af040b2e579c7e8c2985d2e16cf51b6b84cdbd72116eda994ca13549d1

shasum -a 256 abis/multisig/GaoSafeFactory.json
# expected: 1af102026245f187025bc716fce033f25967fc8b8b2f6fc99886573240d8a90f

# 2. Verify no address literal slipped in.
npx hardhat test test/guardrails/multisig-no-address-literals.test.ts
# expected: 3 passing

# 3. Verify the full multisig suite is green.
npx hardhat test \
  test/multisig/GaoSafe.test.ts \
  test/multisig/GaoSafeFactory.test.ts \
  test/multisig/GaoSafe.eip712-parity.test.ts \
  test/multisig/GaoSafe.invariants.test.ts \
  test/multisig/GaoSafe.fuzz-signatures.test.ts \
  test/multisig/GaoSafeFactory.fuzz-create2.test.ts
# expected: 70 passing
```

If any of these three assertions fails on the audit-target commit, the operator must be notified before the audit begins.
