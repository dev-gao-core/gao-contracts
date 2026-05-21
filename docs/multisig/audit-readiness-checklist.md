# GaoSafe Genesis — Audit Readiness Checklist

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until every item on this checklist is satisfied and the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is signed off.

This document is the operator-facing checklist that gates the engagement of an external smart-contract auditor on GaoSafe Genesis. It is paired with — but distinct from — the consuming-app production-readiness gate. This checklist gates the **audit start**; the consuming-app gate gates the **mainnet enablement**.

A row is `✅ Satisfied` only when its sign-off column has a name. Anything else means the row is still open.

---

## 0. Engagement context (operator fills first)

| Item | Required artifact |
|---|---|
| 0.1 Engagement letter | Signed engagement letter with the chosen audit firm. Scope: `contracts/multisig/GaoSafe.sol` + `contracts/multisig/GaoSafeFactory.sol` at a specific commit. |
| 0.2 Auditor selection | Firm has published prior work on EVM multisig / vault / smart-account contracts. |
| 0.3 Audit target commit | The exact 40-character SHA on `gao-contracts/main` that the auditor will review. Recorded in the engagement letter AND in the audit report cover page. |
| 0.4 Reporting channel | Single named operator contact + engagement-letter delivery channel. |

Sign-off: operator lead.

---

## 1. Source-of-truth and docs

| Row | Required state | Reference |
|---|---|---|
| 1.1 `contracts/multisig/GaoSafe.sol` exists and compiles. | ✅ Compiled by `npx hardhat compile`; lives at the audit-target commit. | [`GaoSafe.sol`](../../contracts/multisig/GaoSafe.sol) |
| 1.2 `contracts/multisig/GaoSafeFactory.sol` exists and compiles. | ✅ Same as above. | [`GaoSafeFactory.sol`](../../contracts/multisig/GaoSafeFactory.sol) |
| 1.3 Architecture doc exists and matches current source. | ✅ | [`gao-safe-design.md`](./gao-safe-design.md) |
| 1.4 Threat model exists and matches current source. | ✅ | [`gao-safe-threat-model.md`](./gao-safe-threat-model.md) |
| 1.5 Invariants matrix exists and matches current tests. | ✅ | [`gao-safe-invariants.md`](./gao-safe-invariants.md) |
| 1.6 Test plan exists and matches current tests. | ✅ | [`gao-safe-test-plan.md`](./gao-safe-test-plan.md) |
| 1.7 Static-analysis posture documented. | ✅ | [`gao-safe-static-analysis.md`](./gao-safe-static-analysis.md) |
| 1.8 CI hardening documented. | ✅ | [`gao-safe-ci-hardening.md`](./gao-safe-ci-hardening.md) |
| 1.9 Known issues + non-goals consolidated. | ✅ (this audit-prep PR) | [`known-issues-and-nongoals.md`](./known-issues-and-nongoals.md) |
| 1.10 Mobile ABI compatibility documented. | ✅ (this audit-prep PR) | [`mobile-abi-compatibility.md`](./mobile-abi-compatibility.md) |
| 1.11 Auditor onboarding doc exists. | ✅ (this audit-prep PR) | [`auditor-onboarding.md`](./auditor-onboarding.md) |

Sign-off: engineering lead.

---

## 2. Test coverage

| Row | Required state | Reference |
|---|---|---|
| 2.1 `GaoSafe.test.ts` 39 point cases passing on audit-target commit. | ✅ 39 / 39 | `npx hardhat test test/multisig/GaoSafe.test.ts` |
| 2.2 `GaoSafeFactory.test.ts` 10 cases passing. | ✅ 10 / 10 | `npx hardhat test test/multisig/GaoSafeFactory.test.ts` |
| 2.3 `GaoSafe.eip712-parity.test.ts` 7 cases passing. | ✅ 7 / 7 | `npx hardhat test test/multisig/GaoSafe.eip712-parity.test.ts` |
| 2.4 `GaoSafe.invariants.test.ts` property suite passing. | ✅ All I-rows green | `npx hardhat test test/multisig/GaoSafe.invariants.test.ts` |
| 2.5 `GaoSafe.fuzz-signatures.test.ts` property suite passing. | ✅ I8a–I8d green | `npx hardhat test test/multisig/GaoSafe.fuzz-signatures.test.ts` |
| 2.6 `GaoSafeFactory.fuzz-create2.test.ts` property suite passing. | ✅ I9a–I9b green | `npx hardhat test test/multisig/GaoSafeFactory.fuzz-create2.test.ts` |
| 2.7 Address-literals guardrail passing. | ✅ 3 / 3 | `npx hardhat test test/guardrails/multisig-no-address-literals.test.ts` |
| 2.8 Total multisig + guardrail: 73 passing. | ✅ | Combined run, see §2 of [`auditor-onboarding.md`](./auditor-onboarding.md) |

