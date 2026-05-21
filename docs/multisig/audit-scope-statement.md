# GaoSafe Genesis — Audit Scope Statement

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until an independent smart-contract audit and the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) are satisfied.

This document is the formal scope statement for the GaoSafe Genesis external smart-contract audit engagement. It is suitable for direct quotation in an engagement letter or statement of work.

---

## 1. Engagement parties

| Party | Role |
|---|---|
| Sponsor | dev-gao-core (operator) — repository owner, audit-target commit signer, audit findings triage owner |
| Auditor | TBD — chosen audit firm under separate engagement letter |
| Communication channel | Engagement-letter delivery channel between sponsor's single named contact and the auditor's lead reviewer |

---

## 2. Audit subject

| Item | Value |
|---|---|
| Repository | `dev-gao-core/gao-contracts` (GitHub) |
| Audit target branch | `main` |
| Audit target commit SHA | `22c6bce9b5552685139315eaa90e7230cfdc016a` |
| Audit target tree URL | https://github.com/dev-gao-core/gao-contracts/tree/22c6bce9b5552685139315eaa90e7230cfdc016a |
| Audit target tag | `audit-target-MS-P2` (annotated, immovable for the audit window) |
| Audit-prep PR | [#20](https://github.com/dev-gao-core/gao-contracts/pull/20) — prepared the audit package (commit `bf48bdf`). |
| Handoff PR | [#21](https://github.com/dev-gao-core/gao-contracts/pull/21) — added external auditor handoff docs. Merge of PR #21 IS the audit target. |
| Solidity / ABI changes between PR #17 and audit target | None. PR #18 added CI infra; PR #19 added property tests + advisory Slither; PR #20 + #21 are docs-only. The in-scope Solidity files are byte-identical to PR #17 (`ac14411`). |
| Solidity compiler | 0.8.24, optimizer enabled, runs 200, metadata `bytecodeHash: ipfs` |

---

## 3. In scope

The audit covers the following Solidity files at the audit target commit:

| File | Path |
|---|---|
| `GaoSafe.sol` | [`contracts/multisig/GaoSafe.sol`](../../contracts/multisig/GaoSafe.sol) |
| `GaoSafeFactory.sol` | [`contracts/multisig/GaoSafeFactory.sol`](../../contracts/multisig/GaoSafeFactory.sol) |

The audit additionally covers the supporting artefacts produced from these files:

| Artefact | Path |
|---|---|
| `GaoSafe.json` ABI | [`abis/multisig/GaoSafe.json`](../../abis/multisig/GaoSafe.json) — SHA-256 `ee21f7af040b2e579c7e8c2985d2e16cf51b6b84cdbd72116eda994ca13549d1` |
| `GaoSafeFactory.json` ABI | [`abis/multisig/GaoSafeFactory.json`](../../abis/multisig/GaoSafeFactory.json) — SHA-256 `1af102026245f187025bc716fce033f25967fc8b8b2f6fc99886573240d8a90f` |

The audit additionally covers the test suite that pins the security primitives of the in-scope files:

| Suite | Path |
|---|---|
| Vault point cases | `test/multisig/GaoSafe.test.ts` |
| Factory point cases | `test/multisig/GaoSafeFactory.test.ts` |
| EIP-712 parity | `test/multisig/GaoSafe.eip712-parity.test.ts` |
| Vault invariants | `test/multisig/GaoSafe.invariants.test.ts` |
| Signature-bundle fuzz | `test/multisig/GaoSafe.fuzz-signatures.test.ts` |
| Factory CREATE2 fuzz | `test/multisig/GaoSafeFactory.fuzz-create2.test.ts` |
| Address-literals guardrail | `test/guardrails/multisig-no-address-literals.test.ts` |

---

## 4. Out of scope

The following are explicitly NOT in scope for this engagement:

| Out-of-scope area | Why |
|---|---|
| `contracts/GaoDomain*.sol` | Separate product line, separate audit track |
| `node_modules/@openzeppelin/**` | OZ is reviewed independently. The audit may take OZ-imported semantics as given. Operator-side OZ version disposition is recorded in [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.1. |
| `contracts/test/**` | Solidity-only test mocks (e.g. `MockERC20`); not in any production code path |
| Non-Solidity infrastructure | `.github/workflows/`, `slither.config.json`, `hardhat.config.ts` — auditor MAY review for context but findings on these are advisory |
| Mobile application (`gaokey-mobile`) | Separate product, separate review track; ABI compatibility documented in [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) but mobile internals are out of scope here |
| Deployment scripts | None exist in this repo. The deployment runbook lands as a separate operator-only PR post-audit. |
| Audited deployed bytecode hash | Not yet pinned. Pinned only when the runbook PR lands. |
| Network operations | RPC providers, monitoring stack, indexer, kill-switch tooling — operator concerns, not contract concerns |
| Operational treasury controls | Threshold sizing rules, key-custody procedures, signer device hygiene |
| MPC / TSS layers | Not part of Genesis. A future MPC layer participating as a single owner is a **separate project** with its own design, audit, and engagement. |

---

## 5. Audit-scope boundaries (explicit non-goals)

Genesis deliberately excludes the following capabilities. Auditor SHOULD confirm in the report that these absences are acceptable for the stated security target. Full rationale in [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §1.

| Excluded capability | Status in Genesis |
|---|---|
| Upgradeability | Out — every vault is an immutable clone of an immutable singleton |
| Modules / plugins | Out — no hook surface |
| ERC-1271 execution path | Out — verifier accepts only EOA ECDSA signatures |
| Post-quantum signature verification | Out — no PQ verifier, no fake verifier |
| Best-effort batch execution | Out — all-or-nothing only |
| Timelock | Out — separate policy-layer concern |
| Spending limits | Out — separate policy-layer concern |
| Allowlist / denylist guards | Out — separate policy-layer concern |
| Gas sponsorship / relayers / paymasters | Out — submitter pays gas |
| MEV-resistant submit ordering | Out — operational concern |
| MPC / TSS / threshold signing | Out — Genesis is classic on-chain multisig with EOA owners |
| On-chain recovery / social keys | Out — recovery is via multisig `replaceOwner` proposals |

---

## 6. Audit objectives

The audit MUST evaluate the in-scope files against the following objectives:

| # | Objective |
|---|---|
| O1 | Confirm the contract implements an M-of-N multisig vault with no non-owner authority paths. |
| O2 | Confirm the EIP-712 typed-data digest is byte-equal to ethers `TypedDataEncoder.hash` for every supported proposal flavour, AND is clone-safe (different clones on the same chain produce different domain separators). |
| O3 | Confirm signature bundle handling rejects unsorted, duplicated, malformed, non-owner, and insufficient bundles. |
| O4 | Confirm cross-chain replay is rejected (chainId in BOTH domain separator AND struct body). |
| O5 | Confirm cross-vault replay is rejected (`address(this)` in BOTH domain separator AND struct body). |
| O6 | Confirm nonce monotonicity, replay rejection, and re-entrancy-safe ordering (nonce++ before inner calls). |
| O7 | Confirm one-shot init lock on both implementation singleton AND each clone. |
| O8 | Confirm `onlySelf` enforcement on owner-set mutators. |
| O9 | Confirm factory CREATE2 determinism AND deployer-binding (same `clientSalt` from two deployers produces different addresses). |
| O10 | Confirm bare-implementation ETH-ingress refusal AND clone ETH-ingress acceptance. |
| O11 | Confirm NotSetup guard catches both bare implementation AND manually-deployed uninitialised clones. |
| O12 | Confirm absence of admin / owner-override / upgrade hooks. |

For each objective, the report SHOULD cite either the pinning test that already enforces it, OR a recommended additional test if the auditor believes coverage is insufficient.

---

## 7. Deliverables

Per the engagement letter, the auditor delivers:

| # | Deliverable |
|---|---|
| D1 | Audit report (PDF). Cover page cites the audit-target commit SHA. |
| D2 | Findings list (table). One row per finding: ID, severity, file:line, description, suggested remediation. |
| D3 | Methodology section. Manual review scope, tools used and their versions, fuzz/property test seeds if used. |
| D4 | Severity definitions used by the auditor (operator's internal definitions are documented in [external-audit-handoff.md](./external-audit-handoff.md) §6.1 for reference). |
| D5 | Confirmation that every Critical and High finding has been remediated, after the operator's remediation PRs land (re-review). |

---

## 8. Sponsor commitments

The sponsor commits to:

| # | Commitment |
|---|---|
| S1 | Hold the audit-target commit (`22c6bce9b5552685139315eaa90e7230cfdc016a`, tag `audit-target-MS-P2`) frozen on `main` for the duration of the audit window — no force-push, no rebase, no rewrite. See [pre-audit-freeze.md](./pre-audit-freeze.md). |
| S2 | Triage all findings within the timeline agreed in the engagement letter. |
| S3 | Submit remediation PRs per the rules in [external-audit-handoff.md](./external-audit-handoff.md) §6.2. |
| S4 | NOT deploy GaoSafe / GaoSafeFactory to mainnet before audit closure. |
| S5 | NOT enable the mobile-side multisig feature flag before the consuming-app production-readiness gate is satisfied. |
| S6 | NOT change the OZ pin, Solidity version, optimizer settings, or any in-scope file during the audit window (with the exception of docs under `docs/multisig/`, which may be updated to reflect auditor clarifications — see [pre-audit-freeze.md](./pre-audit-freeze.md) §3). |

---

## 9. Material change protocol

If the sponsor needs to make a material change to an in-scope file during the audit window:

1. The change is described to the auditor in writing **before** it lands.
2. The auditor acknowledges receipt and either (a) absorbs the change into the same engagement, or (b) declares it a re-engagement scope change with a new audit-target commit.
3. The sponsor does NOT land the change without the auditor's acknowledgement.

A docs-only change in `docs/multisig/` is NOT a material change and does NOT require pre-notification, except when the change updates a security claim the auditor is actively evaluating.

---

## 10. Acceptance

This scope statement is accepted when both parties sign the engagement letter that references this document by its commit SHA on `gao-contracts/main`. The commit SHA pins the exact scope; subsequent edits to this document do not retroactively change the engagement scope.
