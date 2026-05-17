# GaoSafe Genesis — Threat Model

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. This document is pessimistic by design: every "what if" listed below either maps to a concrete mitigation pinned by a test in `test/multisig/`, or is acknowledged as an audit-scope boundary (out of scope for Genesis to keep the core small and auditable). No item is "we'll make this safe in V2." Genesis is the audited institutional baseline; audit-scope boundaries are documented exclusions, not deferred work.

---

## 1. Assets

| Asset | Sensitivity | Genesis posture |
|---|---|---|
| Owner private keys | Critical — one fraction of vault authority each | Held off-chain by owners. Genesis never sees a private key, only EIP-712 signatures over a per-vault digest. |
| EIP-712 proposal digest | Public once signed | Bound to chainId, vault, nonce, expiry, full call set. A different pre-image produces a different digest, which renders existing signatures invalid. |
| Signed approval bytes | Public once submitted on-chain | Single approval cannot unlock the vault. M approvals authorise one execution. |
| Vault balance | Public | Movable only via `execTransaction` with M sorted, deduped, owner-set signatures over the right digest. |

## 2. Adversaries

Genesis assumes **at most one owner is compromised at any given moment** for the security-properties analysis. A 2-of-3 vault survives one compromise; a 3-of-5 vault survives two. The institutional-treasury sizing rule in `gaokey-mobile/docs/multisig/cold-signer-mode.md` is the operational lever for this analysis.

| Actor | Mitigation summary |
|---|---|
| Honest user | Drives the happy path; no mitigation needed. |
| Curious co-owner | Has no power beyond their fraction of authority. Cannot mutate state alone. |
| Compromised co-owner | Can sign anything on their behalf; cannot execute alone. Recovery via `replaceOwner` proposal signed by the remaining owners. |
| Malicious dApp | Cannot construct a proposal Genesis would execute without M owner signatures. Mobile-side UX prevents silent signing — see gaokey-mobile threat model. |
| Network MITM | Cannot forge digests. RPC layer is irrelevant to verifier correctness. |
| Lost/stolen device | Same as "compromised co-owner" — recovery via `replaceOwner`. |
| Supply-chain attacker | Out of scope for the contract; mitigated by audit + reproducible build + pinned OZ version. |
| State-level PQ adversary | Out of scope for Genesis. PQ-capable forgery of ECDSA is a known long-horizon threat. Out of scope for the Genesis core. Reserved tags in the mobile-side `SignatureScheme` registry exist for future audited PQ extensions. |

## 3. STRIDE — primitive-by-primitive

### 3.1 Spoofing

