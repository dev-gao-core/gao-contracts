# GaoSafe Genesis — Known Issues & Non-Goals

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document is the single page that consolidates:

- **Audit-scope boundaries** — capabilities deliberately excluded from Genesis to keep the core small and auditable. These are NOT deferred work; they are documented design boundaries. If an excluded capability is added later, it ships as a separate contract with its own design review and audit.
- **Currently-tracked known items** — concrete items the operator is aware of and is choosing to disposition either before or as part of the audit engagement. None of these is a security gap; each has a documented rationale.
- **Things that intentionally have no test** — Genesis behaviour that does not exist. Tests for absent behaviour would be misleading.

---

## 1. Audit-scope boundaries (explicit non-goals)

Each row is an **architectural exclusion**. Genesis must clear an independent audit as the **production custody primitive**. The boundaries below are how the audit surface is kept small enough to actually clear that bar.

| Excluded capability | Reason for exclusion | Future path |
|---|---|---|
| Upgradeability | Every vault is an immutable clone of an immutable implementation. Upgradeability would introduce delegatecall-target trust on the storage of in-flight vaults. | Out of scope for Genesis. If ever added, it ships as a separate, separately-audited contract — not as a patch to Genesis. |
| Modules / plugins | Plugin systems are historically a major source of multisig vulnerabilities (Safe modules have repeatedly been the surface where bugs land). | Same as above — separate contract, separate audit. |
| ERC-1271 / smart-contract owners on the **execution** path | Verifier accepts only EOA ECDSA signatures over the EIP-712 digest. Mobile reserves the `erc1271_contract` tag for forward STORAGE compatibility only — verifier still rejects it. | A future audited contract MAY add an ERC-1271 path; Genesis verifier will not. |
| Post-quantum signature verification | No PQ verifier; no fake verifier; reserved storage tag in mobile only. | PQ is a separately-designed, separately-audited future addition. See [`gaokey-mobile/docs/multisig/post-quantum-roadmap.md`](../../../gaokey-mobile/docs/multisig/post-quantum-roadmap.md). |
| Best-effort batch execution | Partial-state outcomes are a class of accounting bugs. Genesis is all-or-nothing. | Not planned. |
| Timelock | A timelock policy layer is a separate audit concern. | If ever added, ships as a separate audited contract that can sit alongside Genesis. |
| Spending limits | Same as timelock. | Same. |
| Allowlist / denylist guard | Same as timelock. | Same. |
| Gas-sponsored execution / relayers / paymasters | Submitter pays gas in Genesis. | Operational concern; out of scope for the core. |
| Private mempool / MEV protection on submit | Operational concern. | Out of scope for the core. |
| **MPC / TSS / threshold signing** | Genesis is a classic on-chain multisig with independent EOA owners. There is no key-share scheme, no DKG, no threshold-signature protocol. | A future MPC layer MAY participate as a single owner in the vault's owner set — the contract sees one address and doesn't care that the signature was produced by a multi-party protocol. Designing that MPC layer is **a separate project** with its own design review and audit. |
| MEV-resistant signing ordering | Not a Genesis concern. | N/A. |
| On-chain notification / mailbox | Off-chain concern. | N/A. |
| Recovery social-key flow | No backdoor in Genesis. Recovery is via multisig `replaceOwner` proposals signed by the surviving threshold. | Operator key custody is the institutional control. |

Anything else not listed in `gao-safe-design.md` §3 ("What Genesis includes") is also out of scope by default.

---

## 2. Currently-tracked known items (operator-aware)

These are not security bugs — they are items the operator is aware of and is choosing to handle either before or as part of the audit engagement. The auditor MAY surface any of them in the audit report; the operator has already pre-thought through the disposition.

### 2.1 OpenZeppelin caret pin resolves to a newer minor

