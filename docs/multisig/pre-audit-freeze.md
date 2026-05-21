# GaoSafe Genesis — Pre-Audit Freeze Rules

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document defines the freeze rules that take effect when the operator hands the audit package to an external smart-contract audit firm and remain in force until the engagement closes. It exists so that every contributor — human or assistant — knows what may change and what must not during the audit window.

The audit window starts when the operator emails the handoff package to the auditor citing a specific audit-target commit SHA on `gao-contracts/main`. The audit window ends when the auditor delivers the final report and the operator records the audit-report reference in [gao-safe-design.md](./gao-safe-design.md) §10.

---

## 1. Audit-target commit

| Item | Value |
|---|---|
| Audit-target commit SHA | `bf48bdf0e441eee4631d8b889631e6781ff0f6ea` |
| Audit-target branch | `main` |
| Repository | `dev-gao-core/gao-contracts` |
| Frozen for the duration | The audit window |

While the audit window is open:

- The audit-target commit SHA on `main` MUST NOT be force-pushed, rebased, rewritten, or otherwise relocated. New commits MAY land on `main` (see §3) but the audit-target SHA must remain reachable.
- A protective tag `audit-target-MS-P2` SHOULD be created locally and pushed when the audit firm is selected, so the SHA has a human-readable name. The tag MUST NOT be moved during the audit window.

---

## 2. Frozen surfaces (no change without re-engagement)

The following files / paths are FROZEN. A change here requires re-engagement scope discussion with the auditor BEFORE the change lands (per the protocol in [audit-scope-statement.md](./audit-scope-statement.md) §9):

| Frozen surface | Reason |
|---|---|
| `contracts/multisig/GaoSafe.sol` | In-scope Solidity. |
| `contracts/multisig/GaoSafeFactory.sol` | In-scope Solidity. |
| `abis/multisig/GaoSafe.json` | Byte-identical pin shared with mobile. |
| `abis/multisig/GaoSafeFactory.json` | Byte-identical pin shared with mobile. |
| `hardhat.config.ts` | Solidity / optimizer / metadata pin. |
| `package.json` | Dependency version constraints. |
| `package-lock.json` | Locked dependency versions. |
| `slither.config.json` | Static-analysis scope. |
| `.github/workflows/contracts-ci.yml` | Required CI gate. |
| `.github/workflows/contracts-slither.yml` | Advisory CI workflow. |
| `test/multisig/**` | Pinning tests cited in the audit-target commit. |
| `test/guardrails/multisig-no-address-literals.test.ts` | Cited address-literals guardrail. |
| `test/multisig/helpers/eip712.ts` | JS-side mirror cited in `eip712-parity.test.ts`. |

A change that is mechanical (e.g. a typo fix in a Solidity comment) is still a change to a frozen surface and STILL requires the protocol in [audit-scope-statement.md](./audit-scope-statement.md) §9.

---

## 3. Allowed changes during the audit window

The following changes are explicitly permitted during the audit window without re-engagement:

| Allowed change | Constraint |
|---|---|
| New or updated docs under `docs/multisig/` | MUST NOT contradict an active security claim the auditor is evaluating. If the doc change addresses an auditor clarification request, the change MUST be flagged to the auditor in the same channel where the clarification was raised. |
| New tests that ADD coverage without changing existing assertions | MUST keep the existing 73-case suite green. New tests SHOULD reference the auditor-requested coverage if applicable. |
| Unrelated work on non-multisig files (e.g. `contracts/GaoDomain*.sol`, scripts unrelated to multisig) | MUST NOT touch any path listed in §2. Operator SHOULD prefer to defer non-urgent unrelated work to keep the audit window calm. |
| Repository-level chore changes (README, top-level docs that do not assert multisig claims) | MUST NOT touch `docs/multisig/` substantively — see row above. |

The principle: anything in the audit's reading scope is frozen; anything outside that scope is fine if it does not affect the build.

---

## 4. Frozen artefacts on the mobile side

The mobile-side artefacts that consume the in-scope ABI are ALSO frozen for the audit window:

| Frozen mobile artefact | Reason |
|---|---|
| `gaokey-mobile/src/multisig/abis.ts` | Mirrors the in-scope ABI byte-for-byte. |
| `gaokey-mobile/src/multisig/config.ts` | `MULTISIG_FEATURE_ENABLED = false as const` and `MULTISIG_FACTORY_BY_CHAIN = Object.freeze({})` MUST remain unchanged. |
| `gaokey-mobile/src/multisig/types.ts` version pins | `PROPOSAL_VERSION = 1` and `SIGNATURE_BUNDLE_VERSION = 1` MUST remain unchanged. |
| All `gaokey-mobile/src/multisig/**` source | Mobile-side digest builder must not drift from contract semantics during the audit. Bug-fix exceptions follow the same re-engagement protocol. |

This is a soft commitment from the operator: the operator MAY land mobile changes that are clearly outside the multisig surface (other features), but anything touching `src/multisig/`, `app/(app)/multisig/`, `src/screens/Multisig/`, or the mobile-side ABI consumer is frozen.

---

## 5. Findings-during-window handling

If the operator independently discovers an issue during the audit window:

1. The operator does NOT silently fix it. Doing so would create an "audit said the contract is OK at SHA X" claim that no longer matches the deployed reality.
2. The operator reports the finding to the auditor in the same channel where audit findings are returned.
3. The operator and auditor agree on disposition:
   - Absorb into the same engagement (auditor re-reviews after remediation).
   - Defer to post-audit remediation phase (documented, signed).
   - Re-engagement with a new audit-target commit (rare; only for material new surface).

The same protocol applies if a third party (community researcher, internal contributor) reports an issue during the window.

---

## 6. Out-of-window urgencies

The freeze rules above apply during a planned audit window. Three kinds of urgency override them:

| Urgency | Override permitted |
|---|---|
| **Imminent operational exposure on a DEPLOYED contract** | N/A — Genesis is not deployed during the audit window. The override is recorded for symmetry; no actual override is anticipated. |
| **Production incident in a non-multisig product line** | Permitted, provided the fix touches no frozen surface in §2. Fix is documented and the operator continues to honour §2. |
| **CI infrastructure failure that blocks all PRs** | Permitted to fix the workflow itself; if the fix touches `.github/workflows/contracts-{ci,slither}.yml`, the fix is summarised to the auditor as soon as it lands. |

Nothing else in §2 has a routine override mechanism.

---

## 7. Branch hygiene during the window

| Practice | Detail |
|---|---|
| Long-lived feature branches | Discouraged during the window. Open small PRs and merge promptly to keep `main` close to the audit-target commit. |
| Force-push of any branch with PR | NEVER permitted on `main`. On feature branches, force-push is fine but the branch must not be a frozen-surface change branch. |
| Tag protection | The `audit-target-MS-P2` tag (when set) MUST be protected via GitHub branch / tag protection rules. |
| Merge protection on `main` | Required status checks (`contracts-ci`) MUST pass. Direct push to `main` is administratively forbidden during the window. |

---

## 8. Communication of changes during the window

Every change that touches `docs/multisig/` during the window:

- Is summarised to the operator's named auditor-contact in the same channel as audit findings.
- Receives an acknowledgement before the PR is considered closed (the PR can merge; the acknowledgement is a soft requirement to maintain the audit's shared context).
- Is referenced in the change-log row of the eventual closing-audit summary.

Every change that touches a frozen surface in §2:

- Follows the protocol in [audit-scope-statement.md](./audit-scope-statement.md) §9: written notice → auditor acknowledgement → land.
- The PR title indicates the audit-window status (e.g. `fix(multisig): audit-window scope change — reason`).

---

## 9. Closing the freeze

The freeze ends when:

- The auditor delivers the final report.
- The audit-report reference is recorded in [gao-safe-design.md](./gao-safe-design.md) §10.
- [audit-readiness-checklist.md](./audit-readiness-checklist.md) is updated with sign-off names.
- A post-window summary PR (docs only) records the change-log of any doc-only updates that occurred during the window.

After the freeze closes, normal change rules from [`CLAUDE.md`](../../CLAUDE.md) resume. Remediation PRs proceed under the rules in [external-audit-handoff.md](./external-audit-handoff.md) §6.2.
