# GaoSafe Genesis — Mobile ABI Compatibility

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document is the operator- and auditor-facing reference for the ABI surface that `gaokey-mobile` consumes from `gao-contracts`. It pins the byte-identical ABI source, lists the mobile consumer's pinned commit, and explains the parity guarantees between the JS-side EIP-712 builder and the on-chain `hashTx` view.

---

## 1. ABI source-of-truth pin

| Item | Value |
|---|---|
| Source of truth (on-chain semantics) | `gao-contracts/contracts/multisig/{GaoSafe,GaoSafeFactory}.sol` |
| ABI artifacts (consumer-facing) | `gao-contracts/abis/multisig/{GaoSafe,GaoSafeFactory}.json` |
| Mobile consumer's pinned commit | `gao-contracts@ac14411` (PR #17), CI head `fe6ee43` (PR #18) |
| Mobile consumer file | [`gaokey-mobile/src/multisig/abis.ts`](../../../gaokey-mobile/src/multisig/abis.ts) |

The mobile consumer pins by **commit AND by SHA-256** of the ABI JSON. The SHA-256 pin is the byte-identical hash check; the commit pin is the human-traceable provenance.

---

## 2. SHA-256 hash pin (byte-identical check)

| File | SHA-256 |
|---|---|
| `abis/multisig/GaoSafe.json` | `ee21f7af040b2e579c7e8c2985d2e16cf51b6b84cdbd72116eda994ca13549d1` |
| `abis/multisig/GaoSafeFactory.json` | `1af102026245f187025bc716fce033f25967fc8b8b2f6fc99886573240d8a90f` |

Both hashes are mirrored in [`gaokey-mobile/src/multisig/abis.ts`](../../../gaokey-mobile/src/multisig/abis.ts) (lines 14–18). Verify:

```bash
cd gao-contracts
shasum -a 256 abis/multisig/GaoSafe.json abis/multisig/GaoSafeFactory.json
```

If either hash differs from the table above, the ABI has drifted from the mobile pin. Resolution path is documented in §6.

---

## 3. ABI entry shape

| File | Total entries | Constructor | Errors | Events | Functions | Receive |
|---|---|---|---|---|---|---|
| `GaoSafe.json` | 38 | 1 | 16 | 6 | 14 | 1 |
| `GaoSafeFactory.json` | 7 | 1 | 2 | 1 | 3 | — |

Counts mirrored in [`gaokey-mobile/src/multisig/abis.ts`](../../../gaokey-mobile/src/multisig/abis.ts) header. Counts are also pinned by [`gaokey-mobile/src/multisig/__tests__/abisShape.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/abisShape.test.ts) so any unintended drift fails mobile CI before reaching a production build.

---

## 4. Selector derivation

The mobile consumer does **NOT** hardcode selectors as literals. Every selector is derived at runtime by `ethers.Interface(GAO_SAFE_ABI).getFunction(name).selector`.

| Consequence | Why this matters |
|---|---|
| A future contract that renames a function would silently change its selector | The mobile consumer would compute a different selector — the on-chain call would revert with `function selector not recognised`, failing loudly rather than silently sending to the wrong selector. |
| A future contract that re-types a parameter (e.g. `uint256` → `uint128`) would change the selector | Same — fails loud. |
| The locked address-literal guardrail prevents an out-of-band selector copy | [`src/multisig/__tests__/noAddressLiterals.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/noAddressLiterals.test.ts) refuses any hex literal of address shape; a future contributor cannot bypass selector derivation by pasting bytes. |