| Property | Value |
|---|---|
| Declared in `package.json` | `"@openzeppelin/contracts": "^5.0.2"` |
| Resolved in `package-lock.json` | `5.6.1` |
| Risk | Low — caret on a `5.x` line allows minor bumps that COULD silently change OZ internals consumed by Genesis (`ECDSA.tryRecover`, `Clones.cloneDeterministic`, `Clones.predictDeterministicAddress`). Tests exercise the consuming behaviour, so a binary-incompatible change would fail CI. A semantic change that preserves behaviour but ships a new internal property is still possible. |
| Disposition | The auditor MAY recommend tightening to an exact pin. The operator's intent is to land an exact pin in the **same PR** that adds factory addresses to `gaokey-mobile/src/multisig/config.ts` post-audit. Documented here so the auditor sees this is not an oversight. |

### 2.2 Implementation singleton bytecode hash is TBD

| Property | Value |
|---|---|
| Today | The implementation has no canonical deployed address; bytecode hash will be observed only when the operator runs `npx hardhat compile` against the audit-target commit and records the runtime-bytecode hash for the chosen target chain. |
| Risk | None — the audit is over source, not bytecode. The hash is the **deployment-time** artifact, recorded in the operator-only deploy runbook PR. |
| Disposition | The bytecode hash pin lives in the deployment runbook, NOT in this audit-package PR. Auditor MAY include a recommendation for which fields to pin in the runbook (target chain ID, deployer address, factory address, implementation address, implementation runtime hash, OZ Clones library version). |

### 2.3 Per-chain factory addresses are not yet registered

| Property | Value |
|---|---|
| Today | `gaokey-mobile/src/multisig/config.ts` ships `MULTISIG_FACTORY_BY_CHAIN = Object.freeze({})` with `MULTISIG_FEATURE_ENABLED = false as const`. |
| Risk | None — the empty map is the locked default. Adding any address is a separate, single-purpose, reviewer-signed-off PR per the locked rule in [`gaokey-mobile/src/multisig/config.ts`](../../../gaokey-mobile/src/multisig/config.ts). |
| Disposition | Auditor MAY recommend a published-bytecode-hash check in the address-registration PR template. Operator already requires bytecode-hash + audit-report link in that PR body; auditor input refines the template. |

### 2.4 Slither workflow is advisory, not gating

| Property | Value |
|---|---|
| Today | `.github/workflows/contracts-slither.yml` runs Slither 0.10.4 with `continue-on-error: true` on every Slither-related step. Its result does NOT block PR merges. |
| Risk | A new detector in a Slither minor bump could land silently. Documented in [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) §3-§5. |
| Disposition | Auditor MAY recommend escalating Slither to a required check after a zero-finding baseline is observed across N consecutive PRs. Operator decision recorded in [audit-readiness-checklist.md](./audit-readiness-checklist.md). |

### 2.5 `slither.config.json` excludes two detectors

| Property | Value |
|---|---|
| Today | Excluded: `naming-convention`, `solc-version`. |
| Rationale | Solidity naming follows project convention (`gao-safe-design.md` is the doc anchor). `solc-version` would fire on the 0.8.24 pin even though the pin is intentional and audit-tracked. |
| Disposition | Auditor MAY confirm in writing that these exclusions are acceptable for the engagement scope. |

### 2.6 No deploy script for `GaoSafeFactory` is in this repo

| Property | Value |
|---|---|
| Today | `scripts/multisig/exportGaoSafeAbi.ts` exists. No `deployGaoSafeFactory.devtest.ts` or `deployGaoSafeFactory.mainnet.ts`. |
| Risk | None — deployment runbook is operator-only and lands post-audit in a single-purpose PR. |
| Disposition | Auditor MAY recommend specific safety rails for the deploy script (chain-id allowlist, mainnet banlist toggle, dry-run mode, public-address display only). Same pattern as `scripts/deployGaoDomainDepositV3.devtest.ts`. |

### 2.7 EIP-712 manual implementation (not OZ EIP712)