| Threat | Genesis mitigation | Pinning test |
|---|---|---|
| Spoofed vault address (clone EIP-712 cache confusion) | Manual `domainSeparator()` reads `address(this)` per call. Constructor of OZ EIP712 (which would cache to the implementation's address) is deliberately **not** inherited. | `eip712-parity.test.ts` P7 |
| Spoofed signer identity | `ECDSA.tryRecover` returns the recovered address from the signature over the EIP-712 digest. Any RecoverError aborts. | `GaoSafe.test.ts` #16, #18 |
| Cross-chain replay | `block.chainid` in domain AND body. | `GaoSafe.test.ts` #19 |
| Cross-vault replay | `address(this)` in domain AND body. | `GaoSafe.test.ts` #20 |

### 3.2 Tampering

| Threat | Genesis mitigation | Pinning test |
|---|---|---|
| Tampered proposal after some approvals collected | Approvals are bound to the EIP-712 digest of `(targets, values, data, expiry, nonce, chainId, vault)`. Any mutation invalidates every signature. | `GaoSafe.test.ts` #21 |
| Tampered nonce / replay | Per-vault nonce, incremented before inner calls. Replayed bundles fail digest match. | `GaoSafe.test.ts` #12 |
| Tampered EIP-712 typehash off-chain | `TX_TYPEHASH` and `_DOMAIN_TYPEHASH` are `constant` in bytecode. JS-side mirror tested in `eip712-parity.test.ts`. | `eip712-parity.test.ts` P1-P5 |

### 3.3 Repudiation

All approvals are ECDSA signatures over a deterministic digest. On-chain history (events) is authoritative. Genesis has no off-chain authority that could be repudiated.

### 3.4 Information disclosure

Genesis stores only public data (`owners`, `threshold`, `nonce`, `_initialized`). No private metadata is held on-chain. The mobile-side store mirrors this constraint.

### 3.5 Denial of service

| Threat | Genesis mitigation | Pinning test |
|---|---|---|
| Gas-grief — inner call deliberately consumes all gas to fail subsequent proposals | All-or-nothing: a single sub-call revert reverts the whole tx, including the nonce increment. Subsequent proposals start from the same nonce. | `GaoSafe.test.ts` #22 |
| Expired-proposal flood | Expiry enforced on-chain; expired bundles revert cheaply with `ProposalExpired` and consume no nonce. | `GaoSafe.test.ts` #13 |
| Threshold-too-low attack via mass `removeOwner` | `removeOwner` validates `newThreshold > 0 && newThreshold <= owners.length - 1`. `removeOwner` on last owner is impossible. | `GaoSafe.test.ts` #31, #32 |

### 3.6 Elevation of privilege

| Threat | Genesis mitigation | Pinning test |
|---|---|---|
| Non-owner attempts to sign | `isOwner[recovered]` check after recovery. | `GaoSafe.test.ts` #16 |
| Owner-set change without M-of-N | `addOwner` / `removeOwner` / `replaceOwner` / `changeThreshold` are `onlySelf`. Direct external calls revert. | `GaoSafe.test.ts` #23-#26 |
| Threshold downgrade attack | A normal multisig proposal — M owners must approve. Mobile-side policy flags every threshold decrease as `danger`. | `GaoSafe.test.ts` #30, #33 |
| Address squatting on `createVault` | Salt binds `msg.sender`. Different deployers calling with the same `clientSalt` produce different addresses. | `GaoSafeFactory.test.ts` F4 |
| Direct call to bare implementation's `setup()` | Implementation constructor sets `_initialized = true`. Bare-implementation setup reverts `AlreadyInitialized`. | `GaoSafe.test.ts` #8 |

## 4. Signature bundle invariants (all pinned)

| Invariant | Test |
|---|---|
| `sigCount == threshold` | `GaoSafe.test.ts` #17 |
| Each recovered address is an owner | `GaoSafe.test.ts` #16 |
| Strictly ascending by recovered address (rejects duplicates and unsorted) | `GaoSafe.test.ts` #14, #15 |
| Malleable signatures (high-s) rejected | Built into `ECDSA.tryRecover`. Implicit coverage across all signature tests. |
| EIP-191 (`signMessage`) signatures rejected | The EIP-191 wrap produces a different pre-image, so recovery yields a non-owner; rejected by the owner check. | `GaoSafe.test.ts` #18 |

## 5. Re-entrancy posture

Nonce is incremented **before** the inner-call loop:

```solidity
nonce = consumedNonce + 1;
_executeCalls(targets, values, data);  // can re-enter `vault.execTransaction`
```

A re-entrant `execTransaction` call would read the already-incremented `nonce` and compute a different digest; the original signatures over the old nonce would no longer recover to owners. The re-entrant call therefore reverts harmlessly. Pinned implicitly by the happy-path tests (which all succeed) plus the failed-inner-call test (#22) which proves the nonce increment is rolled back on revert.

## 6. Out of scope for Genesis (NOT residual risks — deliberate exclusions)

- **ERC-1271 contract-signer verification.** Out of scope for Genesis to keep the core small and auditable. The reserved `SignatureScheme` tag in `gaokey-mobile/src/multisig/SignatureScheme.ts` exists only for forward storage compatibility; the Genesis verifier rejects every scheme other than ECDSA-EIP712.
- **Post-quantum verification.** Out of scope for Genesis. No PQ verifier, no fake verifier ships. PQ is a separately-designed, separately-audited future capability.
- **Upgradeability.** Out of scope for Genesis. Every clone is an immutable proxy to an immutable implementation.
- **Modules / plugins / guards.** Out of scope for Genesis. Plugin systems materially expand audit surface.
- **Best-effort batch execution.** Out of scope for Genesis. All-or-nothing is the institutional default.
- **Timelock / spending limits / allowlist guard.** Out of scope for the Genesis core. Advanced policy layers may be added later only if they pass separate design review and audit and ship as their own contracts.

## 7. Residual risks acknowledged

| Residual | Mitigation status |
|---|---|
| Independent contract audit | Required by the consuming-app production-readiness gate. Not satisfied yet. |
| Bug bounty / private competitive audit | Required. Not satisfied yet. |
| Reproducible-build verification on the deployed bytecode | Required. Not satisfied yet. |
| Signer-recovery operational drill | Required (mobile-side production-readiness gate §5). Not satisfied yet. |
| Diverse-signer institutional usage | Operational, not contract-enforced. Documented in `gaokey-mobile/docs/multisig/cold-signer-mode.md`. |

Each residual risk maps to a row in `gaokey-mobile/docs/multisig/production-readiness-gate.md`. Mainnet deployment of Genesis is blocked until those rows are signed off.