The two non-derived selectors in mobile policy code (`ERC20_APPROVE_SELECTOR = 0x095ea7b3`, `ERC20_TRANSFER_SELECTOR = 0xa9059cbb`) are not GaoSafe selectors — they are the standard ERC-20 ABI and are hand-verified by [`src/multisig/__tests__/MultisigPolicy.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/MultisigPolicy.test.ts).

---

## 5. EIP-712 digest parity (JS ↔ contract)

The mobile-side `ProposalBuilder.buildDigest(...)` is byte-equal to the on-chain `GaoSafe.hashTx(...)` view. Parity is enforced by a transitive chain:

```
gaokey-mobile/ProposalBuilder.buildDigest(...)
        ↑ byte-equal (mobile parity test ProposalBuilder.test.ts)
ethers TypedDataEncoder.hash(domain, types, message)
        ↑ byte-equal (contract parity test GaoSafe.eip712-parity.test.ts P1–P7)
GaoSafe.hashTx(targets, values, data, expiry, nonce)
```

Therefore: `gaokey-mobile/ProposalBuilder.buildDigest(...)` is byte-equal to `GaoSafe.hashTx(...)` by transitivity. Either test failing breaks the chain.

| Pinning point | Test |
|---|---|
| JS builder ↔ ethers oracle | [`gaokey-mobile/src/multisig/__tests__/ProposalBuilder.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/ProposalBuilder.test.ts) |
| ethers oracle ↔ contract `hashTx` | [`test/multisig/GaoSafe.eip712-parity.test.ts`](../../test/multisig/GaoSafe.eip712-parity.test.ts) P1–P7 |
| JS calldata ↔ ABI-encoded executor calldata | [`gaokey-mobile/src/multisig/__tests__/ProposalExecutor.calldataParity.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/ProposalExecutor.calldataParity.test.ts) |
| Cross-clone domain-separator independence | `GaoSafe.eip712-parity.test.ts` P7 (two clones on same chain produce different separators) |

---

## 6. Constants mirrored on both sides

Manually verified to be byte-equal between mobile and contract:

| Constant | Contract location | Mobile location | Value |
|---|---|---|---|
| EIP-712 `name` | `GaoSafe.sol:65` → `_NAME_HASH = keccak256(bytes("GaoSafe"))` | [`ProposalBuilder.ts:77`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L77) → `NAME_HASH = keccak256(toUtf8Bytes('GaoSafe'))` | `"GaoSafe"` |
| EIP-712 `version` | `GaoSafe.sol:68` → `_VERSION_HASH = keccak256(bytes("1"))` | [`ProposalBuilder.ts:80`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L80) → `VERSION_HASH = keccak256(toUtf8Bytes('1'))` | `"1"` |
| Domain typehash string | `GaoSafe.sol:62` | [`ProposalBuilder.ts:70-74`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L70) | `"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"` |
| `TX_TYPEHASH` string | `GaoSafe.sol:73-75` | [`ProposalBuilder.ts:83-87`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L83) | `"GaoMultisigTx(uint256 chainId,address vault,uint256 nonce,bytes32 targetsHash,bytes32 valuesHash,bytes32 dataHash,uint256 expiry)"` |
| EIP-712 prefix | `GaoSafe.sol:224` → `hex"1901"` | [`ProposalBuilder.ts:252`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L252) → `concat(['0x1901', ...])` | `0x1901` |
| `targetsHash` formula | `GaoSafe.sol:240` → `keccak256(abi.encodePacked(targets))` (each address left-padded to 32 bytes per Solidity array tuple-encoding) | [`ProposalBuilder.ts:152-156`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L152) | Same — addresses-in-arrays are 32 bytes, not 20. Audit lesson captured inline in `GaoSafe.sol` and `ProposalBuilder.ts`. |
| `valuesHash` formula | `GaoSafe.sol:241` | [`ProposalBuilder.ts:162-169`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L162) | `keccak256(concat(uint256[]))`, each element 32 bytes |
| `dataHash` formula | `GaoSafe.sol:243-248` | [`ProposalBuilder.ts:179-183`](../../../gaokey-mobile/src/multisig/ProposalBuilder.ts#L179) | Two-stage: per-element `keccak256(data[i])` then `keccak256(concat(those bytes32s))` |
| Bundle layout | `GaoSafe.sol:320` → `signatures.length == 65 * threshold` | [`ProposalExecutor.ts:201-213`](../../../gaokey-mobile/src/multisig/ProposalExecutor.ts#L201) → sorted-ascending concat of 65-byte slices | Same |

---

## 7. Forward-compatible storage tags (NOT on the live path)

The mobile-side [`SignatureScheme`](../../../gaokey-mobile/src/multisig/SignatureScheme.ts) and [`ApprovalBundleExtensions`](../../../gaokey-mobile/src/multisig/types.ts) carry forward-compatible tags so storage and UI layers can persist alternate-scheme approvals without a breaking change later. The Genesis verifier IGNORES them.

| Tag | Live path treatment |
|---|---|
| `ecdsa_secp256k1_eip712` | LIVE — accepted by Genesis verifier. |
| `erc1271_contract` | RESERVED — never reaches the bundle. PR 10 mobile hardening additionally rejects any live-tagged approval that ALSO carries a reserved `bundle` object, preventing scheme-tag confusion. |
| `future_pq_signature` | RESERVED — never reaches the bundle. |

Pinned by [`gaokey-mobile/src/multisig/__tests__/pqRejection.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/pqRejection.test.ts).