| Property | Value |
|---|---|
| Today | `domainSeparator()` is computed manually every call. OZ's `EIP712.sol` is intentionally NOT inherited because its constructor-cached `address(this)` would cache the singleton's address for every clone. |
| Risk | None — the manual implementation is pinned by `GaoSafe.eip712-parity.test.ts` P1–P7 and is byte-equal to ethers `TypedDataEncoder.hash`. Case P7 specifically asserts two clones produce different domain separators on the same chain. |
| Disposition | Documented at length in [gao-safe-design.md](./gao-safe-design.md) §6 and inline in [`GaoSafe.sol:41-52`](../../contracts/multisig/GaoSafe.sol#L41). |

### 2.8 Bare-implementation ETH-ingress refusal relies on an immutable

| Property | Value |
|---|---|
| Today | `_IMPLEMENTATION_SELF` is set in the implementation's constructor; the immutable lives in runtime bytecode and is reachable identically through every clone's delegatecall. `receive()` reverts when `address(this) == _IMPLEMENTATION_SELF`. |
| Risk | Subtle. The fact that immutables are bytecode-baked (not storage-baked) is the precise property that makes this work. Pinned by `GaoSafe.test.ts` #36 (clone accepts ETH) and #39 (singleton refuses ETH). |
| Disposition | Documented at length in [`GaoSafe.sol:126-160`](../../contracts/multisig/GaoSafe.sol#L126). Worth a careful read during the audit. |

### 2.9 `removeOwner` swap-and-pop changes owner order

| Property | Value |
|---|---|
| Today | Removal swaps the target owner with the last element, then pops. Owner order is therefore not stable across `removeOwner` calls. |
| Risk | None — owner order has no semantic meaning. Threshold logic uses the `isOwner` map, not the array order. `getOwners()` callers must NOT assume positional stability. |
| Disposition | Documented in `gao-safe-design.md`. No mitigation needed. |

### 2.10 `tryRecover` error path collapses to `NotAnOwner`

| Property | Value |
|---|---|
| Today | When `ECDSA.tryRecover` returns any error code (`InvalidSignature`, `InvalidSignatureLength`, `InvalidSignatureS`, `InvalidSignatureV` in OZ 5.x), `_verifySignatures` reverts with `NotAnOwner`. |
| Risk | An external observer cannot distinguish "malformed signature" from "signature recovered to a non-owner". This is intentional — preventing a digest-mutation oracle. |
| Disposition | Documented. Auditor MAY confirm this is acceptable. |

---

## 3. Things that intentionally have no test

Tests assert behaviour that exists. The capabilities listed in §1 do NOT exist in Genesis, so tests for them would be misleading. The matrix in [gao-safe-test-plan.md](./gao-safe-test-plan.md) explicitly states this.

If a reviewer wonders "where is the test for [excluded capability X]?", the answer is in §1: the capability is absent by design, and an absent capability cannot fail by being absent.

---

## 4. What "Critical / High / Medium / Low" mean for Genesis

The operator will use these severities when triaging audit findings:

| Severity | Definition (operator-side) | Action |
|---|---|---|
| Critical | Allows a non-owner to move funds, allows an owner to move funds without M-of-N, allows replay across chain or vault, allows nonce reuse, breaks one-shot init, allows direct call to `setup()` on the bare singleton, allows owner-set mutation outside `onlySelf`. | Fix before mainnet. Re-audit required for the fix. |
| High | Bypasses one of the §1 boundaries (e.g. allows execution while feature flag is off in mobile, allows zero-threshold short-circuit on the bare implementation, allows the bare implementation to receive ETH that can't be recovered). | Fix before mainnet. Re-audit recommended for the fix. |
| Medium | Allows a degraded state that needs operator intervention to recover (e.g. an owner can produce a digest that fails on submit, wasting gas; an event field shape that confuses an indexer; OZ version drift that COULD silently change a primitive). | Disposition either fix-before-mainnet or accept-with-rationale; operator records the decision. |
| Low | Quality / style / readability improvements with no security impact. | Operator may bundle into a single follow-up PR or accept and document. |
| Informational | Observations or recommendations with no required action. | Operator records the disposition. |

Severities ultimately come from the auditor; the table above is the operator's reading frame for triage.