Sign-off: engineering lead.

---

## 3. Static analysis

| Row | Required state | Reference |
|---|---|---|
| 3.1 Slither workflow exists. | ✅ | [`.github/workflows/contracts-slither.yml`](../../.github/workflows/contracts-slither.yml) |
| 3.2 Slither config exists and scopes to `contracts/multisig/`. | ✅ | [`slither.config.json`](../../slither.config.json) |
| 3.3 Slither version pinned. | ✅ `slither-analyzer==0.10.4` |
| 3.4 Slither workflow result on the audit-target commit. | Auditor reviews the latest `slither-report` artifact uploaded by the workflow. | Workflow run history on `main` |
| 3.5 Operator decision on Slither escalation to required check. | Recorded here when made. Currently advisory only. | Sign-off below |

Operator disposition (3.5): _open_ — defer the escalation-to-required decision until after the first audit report is received. Documented in [`gao-safe-static-analysis.md`](./gao-safe-static-analysis.md) §3-§5.

Sign-off: operator lead.

---

## 4. Dependency posture

| Row | Required state | Reference |
|---|---|---|
| 4.1 Solidity pin. | ✅ `0.8.24` exact in [`hardhat.config.ts`](../../hardhat.config.ts) |
| 4.2 Optimizer pin. | ✅ enabled, `runs: 200` |
| 4.3 metadata bytecodeHash. | ✅ `ipfs` (explorer-verifiable) |
| 4.4 OpenZeppelin contracts version disposition. | Declared `^5.0.2`, resolved `5.6.1`. Tightening to exact pin deferred to the post-audit deployment-runbook PR — disposition recorded in [`known-issues-and-nongoals.md`](./known-issues-and-nongoals.md) §2.1. | Sign-off below |
| 4.5 No untrusted dependency added since audit-target commit. | Check via `git log -- package.json package-lock.json` between audit-target commit and audit-finish commit. | n/a until audit finishes |

Sign-off: operator lead + security reviewer.

---

## 5. Out-of-scope confirmations

| Row | Required state | Reference |
|---|---|---|
| 5.1 Genesis non-goals enumerated. | ✅ | [`known-issues-and-nongoals.md`](./known-issues-and-nongoals.md) §1 |
| 5.2 MPC / TSS explicitly out of scope for Genesis. | ✅ Genesis is on-chain Safe-style multisig with EOA owners. No key share, no DKG, no threshold-signing protocol. | [`known-issues-and-nongoals.md`](./known-issues-and-nongoals.md) §1 (row "MPC / TSS") |
| 5.3 ERC-1271 execution path out of scope. | ✅ Reserved storage tag only; verifier rejects. | [`known-issues-and-nongoals.md`](./known-issues-and-nongoals.md) §1 |
| 5.4 Upgradeability out of scope. | ✅ Immutable clones of an immutable singleton. | [`gao-safe-design.md`](./gao-safe-design.md) §4 |
| 5.5 Modules / plugins out of scope. | ✅ Same. | Same. |
| 5.6 Post-quantum verifier out of scope. | ✅ Reserved mobile tags only. | Same. |

Sign-off: engineering lead.

---

## 6. Mobile compatibility

