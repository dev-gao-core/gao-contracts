# GaoSafe Genesis — Pre-answered Auditor Questions

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document anticipates questions an auditor is likely to ask in the kick-off Q&A and answers them in writing so the call can focus on auditor-specific concerns. Every answer links to the doc / source / test that backs it.

---

## 1. Architecture and scope

### Q1.1 — "Is this MPC / TSS / threshold signing?"

**No.** GaoSafe Genesis is **classic on-chain Safe-style M-of-N multisig** with **independent EOA owners**. Each owner holds a separate private key on their own device. The contract verifies M ECDSA signatures over the EIP-712 digest — there is no key share, no DKG, no threshold-signature protocol.

A future MPC/TSS layer MAY participate as a single owner in the vault's owner set (the contract sees one address and does not care that the signature was produced by a multi-party protocol). Designing that MPC layer is a **separate project** outside this audit scope.

Backing: [gao-safe-design.md](./gao-safe-design.md) §1, [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §1 (row "MPC / TSS"), `GaoSafe.sol:1-52` contract header.

### Q1.2 — "Why is this contract not upgradeable?"

To keep the audit surface small and the trust model tight. Every vault is an immutable clone of an immutable singleton; there is no admin, no proxy delegatecall target trust, no storage layout migration concern. If an upgrade is ever needed, the path is "deploy a new audited contract; existing vaults remain on Genesis indefinitely" — never an in-place upgrade.

Backing: [gao-safe-design.md](./gao-safe-design.md) §4 (audit-scope boundary table).

### Q1.3 — "Why no modules / plugins?"

Plugin systems are historically a major source of multisig vulnerabilities — Safe modules have repeatedly been the surface where bugs land. Genesis intentionally has no hook surface so the audit can focus on the core M-of-N primitive.

If module-like capability is ever needed, it ships as a separate contract that an audited vault MAY interact with, NOT as a plugin extension of the vault itself.

Backing: [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §1.

### Q1.4 — "Why no ERC-1271 execution?"

The Genesis verifier accepts only EOA ECDSA signatures over the EIP-712 digest. The mobile-side `SignatureScheme` type reserves an `erc1271_contract` tag for forward STORAGE compatibility (so a future contract upgrade could ship and the existing approval rows from before the upgrade remain readable), but the Genesis verifier still rejects it.

Adding ERC-1271 execution introduces a `staticcall` to an attacker-influenceable address inside the verification path. That is a class of historical multisig vulnerabilities. Adding it requires a separate audit.

Backing: [`gaokey-mobile/src/multisig/SignatureScheme.ts`](../../../gaokey-mobile/src/multisig/SignatureScheme.ts) `LIVE_SIGNATURE_SCHEME`, [`test/multisig/GaoSafe.test.ts`](../../test/multisig/GaoSafe.test.ts) #16.

---

## 2. EIP-712 and clone safety

### Q2.1 — "Why manual EIP-712 instead of OpenZeppelin's EIP712 base?"

OZ's `EIP712.sol` caches the domain separator and `address(this)` in immutable variables initialised in its constructor. That constructor never runs for an EIP-1167 minimal proxy, so cached values would reflect the singleton's address rather than the clone's. The result would be every clone producing the **same** domain separator (incorrect; cross-vault replay protection would silently break).

The manual implementation computes the domain separator on every call from `block.chainid` and `address(this)`, both of which resolve correctly inside a clone's delegatecall.

Backing: [`GaoSafe.sol:41-52`](../../contracts/multisig/GaoSafe.sol#L41) (header doc), [`GaoSafe.sol:205-215`](../../contracts/multisig/GaoSafe.sol#L205) (`domainSeparator()` implementation), [`test/multisig/GaoSafe.eip712-parity.test.ts`](../../test/multisig/GaoSafe.eip712-parity.test.ts) P7 (clone-safety pin: two clones on same chain produce different domain separators).

### Q2.2 — "Why are `chainId` and `vault` duplicated in BOTH the domain separator AND the struct body?"

Defence in depth. The domain separator alone is sufficient for cross-chain and cross-vault replay protection. The duplication into the struct body makes any tooling-side mistake (e.g. an off-chain builder that forgot to bind `chainId` into the domain) impossible to mask: the digest would simply not match what the contract recomputes, signatures would fail to recover to owners, and `NotAnOwner` would revert.

Backing: [gao-safe-design.md](./gao-safe-design.md) §7, [`GaoSafe.sol:73-75`](../../contracts/multisig/GaoSafe.sol#L73) `TX_TYPEHASH`, [`GaoSafe.sol:250-261`](../../contracts/multisig/GaoSafe.sol#L250).

### Q2.3 — "Why is `targetsHash` computed with each address padded to 32 bytes?"

Solidity's `abi.encodePacked(T[])` uses standard 32-byte tuple encoding for every array element — only primitive scalars get the short packed form. Addresses-in-arrays are 32 bytes, NOT 20.

The JS-side mirror in [`gaokey-mobile/src/multisig/ProposalBuilder.ts:152-156`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L152) and [`test/multisig/helpers/eip712.ts`](../../test/multisig/helpers/eip712.ts) follow the same convention. P1–P5 of `GaoSafe.eip712-parity.test.ts` pin the byte-equality.

This is a known footgun for off-chain builders that mistakenly use 20-byte packed addresses. The audit lesson is captured inline at `GaoSafe.sol:240-247`.

---

## 3. Initialization and clone hardening

### Q3.1 — "How is the bare implementation singleton protected from a direct `setup()` call?"

The implementation's constructor sets `_initialized = true`. Any subsequent call to `setup()` on the bare singleton reverts `AlreadyInitialized`. Clones do NOT run the constructor (they delegate-call into the singleton's runtime bytecode), so each clone starts with default storage and `_initialized == false`, exactly as required for one-shot init.

Backing: [`GaoSafe.sol:157-160`](../../contracts/multisig/GaoSafe.sol#L157) (constructor), [`GaoSafe.sol:169-170`](../../contracts/multisig/GaoSafe.sol#L169) (setup guard), [`test/multisig/GaoSafe.test.ts`](../../test/multisig/GaoSafe.test.ts) #8.

### Q3.2 — "What stops a non-factory-deployed clone from being used uninitialised?"

`execTransaction` has a NotSetup guard at the very top:

```solidity
if (!_initialized || threshold == 0 || _owners.length == 0) revert NotSetup();
```

Two scenarios this catches:

1. The bare implementation singleton has `_initialized = true` but `threshold == 0` and `_owners.length == 0`. Without this guard, a zero-length signature bundle would pass `signatures.length == 65 * 0` and the inner-call loop would execute on the implementation.
2. A manually-deployed EIP-1167 clone that bypassed the factory and never had `setup()` called. Such a clone has `_initialized == false`, `threshold == 0`, `_owners.length == 0`.

Either form reverts before any other check.

Backing: [`GaoSafe.sol:287-308`](../../contracts/multisig/GaoSafe.sol#L287), tests #37 and #38 in `GaoSafe.test.ts`.

### Q3.3 — "What about ETH sent to the bare implementation?"

`receive()` reverts `ImplementationCannotReceiveEth` when `address(this) == _IMPLEMENTATION_SELF`. `_IMPLEMENTATION_SELF` is an immutable assigned in the constructor; immutables live in **runtime bytecode**, NOT storage, so every clone reads the same baked-in singleton address through delegatecall. A clone's `address(this)` resolves to the clone, which is NOT equal to `_IMPLEMENTATION_SELF`, so the clone accepts ETH normally.

This is subtle and worth reading carefully. The property that makes it work is precisely "immutables are bytecode-baked, not storage-baked".

Backing: [`GaoSafe.sol:126-160`](../../contracts/multisig/GaoSafe.sol#L126) (immutable + constructor), [`GaoSafe.sol:478-480`](../../contracts/multisig/GaoSafe.sol#L478) (`receive()`), tests #36 (clone ETH ingress accepted) and #39 (singleton ETH ingress refused).

---

## 4. Signature bundle verification

### Q4.1 — "Why does `tryRecover` error collapse to `NotAnOwner`?"

When `ECDSA.tryRecover` returns any error code (`InvalidSignature`, `InvalidSignatureLength`, `InvalidSignatureS`, `InvalidSignatureV` in OZ 5.x), `_verifySignatures` reverts with `NotAnOwner` — not with a distinct error.

This is intentional. Distinguishing "malformed signature" from "signature recovered to a non-owner" would create a digest-mutation oracle: an attacker who can probe the contract with crafted signatures could learn whether a digest is signable by *any* owner without committing the bundle.

Backing: [`GaoSafe.sol:340-356`](../../contracts/multisig/GaoSafe.sol#L340), [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.10.

### Q4.2 — "Why strict-ascending sort with `recovered <= prev` revert?"

Strict-ascending sort serves two purposes:

1. **Deduplication.** `recovered == prev` would mean a duplicate signer; both `recovered < prev` (unsorted) and `recovered == prev` (duplicate) revert with `SignaturesNotSorted`. A single check covers both cases.
2. **O(threshold) verification without a seen-set.** The sort property lets the verifier check membership in O(threshold) time without maintaining a Set<address> in memory.

Backing: [`GaoSafe.sol:340-356`](../../contracts/multisig/GaoSafe.sol#L340), tests #14 (duplicate) and #15 (unsorted) in `GaoSafe.test.ts`.

### Q4.3 — "Why is the nonce incremented BEFORE the inner calls?"

Re-entrancy safety. If an inner call could re-enter `execTransaction` on the same vault, it would see `nonce = consumedNonce + 1` (the next nonce, not the consumed one). A replay attempt with the original signatures would fail digest match. The re-entrant `execTransaction` would need a fresh bundle signed over `consumedNonce + 1`.

In practice, no current proposal flavour re-enters the vault — but the ordering is the defence-in-depth that survives a future inner-call shape that does.

Backing: [`GaoSafe.sol:323-333`](../../contracts/multisig/GaoSafe.sol#L323), invariant I1 (`GaoSafe.invariants.test.ts`).

### Q4.4 — "What happens if an inner call reverts?"

The whole `execTransaction` reverts with `ExecutionFailed(callIndex, reason)`. The nonce increment is rolled back along with all state changes. The submitter pays gas for the failed attempt; the next attempt starts from the same nonce.

This is the all-or-nothing institutional default. Best-effort batch execution is intentionally out of scope (partial-state outcomes are a class of accounting bugs).

Backing: [`GaoSafe.sol:363-374`](../../contracts/multisig/GaoSafe.sol#L363), test #22 in `GaoSafe.test.ts`.

---

## 5. Owner-set mutations

### Q5.1 — "How is `addOwner` / `removeOwner` / `replaceOwner` / `changeThreshold` protected?"

All four are `onlySelf`. The modifier checks `msg.sender == address(this)`, which is true only when `execTransaction`'s inner-call loop calls back into the vault. That inner call requires M signatures to have already been collected and verified.

In other words: there is no way to mutate the owner set or threshold without a multisig proposal that itself reaches threshold.

Backing: [`GaoSafe.sol:383-386`](../../contracts/multisig/GaoSafe.sol#L383) (modifier), [`GaoSafe.sol:390-461`](../../contracts/multisig/GaoSafe.sol#L390) (four mutators), tests #23–#26 (external rejections), #27–#30 (via-proposal happy paths).

### Q5.2 — "Can the vault be bricked by removing too many owners?"

Several layers prevent this:

| Layer | Enforcement |
|---|---|
| `LastOwnerCannotBeRemoved` | `removeOwner` reverts when `_owners.length == 1`. |
| Threshold validity | After every owner-set mutation, `threshold` is re-validated: `0 < newThreshold <= newLength`. |
| Mobile-side policy | Mobile policy classifier flags every `remove_owner` and every threshold decrease as `danger` so the UI requires explicit confirmation. |
| Operational rule | The mobile-side cold-signer-mode doc (`gaokey-mobile/docs/multisig/cold-signer-mode.md`) recommends 2-of-3 minimum for treasury. |

Backing: [`GaoSafe.sol:408-431`](../../contracts/multisig/GaoSafe.sol#L408), tests #31 and #32.

### Q5.3 — "Does `removeOwner`'s swap-and-pop change visible owner order?"

Yes. Removal swaps the target with the last element, then pops. `getOwners()` returns the array in current storage order, which is NOT guaranteed stable across `removeOwner` calls.

This is intentional and documented. Threshold logic and authorisation checks use the `isOwner` map, not array order. Consumers that need a stable order MUST sort client-side.

Backing: [`GaoSafe.sol:408-431`](../../contracts/multisig/GaoSafe.sol#L408), [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.9.

---

## 6. Factory and CREATE2

### Q6.1 — "Why is the CREATE2 salt bound to `msg.sender`?"

To prevent address squatting. If the salt were just `clientSalt`, a third-party observer of a deployer's pending `clientSalt` could front-run with the same salt and claim the predicted vault address. Binding `msg.sender` into the salt means a different deployer with the same `clientSalt` produces a different address.

Backing: [`GaoSafeFactory.sol:14-23`](../../contracts/multisig/GaoSafeFactory.sol#L14) (header doc), [`GaoSafeFactory.sol:68`](../../contracts/multisig/GaoSafeFactory.sol#L68) (`salt = keccak256(abi.encode(msg.sender, clientSalt))`), invariants I9a (prediction matches) and I9b (different deployers different addresses) in `GaoSafeFactory.fuzz-create2.test.ts`.

### Q6.2 — "Can the factory be re-pointed at a different implementation?"

No. `implementation` is `immutable`, set in the constructor to a freshly-deployed singleton. There is no setter. The factory itself is ownerless and has no admin function.

Backing: [`GaoSafeFactory.sol:31-51`](../../contracts/multisig/GaoSafeFactory.sol#L31).

### Q6.3 — "Can two callers with the same `(deployer, clientSalt)` deploy twice?"

No. `Clones.cloneDeterministic` reverts on address collision. The deployer-binding plus the `cloneDeterministic` revert mean each `(deployer, clientSalt)` is single-use.

Backing: [`GaoSafeFactory.sol:63-72`](../../contracts/multisig/GaoSafeFactory.sol#L63), OZ `Clones.cloneDeterministic` semantics.

---

## 7. Dependencies and toolchain

### Q7.1 — "Why does `package.json` declare `@openzeppelin/contracts: ^5.0.2` while `package-lock.json` resolves `5.6.1`?"

The caret pin allows minor bumps within the 5.x line. The resolved version (`5.6.1`) is what the audit-target commit actually compiles against. Tests on the audit-target commit pass with `5.6.1`.

Tightening to an exact pin is deferred to the **post-audit deployment-runbook PR**. The auditor MAY recommend tightening; the operator's intent is to land an exact pin in the same PR that adds the first factory address to `gaokey-mobile/src/multisig/config.ts` (which is itself a single-purpose, reviewer-signed-off PR per the locked rule there).

Backing: [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.1.

### Q7.2 — "Why is Slither advisory rather than a required check?"

A Slither minor bump can introduce new detectors that fire on unchanged code. Making Slither required would let those new detectors block unrelated PRs. The workflow is structured with `continue-on-error: true` so the run uploads its report as an artifact (auditor MAY consult) but never gates merges.

Escalation to a required check is deferred until a zero-finding baseline has been observed across N consecutive PRs.

Backing: [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) §3-§5, [gao-safe-ci-hardening.md](./gao-safe-ci-hardening.md).

### Q7.3 — "Why are `naming-convention` and `solc-version` detectors excluded from Slither?"

| Detector | Exclusion rationale |
|---|---|
| `naming-convention` | Project follows the convention documented in `CLAUDE.md` and `gao-safe-design.md` (e.g. internal members prefixed with underscore, immutables in SCREAMING_SNAKE). |
| `solc-version` | The 0.8.24 pin is intentional and audit-tracked; the detector would fire on every PR even though the pin is locked. |

Backing: [`slither.config.json`](../../slither.config.json), [gao-safe-static-analysis.md](./gao-safe-static-analysis.md) §1.

---

## 8. Deployment and operations

### Q8.1 — "Where are the deploy scripts for `GaoSafeFactory`?"

Not in this repo. The deployment runbook is a separate, operator-only PR that lands AFTER the audit closes. It will follow the existing pattern from `scripts/deployGaoDomainDepositV3.devtest.ts`: chain-id allowlist + mainnet banlist + dry-run mode + public-address-only output. The auditor MAY include recommended safety rails in the report; the operator will fold them into the runbook PR.

Backing: [known-issues-and-nongoals.md](./known-issues-and-nongoals.md) §2.6.

### Q8.2 — "What's the plan for per-chain factory addresses?"

Each per-chain factory address is added to `gaokey-mobile/src/multisig/config.ts` via a single-purpose PR that:

1. Links the audit report.
2. Links the implementation singleton bytecode hash for the target chain.
3. Carries an `allow-address-literal:` sentinel on the same line as the address.
4. Is reviewer-signed-off by both engineering AND security.
5. Re-validates the address-literals guardrail on both repos.

Until then, `MULTISIG_FACTORY_BY_CHAIN` is `Object.freeze({})` and `MULTISIG_FEATURE_ENABLED` is `false as const`.

Backing: [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) §9, [`gaokey-mobile/src/multisig/config.ts`](../../../gaokey-mobile/src/multisig/config.ts).

### Q8.3 — "How does an owner key get rotated?"

Through a `replaceOwner(oldOwner, newOwner)` proposal signed by M of the current owners. Genesis has no backdoor for unilateral rotation. This is by design — the security model rests on M-of-N authority, not on any operator-side admin.

If `M` of the current owners are unavailable (e.g. enough keys lost simultaneously), the vault is bricked. The threshold sizing rule (2-of-3 / 3-of-5 minimum for treasury) is the operational mitigation.

Backing: [gao-safe-design.md](./gao-safe-design.md) §9 (Recovery model).

---

## 9. Mobile compatibility

### Q9.1 — "How is the ABI kept in sync with mobile?"

Mobile pins the ABI by **commit SHA AND by SHA-256 of the ABI JSON**. The commit pin is human-traceable provenance; the SHA-256 pin is the byte-identical check. The current pin is `gao-contracts@ac14411`; the audit-target commit (`bf48bdf`) does NOT change either ABI file, so the SHA-256 hashes still match.

When a future audited release changes the ABI, the bump procedure documented in [mobile-abi-compatibility.md](./mobile-abi-compatibility.md) §9 ensures the mobile pin is updated in lockstep.

### Q9.2 — "Does the mobile app actually use these contracts today?"

No. The mobile-side feature flag `MULTISIG_FEATURE_ENABLED` is `false as const`. Every code path that would broadcast a transaction is gated on this flag and throws `FeatureNotEnabled` before any RPC call. The three multisig routes (`app/(app)/multisig/index.tsx`, `vault/[address].tsx`, `proposal/[id].tsx`) are registered with `href: null` so they are not promoted to a bottom tab and have no visible entry point. There is no Account/Profile row, Home card, or Explore tile that links to them.

In short: the mobile app ships the multisig code and tests, but the user cannot reach any execute / deploy / sign path. This is enforced at compile time by the `false as const` flag.

Backing: [`gaokey-mobile/src/multisig/config.ts`](../../../gaokey-mobile/src/multisig/config.ts), [`gaokey-mobile/app/(app)/multisig/index.tsx`](../../../gaokey-mobile/app/%28app%29/multisig/index.tsx), [`gaokey-mobile/app/(app)/__tests__/noMultisigEntryPoint.test.ts`](../../../gaokey-mobile/app/%28app%29/__tests__/noMultisigEntryPoint.test.ts).

---

## 10. Process

### Q10.1 — "What's the protocol for in-window questions?"

Single named operator contact via the engagement-letter delivery channel. Do NOT use GitHub Issues for audit communication.

### Q10.2 — "Can the operator land changes during the audit window?"

Docs under `docs/multisig/` MAY be updated. Solidity, ABI, hardhat config, package-lock, and mobile config are FROZEN. Material exceptions follow the protocol in [audit-scope-statement.md](./audit-scope-statement.md) §9 and [pre-audit-freeze.md](./pre-audit-freeze.md).

### Q10.3 — "What happens if the auditor finds something during a casual read that isn't a finding?"

Send it to the operator via the engagement-letter channel. The operator will categorise it as either:

- A finding (will be triaged per the workflow in [external-audit-handoff.md](./external-audit-handoff.md) §6).
- A doc clarification (operator updates the relevant `docs/multisig/` page; auditor confirms the clarification matches their understanding).
- A non-issue (operator documents the resolution in writing).
