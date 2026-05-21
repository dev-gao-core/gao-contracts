# GaoSafe Genesis — External Audit Handoff

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until an independent smart-contract audit and the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) are satisfied.

This document is the **single artifact** the operator sends to an external smart-contract audit firm when engaging on GaoSafe Genesis. It bundles the commit pin, scope, reproduction commands, reporting format expectations, and links to every supporting doc. After this is shared, the auditor needs nothing else to start work.

This document complements (does not replace):

- [auditor-onboarding.md](./auditor-onboarding.md) — auditor-facing self-onboarding guide
- [audit-scope-statement.md](./audit-scope-statement.md) — engagement-letter scope statement
- [auditor-questions.md](./auditor-questions.md) — pre-answered FAQ
- [pre-audit-freeze.md](./pre-audit-freeze.md) — freeze rules during the audit window

---

## 1. Engagement summary

| Item | Value |
|---|---|
| Product | GaoSafe Genesis — institutional-baseline M-of-N multisign vault |
| Sponsor | dev-gao-core (operator) |
| Repository | [`dev-gao-core/gao-contracts`](https://github.com/dev-gao-core/gao-contracts) |
| Audit target branch | `main` |
| Audit target commit (this handoff) | `bf48bdf0e441eee4631d8b889631e6781ff0f6ea` |
| In-scope Solidity files | [`contracts/multisig/GaoSafe.sol`](../../contracts/multisig/GaoSafe.sol) + [`contracts/multisig/GaoSafeFactory.sol`](../../contracts/multisig/GaoSafeFactory.sol) |
| Total LOC in scope (Solidity, excl. comments/whitespace) | ~280 statement lines across two files |
| Compiler | solc 0.8.24, optimizer `runs: 200`, metadata `bytecodeHash: ipfs` |
| OpenZeppelin dependency | `@openzeppelin/contracts` declared `^5.0.2`, resolved `5.6.1` in `package-lock.json` |
| What this contract is | On-chain Safe-style M-of-N multisig with EOA owners + EIP-712 typed-data signatures |
| What this contract is **NOT** | **NOT** MPC / TSS / threshold signing. **NOT** upgradeable. **NOT** modular/plugin. **NOT** ERC-1271 execution. **NOT** PQ-verifying. |
| Deployment status | No mainnet deployment. No testnet deployment. No deploy script for `GaoSafeFactory` in this repo. |
| Mobile-side feature flag | OFF (`MULTISIG_FEATURE_ENABLED = false as const`); factory address registry empty. |

---

## 2. Commit pin and reproducibility

| Item | Value |
|---|---|
| Audit target commit SHA | `bf48bdf0e441eee4631d8b889631e6781ff0f6ea` |
| Audit target tree URL | https://github.com/dev-gao-core/gao-contracts/tree/bf48bdf0e441eee4631d8b889631e6781ff0f6ea |
| ABI SHA-256 (`abis/multisig/GaoSafe.json`) | `ee21f7af040b2e579c7e8c2985d2e16cf51b6b84cdbd72116eda994ca13549d1` |
| ABI SHA-256 (`abis/multisig/GaoSafeFactory.json`) | `1af102026245f187025bc716fce033f25967fc8b8b2f6fc99886573240d8a90f` |
| Mobile-side pinned commit | `gao-contracts@ac14411` (PR #17) — ABI byte-equal to audit-target commit |

Reproduce the audit-target tree locally:

```bash
git clone https://github.com/dev-gao-core/gao-contracts.git
cd gao-contracts
git checkout bf48bdf0e441eee4631d8b889631e6781ff0f6ea
npm ci
npx hardhat compile
shasum -a 256 abis/multisig/GaoSafe.json abis/multisig/GaoSafeFactory.json
```

Expected at the audit-target commit:

- `npx hardhat compile` → clean build, no Solidity warnings on the multisig files.
- `shasum` matches the two SHA-256 lines in §1.
- The audit-target tree must remain untouched for the duration of the audit window — see [pre-audit-freeze.md](./pre-audit-freeze.md).

---

## 3. Test commands and expected counts

```bash
npx hardhat test \
  test/multisig/GaoSafe.test.ts \
  test/multisig/GaoSafeFactory.test.ts \
  test/multisig/GaoSafe.eip712-parity.test.ts \
  test/multisig/GaoSafe.invariants.test.ts \
  test/multisig/GaoSafe.fuzz-signatures.test.ts \
  test/multisig/GaoSafeFactory.fuzz-create2.test.ts
# expected: 70 passing

npx hardhat test test/guardrails/multisig-no-address-literals.test.ts
# expected: 3 passing
```

Per-file expected counts:

| File | Cases | Subject |
|---|---|---|
| [`GaoSafe.test.ts`](../../test/multisig/GaoSafe.test.ts) | 39 (#1–#39) | Setup, exec happy/rejection, owner-set onlySelf, bare-impl + uninit-clone hardening |
| [`GaoSafeFactory.test.ts`](../../test/multisig/GaoSafeFactory.test.ts) | 10 (F1–F10) | Singleton lock, clone determinism, deployer-binding, ABI hygiene |
| [`GaoSafe.eip712-parity.test.ts`](../../test/multisig/GaoSafe.eip712-parity.test.ts) | 7 (P1–P7) | EIP-712 JS↔contract parity + clone-safety pin |
| [`GaoSafe.invariants.test.ts`](../../test/multisig/GaoSafe.invariants.test.ts) | I1–I7, I10 × 50 iter | Property tests for nonce, threshold, owner-set, init, ETH ingress, replay |
| [`GaoSafe.fuzz-signatures.test.ts`](../../test/multisig/GaoSafe.fuzz-signatures.test.ts) | I8a–I8d × 50 iter | Sorting / dedupe / non-owner / positive-sanity over signature bundles |
| [`GaoSafeFactory.fuzz-create2.test.ts`](../../test/multisig/GaoSafeFactory.fuzz-create2.test.ts) | I9a–I9b × 50 iter | CREATE2 address prediction + deployer-binding |
| [`multisig-no-address-literals.test.ts`](../../test/guardrails/multisig-no-address-literals.test.ts) | 3 | Guardrail: no 40-char hex literals in scope outside an allowlist sentinel |

**Total: 70 multisig + 3 guardrail = 73 passing.**

---

## 4. Scope inventory (what an auditor reads)

Read in this order:

| Step | Document | Why |
|---|---|---|
| 1 | [auditor-onboarding.md](./auditor-onboarding.md) | Auditor-facing landing page — repo + commit pin, toolchain pin, scope map, sanity assertions |
| 2 | [gao-safe-design.md](./gao-safe-design.md) | Architecture, lifecycle, EIP-712 layout, what is in vs out of Genesis scope |
| 3 | [gao-safe-threat-model.md](./gao-safe-threat-model.md) | STRIDE per primitive, asset table, adversary model |
| 4 | [gao-safe-invariants.md](./gao-safe-invariants.md) | Invariant matrix I1–I10, each with its property test and seed protocol |
| 5 | [gao-safe-test-plan.md](./gao-safe-test-plan.md) | 56 point cases + 14 property cases |
| 6 | [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) | Slither posture (advisory) |
| 7 | [gao-safe-ci-hardening.md](./gao-safe-ci-hardening.md) | CI workflow + address-literals guardrail |
| 8 | [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) | Explicit non-goals + currently-tracked known items |
| 9 | [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) | ABI SHA-256 pin + JS↔contract digest parity |
| 10 | [audit-readiness-checklist.md](./audit-readiness-checklist.md) | Operator-facing readiness checklist |
| 11 | [audit-scope-statement.md](./audit-scope-statement.md) | Formal scope statement |
| 12 | [auditor-questions.md](./auditor-questions.md) | Pre-answered FAQ |
| 13 | [pre-audit-freeze.md](./pre-audit-freeze.md) | Freeze rules during the audit window |

---

## 5. Security assumptions

| # | Assumption | Why it matters |
|---|---|---|
| A1 | At most one owner is compromised at any given moment. | Genesis threshold sizing (2-of-3, 3-of-5, etc.) protects only against this adversary model. Operator owns the institutional sizing rule. |
| A2 | Owner private keys are held off-chain (EOA). | Genesis never sees a private key, only EIP-712 signatures. |
| A3 | Owner signing devices follow the threat model in [`gaokey-mobile/docs/multisig/mobile-signing-threat-model.md`](../../../gaokey-mobile/docs/multisig/mobile-signing-threat-model.md). | Off-chain hygiene is the mobile-side concern; not in scope for this contract audit. |
| A4 | Block.chainid is honest. | EVM consensus assumption; out of scope. |
| A5 | The OZ-vendored libraries used (`ECDSA`, `Clones`) are reviewed independently. | The audit can take the OZ-imported semantics as given. OZ version disposition in [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.1. |
| A6 | Submitter pays gas. No relayer / paymaster / sponsorship. | Genesis has no gas-sponsorship code path; the submitter is just the address that pays the gas. The submitter need not be an owner. |
| A7 | No upgradeability. Every vault is an immutable clone of an immutable singleton. | Auditor does not need to consider upgrade-time storage layout. |
| A8 | No modules / plugins / external hooks. | Auditor does not need to consider plugin-time control flow. |

---

## 6. Findings triage workflow

### 6.1 Severity definitions used by the operator

These are the operator's reading frame for triage. Auditor's own definitions take precedence in the report itself.

| Severity | Operator definition |
|---|---|
| **Critical** | Allows a non-owner to move funds; allows an owner to move funds without M-of-N; allows replay across chain or vault; allows nonce reuse; breaks one-shot init; allows direct call to `setup()` on bare singleton; allows owner-set mutation outside `onlySelf`. |
| **High** | Bypasses a §1 audit-scope boundary (e.g. allows execution while mobile feature flag is off; allows zero-threshold short-circuit on bare implementation; allows bare implementation to receive ETH that can't be recovered). |
| **Medium** | Allows a degraded state that needs operator intervention to recover (e.g. owner can produce a digest that fails on submit, wasting gas; event field shape that confuses an indexer; OZ version drift that could silently change a primitive). |
| **Low** | Quality / style / readability improvements with no security impact. |
| **Informational** | Observations or recommendations with no required action. |

### 6.2 Remediation PR rules

| Rule | Detail |
|---|---|
| R1 | One remediation finding = one PR. Multi-finding PRs are rejected at review unless findings are mechanically intertwined and that intertwining is documented in the PR body. |
| R2 | PR title format: `fix(multisig): remediate audit finding <ID> — <one-line summary>` |
| R3 | PR body MUST link the auditor's finding number, severity, and original report excerpt (paraphrased OK; verbatim quote when needed). |
| R4 | PR body MUST include the pinning test added or strengthened by the remediation. A finding with no regression test is rejected. |
| R5 | PR body MUST include the auditor's re-review acknowledgement for every Critical and High finding. Critical/High without re-review acknowledgement is not merged. |
| R6 | Medium findings MAY be merged with `accept-with-rationale` instead of remediation; the rationale lives in [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2 and is operator-signed. |
| R7 | Low/Informational findings MAY be bundled into a single follow-up PR per the operator's decision. The bundling commit message lists every finding ID. |
| R8 | Remediation PRs MUST keep the address-literals guardrail and the existing 73-case test suite passing. |
| R9 | Remediation PRs MUST NOT touch out-of-scope areas (mobile, hardhat config, package-lock, ABI artifacts) except when the finding is specifically about that area and the scope is re-confirmed with the auditor. |
| R10 | All AI attribution rules in [`CLAUDE.md`](../../CLAUDE.md) §3 apply to remediation PRs — no AI attribution in commit messages, PR titles/bodies, or code comments. |

### 6.3 Closing the audit

The audit closes when:

- Every Critical and High finding is remediated AND the auditor confirms remediation in writing (re-review).
- Every Medium finding is either remediated or has an operator-signed `accept-with-rationale` documented in [known-issues-and-nongoals.md](./known-issues-and-nongoals.md).
- The audit report is linked from [gao-safe-design.md](./gao-safe-design.md) §10.
- [audit-readiness-checklist.md](./audit-readiness-checklist.md) is updated post-audit with sign-off names + remediation-PR list.

---

## 7. What the auditor will receive

The handoff package is a single email / shared-drive folder that contains:

| Artifact | Form |
|---|---|
| 1. This document | URL to `external-audit-handoff.md` on `gao-contracts/main` at the audit-target commit |
| 2. Audit-target commit SHA | `bf48bdf0e441eee4631d8b889631e6781ff0f6ea` written explicitly in the handoff email |
| 3. Public repo URL | `https://github.com/dev-gao-core/gao-contracts` |
| 4. Engagement letter | Operator-side document; lives in the operator's contract management system |
| 5. Audit-scope statement | URL to `audit-scope-statement.md` |
| 6. Operator contact | Single named operator contact + secure delivery channel for the report |

The auditor does NOT need:

- A deployed contract address.
- A funded testnet wallet.
- Access to any `.env` value, RPC URL, or operator infrastructure.
- A mobile-app build.

---

## 8. What the auditor will deliver

| Deliverable | Format |
|---|---|
| Audit report | PDF + (optionally) Markdown source. Cover page MUST cite the audit-target commit SHA. |
| Findings list | One row per finding: ID, severity, file:line location, description, suggested remediation. |
| Severity definitions | Auditor-defined (operator's definitions in §6.1 are for internal triage). |
| Methodology | Manual review scope + tools used (Slither/Mythril versions, fuzz seed, fuzz time budget). |
| Cross-references | Each finding links to relevant section in `gao-safe-threat-model.md` or `gao-safe-invariants.md` where overlap exists. |
| Re-review confirmation | Written acknowledgement of every Critical and High remediation. |

---

## 9. Communication and pacing

- Day-to-day questions go to the named operator contact via the engagement-letter channel. The repo's GitHub Issues are NOT used as the audit reporting channel.
- A pre-engagement Q&A session is welcomed. Operator has pre-answered the most common questions in [auditor-questions.md](./auditor-questions.md) so the call can focus on auditor-specific concerns.
- Mid-audit observations that the auditor wants to share early (e.g. clarification requests, doc-only suggestions) go through the same channel.
- Final report delivery follows the engagement-letter timeline.

---

## 10. Post-audit gate (what happens after this engagement)

Closing the audit (per §6.3) is a **necessary precondition** of mainnet enablement, NOT a substitute. The mainnet gate lives in [`gaokey-mobile/docs/multisig/production-readiness-gate.md`](../../../gaokey-mobile/docs/multisig/production-readiness-gate.md) and additionally requires:

- Mobile security review (per gate §2).
- Deployment runbook + bytecode-hash pin + per-chain factory address registration.
- Monitoring + kill switch ready.
- Reviewer + security + operator sign-off recorded.

The contract audit closing this checklist gates **only** the contract review. Mainnet enablement is a separate sign-off.