| Row | Required state | Reference |
|---|---|---|
| 6.1 ABI sha256 hashes byte-equal between repos. | ✅ Both hashes match the mobile pin. | [`mobile-abi-compatibility.md`](./mobile-abi-compatibility.md) §2 |
| 6.2 Mobile pinned commit reachable on `gao-contracts/main`. | ✅ `ac14411` is on `main`. | [`mobile-abi-compatibility.md`](./mobile-abi-compatibility.md) §10 |
| 6.3 No mobile-breaking drift from mobile pin to current contract HEAD. | ✅ PR #19 added tests + advisory workflow only — no contract change. | `git log gao-contracts/main` PR #18 + #19 |
| 6.4 EIP-712 parity tests green (both sides). | ✅ 7 contract parity cases + mobile parity tests pass. | Mobile [`ProposalBuilder.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/ProposalBuilder.test.ts), contract [`GaoSafe.eip712-parity.test.ts`](../../test/multisig/GaoSafe.eip712-parity.test.ts) |
| 6.5 Mobile feature flag remains OFF and factory map remains empty. | ✅ `MULTISIG_FEATURE_ENABLED = false as const`, `MULTISIG_FACTORY_BY_CHAIN = Object.freeze({})`. | [`gaokey-mobile/src/multisig/config.ts`](../../../gaokey-mobile/src/multisig/config.ts) |

Sign-off: engineering lead.

---

## 7. Deployment posture (pre-audit)

| Row | Required state | Reference |
|---|---|---|
| 7.1 No mainnet deployment of `GaoSafe` or `GaoSafeFactory`. | ✅ — no deployment record under `deployments/` for either contract. | `ls deployments/` |
| 7.2 No testnet deployment of `GaoSafe` or `GaoSafeFactory`. | ✅ — same. | Same. |
| 7.3 No deploy script for the factory present in `scripts/multisig/`. | ✅ — only `exportGaoSafeAbi.ts` exists. | `ls scripts/multisig/` |
| 7.4 Deploy script (when added) will follow the existing pattern. | Documented as a follow-up: chain-id allowlist + mainnet banlist + dry-run mode + public-address-only output. | Same pattern as `scripts/deployGaoDomainDepositV3.devtest.ts`. |

Sign-off: operator lead.

---

## 8. During-audit hygiene

| Row | Required state |
|---|---|
| 8.1 No changes to `contracts/multisig/*.sol` during the audit window without auditor's awareness. | A material change requires a re-engagement scope decision. |
| 8.2 Doc updates during the audit window are tracked in a single thread visible to the auditor. | n/a until audit starts. |
| 8.3 Any new contributor with write access during the audit window is logged. | n/a until audit starts. |

Sign-off: operator lead.

---

## 9. Post-audit gate (closing this checklist)

This checklist closes when all of the following are satisfied:

- Every critical and high finding remediated.
- Every medium finding remediated or explicitly accepted with documented rationale.
- Auditor confirms remediation of critical / high findings in writing (re-review).
- The remediation PRs are merged on `main` and tagged.
- This checklist is updated with audit-report reference, remediation-PR list, and sign-off names.

Sign-off (post-audit): engineering lead AND security reviewer AND operator lead.

---

## 10. What this checklist does NOT cover

- **Mainnet enablement.** That gate is in [`gaokey-mobile/docs/multisig/production-readiness-gate.md`](../../../gaokey-mobile/docs/multisig/production-readiness-gate.md) and includes: mobile security review, deployment runbook execution, per-chain factory-address registration, bytecode hash pin, monitoring + kill switch, reviewer + security sign-off, operator change-control record. The audit closing this checklist is a **necessary precondition** of the mainnet gate, not a substitute.
- **Operational treasury controls.** Threshold sizing rules, signer device hygiene, key-custody procedures, and incident response are documented in [`gaokey-mobile/docs/multisig/`](../../../gaokey-mobile/docs/multisig/) (cold-signer-mode, incident-recovery-drill, mobile-signing-threat-model). They are operator playbooks, not gates on this checklist.
- **MPC / TSS rollout.** Genesis is on-chain Safe-style multisig with EOA owners. An MPC layer participating as a single owner is a **separate project** with its own design, audit, and rollout — out of scope for this checklist and for any consuming-app v1 plan.