---

## 8. Versioning constants

These exist in the **mobile** types, NOT in the contract — the contract is the source of truth for what it accepts, and only one accepted shape exists today.

| Constant | Mobile location | Value | Bumped when |
|---|---|---|---|
| `PROPOSAL_VERSION` | `types.ts:34` | `1` | Proposal payload shape changes in a non-backward-compatible way (e.g. a per-call policy reference, a co-signature bundle pointer in the proposal itself) — requires a new contract |
| `SIGNATURE_BUNDLE_VERSION` | `types.ts:44` | `1` | On-chain accepted signature format changes (e.g. an ECDSA + post-quantum co-signature bundle) — requires a new contract |

Both pins are documented in `gao-safe-design.md` §5.

---

## 9. Procedure for an ABI bump

When a future audited contract release changes `GaoSafe.sol` or `GaoSafeFactory.sol`:

1. Land the contract change on `gao-contracts/main` via a reviewed PR.
2. Re-export the ABI: `npx ts-node scripts/multisig/exportGaoSafeAbi.ts` (or whatever the canonical export script is at the time).
3. Verify SHA-256 of the new ABI artifacts.
4. Open a single-purpose PR on `gaokey-mobile` that:
   - Updates [`gaokey-mobile/src/multisig/abis.ts`](../../../gaokey-mobile/src/multisig/abis.ts) header: bump source commit, CI head, and both SHA-256 hashes.
   - Updates the inline ABI arrays byte-identically.
   - Updates [`gaokey-mobile/src/multisig/__tests__/abisShape.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/abisShape.test.ts) entry counts if the shape changed.
   - Updates [`gaokey-mobile/src/multisig/__tests__/abisPinned.test.ts`](../../../gaokey-mobile/src/multisig/__tests__/abisPinned.test.ts) shape comparison if needed.
   - Body links the audit report (for an audit-tracked release) AND the bytecode hash of the new implementation singleton.
5. Reviewer-sign-off from engineering AND security.
6. CI on the mobile PR runs the full multisig test suite — any mismatch breaks here, before reaching a production build.

The procedure is intentionally heavy. The ABI is the integration surface; drift between the two repos is the failure mode this checklist exists to prevent.

---

## 10. Current compatibility status (audit-prep snapshot)

| Check | Current value | Status |
|---|---|---|
| ABI sha256 (contract repo) matches mobile pin | Both files byte-identical | ✅ Match |
| Mobile pin commit reachable on `gao-contracts` history | `ac14411` is on `main` (PR #17) | ✅ Reachable |
| `gao-contracts` HEAD beyond mobile pin | `a9e98a5` (PR #19, advisory tests only — no contract change) | ✅ No mobile-incompatible drift |
| Mobile multisig tests on latest mobile `main` | 311 / 311 passing | ✅ Green |
| Contract multisig tests on latest contract `main` | 70 / 70 passing (39 + 10 + 7 + 14) | ✅ Green |
| Address-literals guardrail (both sides) | Active | ✅ |

If any row flips from ✅ to ❌, the gate is **closed** until the drift is investigated and a corrective PR lands.
