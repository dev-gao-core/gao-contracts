# GaoSafe Genesis — Design

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until an independent smart-contract audit and the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) are satisfied.

---

## 1. Purpose

GaoSafe Genesis is the **institutional-baseline M-of-N multisign vault** contract for the Gao platform. It is designed to clear independent audit as the production custody primitive — not as a stepping stone, not as an MVP, not as a "we'll make it secure in V2."

The companion gaokey-mobile app (PR #99 merged the docs + types in `src/multisig/`) will consume the ABI emitted from this contract at a pinned commit sha. There is one source of truth per concern:

| Concern | Source of truth |
|---|---|
| On-chain semantics | This repository (`gao-contracts/contracts/multisig/*.sol`) |
| TypeScript types and policy | `gaokey-mobile/src/multisig/` |
| ABI handed to the mobile app | `gao-contracts/abis/multisig/*.json` (committed alongside the Solidity) |

---

## 2. Genesis is complete; the omissions are audit-scope boundaries

Genesis ships the **complete** institutional-grade security primitive set required to operate a multisign treasury. The capabilities listed under §4 ("excluded by design") are **not** "deferred to V2" — they are deliberate boundaries that keep the audit surface small and reviewable.

If a boundary capability is ever added in a future release, that release will:
- Arrive as a separate, audited contract (not a patch to the Genesis core).
- Have its own design review, threat model, and test matrix.
- Have its own audit and bug-bounty window before any mainnet enablement.

---

## 3. What Genesis includes (production-grade from day one)

| Primitive | Implementation |
|---|---|
| M-of-N threshold | `threshold: uint256`, validated `0 < threshold ≤ owners.length` |
| Strict owner validation | Zero-address rejected · duplicate rejected · zero-count rejected · validated on every owner-set mutation |
| Threshold validation | Validated at `setup`, `addOwner`, `removeOwner`, `changeThreshold` |
| Nonce replay protection | Per-vault `nonce`, incremented **before** inner calls, baked into the EIP-712 digest |
| Expiry | `uint256 expiry` in the typed-data body; rejected on-chain when `block.timestamp > expiry` |
| EIP-712 typed-data only | `TX_TYPEHASH` over `(chainId, vault, nonce, targetsHash, valuesHash, dataHash, expiry)` |
| EIP-191 / `signMessage` rejection | Digest separation makes any EIP-191 signature recover to a non-owner address; rejected by the owner check |
| Sorted signatures ascending | Strict `prev < curr` check on every recovered signer |
| Duplicate signer rejection | Implied by strict ascending — equality reverts |
| Non-owner signer rejection | Every recovered address checked against `isOwner` |
| Cross-chain replay protection | `block.chainid` baked into BOTH the EIP-712 domain separator AND the message body |
| Cross-vault replay protection | `address(this)` in the domain separator AND in the message body |
| All-or-nothing batch execution | Any sub-call revert reverts the whole transaction; nonce increment rolled back |
| Nonce increment before inner calls | Re-entrancy-safe ordering |
| Owner-set mutation only via self-call | `onlySelf` modifier on `addOwner` / `removeOwner` / `replaceOwner` / `changeThreshold` |
| Factory CREATE2 deployment | `Clones.cloneDeterministic` from a constructor-deployed locked implementation singleton |
| Deployer-bound salt | `keccak256(abi.encode(msg.sender, clientSalt))` prevents address squatting |
| Deterministic address prediction | `computeVaultAddress(deployer, clientSalt)` returns the exact post-deploy address |
| Implementation singleton lock | Constructor sets `_initialized = true`; bare singleton rejects direct `setup()` |
| Clone-safe EIP-712 | Manual `domainSeparator()` + `_hashTypedData(structHash)`; no inheritance of OZ's clone-unsafe `EIP712.sol` |
| Last-owner removal block | `removeOwner` reverts when `owners.length == 1` |

Every primitive has a pinning test under `test/multisig/`. See `gao-safe-test-plan.md`.

---

## 4. What Genesis excludes by design (and why)

Each exclusion is an **audit-scope boundary**, not a deferral. Each may be added later only if it passes a separate design review and audit and ships as its own contract.

| Exclusion | Reason |
|---|---|
| Upgradeability | Out of scope for Genesis to keep the core small and auditable. Every vault is an immutable clone of an immutable implementation. |
| Modules / plugins | Out of scope for Genesis to keep the core small and auditable. Plugin systems materially expand audit surface and are themselves a class of historical multisig vulnerabilities. |
| Best-effort batch execution | Out of scope for Genesis. All-or-nothing is the institutional default; partial-state outcomes are a class of accounting bugs. |
| ERC-1271 execution path | Out of scope for Genesis. The reserved `SignatureScheme` tag in `gaokey-mobile` exists for forward storage compatibility only; the Genesis verifier rejects every scheme other than ECDSA-EIP712. |
| Post-quantum verifier | Out of scope for Genesis. No PQ crypto, no fake verifier ships. PQ is a separately-designed, separately-audited future addition. |
| Timelock | Out of scope for the Genesis core. Timelocks belong in an explicit, separately-audited policy layer that may sit alongside the core later. |
| Spending limits | Same. |
| Allowlist / denylist guard | Same. |
| MEV / private-mempool execution | Out of scope for the Genesis core; an operational concern. |
| Gas-sponsored execution / relayers | Out of scope for Genesis. The submitter pays gas in Genesis. |

---

## 5. Versioning constants and what they actually mean

`gaokey-mobile/src/multisig/types.ts` pins:

```ts
export const PROPOSAL_VERSION = 1 as const
export const SIGNATURE_BUNDLE_VERSION = 1 as const
```

These are **version anchors for a multi-decade vault product**. They exist for long-term audit-safe compatibility and future migrations. They do **not** imply Genesis is a temporary or weak release.

| Pin | Bumps when | Genesis value |
|---|---|---|
| `PROPOSAL_VERSION` | Proposal payload shape changes in a non-backward-compatible way (e.g. carrying a per-call policy reference, or a co-signature bundle pointer in the proposal itself) | 1 |
| `SIGNATURE_BUNDLE_VERSION` | On-chain accepted signature format changes (e.g. an ECDSA + post-quantum co-signature bundle accepted by a future audited contract) | 1 |

Storage and UI layers persist both versions alongside every proposal and approval so a single device can correctly surface mixed-version histories after a future contract release.

---

## 6. EIP-712 (manual, clone-safe)

Genesis implements EIP-712 **manually** rather than inheriting `@openzeppelin/contracts/utils/cryptography/EIP712.sol`. OZ's EIP712 caches the domain separator and `address(this)` in immutable variables initialised in its constructor; that constructor never runs for an EIP-1167 minimal proxy, so cached values would reflect the singleton implementation rather than the clone. The manual implementation below computes the domain separator on every call from `block.chainid` and `address(this)`, both of which resolve correctly inside a clone's delegatecall.

```solidity
bytes32 private constant _DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
bytes32 private constant _NAME_HASH    = keccak256(bytes("GaoSafe"));
bytes32 private constant _VERSION_HASH = keccak256(bytes("1"));

function domainSeparator() public view returns (bytes32) {
    return keccak256(
        abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
    );
}

function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
    return keccak256(abi.encodePacked(hex"19_01", domainSeparator(), structHash));
}
```

The three `constant` values live in **bytecode**, not storage — they are baked into the implementation's runtime bytecode and are reached through `delegatecall` identically by every clone. Pinned by `test/multisig/GaoSafe.eip712-parity.test.ts` cases P1–P7. Case P7 specifically asserts that two clones on the same chain produce **different** domain separators (proves `address(this)` resolves per-clone, not from a cache).

---

## 7. TX_TYPEHASH

```
GaoMultisigTx(
  uint256 chainId,
  address vault,
  uint256 nonce,
  bytes32 targetsHash,
  bytes32 valuesHash,
  bytes32 dataHash,
  uint256 expiry
)
```

`chainId` and `vault` appear in BOTH the domain separator AND the message body. This is defence in depth: cross-chain replay is rejected at the domain layer; cross-vault replay is rejected at the domain layer too. The duplicate fields in the body make any tooling-side mistake (e.g. an off-chain builder that forgot to bind `chainId`) impossible to mask.

Sub-hashes:

| Field | Computation |
|---|---|
| `targetsHash` | `keccak256(abi.encodePacked(targets))` — each address in `address[]` is encoded as **32 bytes** (Solidity's `encodePacked` of an array uses standard 32-byte tuple encoding for every element, not the short form for primitive scalars) |
| `valuesHash` | `keccak256(abi.encodePacked(values))` — each uint256 is 32 bytes |
| `dataHash` | `keccak256(abi.encodePacked(keccak256(data[0]), keccak256(data[1]), ...))` — each pre-hash is bytes32 (32 bytes per element) |

The JS-side mirror in `test/multisig/helpers/eip712.ts` computes these byte-identically. Pinned by P1–P5.

---

## 8. Lifecycle

```
GaoSafeFactory.constructor()
    └─→ implementation = new GaoSafe()
        └─→ implementation._initialized = true   (locks the singleton)

GaoSafeFactory.createVault(owners, threshold, clientSalt)
    └─→ salt = keccak256(abi.encode(msg.sender, clientSalt))
    └─→ vault = Clones.cloneDeterministic(implementation, salt)
    └─→ vault.setup(owners, threshold)
        └─→ _initialized = true   (locks the clone)
    └─→ emit VaultCreated(vault, msg.sender, clientSalt, owners, threshold)

— time passes —

vault.execTransaction(targets, values, data, expiry, signatures)
    ├─ length parity
    ├─ block.timestamp ≤ expiry           (else revert ProposalExpired)
    ├─ signatures.length == 65 * threshold (else revert InvalidSignatureCount)
    ├─ digest = hashTx(targets, values, data, expiry, nonce)
    ├─ for each 65-byte slice:
    │     recovered = ECDSA.tryRecover(digest, sig)
    │     err == NoError                  (else revert NotAnOwner)
    │     recovered > prev                (else revert SignaturesNotSorted)
    │     isOwner[recovered]              (else revert NotAnOwner)
    │     prev = recovered
    ├─ nonce = nonce + 1                  (BEFORE inner calls)
    ├─ for each (target, value, data):
    │     (ok, ret) = target.call{value}(data)
    │     ok                              (else revert ExecutionFailed)
    └─ emit ExecutionSuccess(digest, consumedNonce)
```

---

## 9. Recovery model

Owner key compromise / loss is handled at the **multisign level**, not at the contract level — Genesis has no chain-recoverable backdoor. Recovery operations are themselves multisig proposals:

| Failure | Recovery path |
|---|---|
| One owner key lost | Remaining owners pass a `replaceOwner(oldOwner, newOwner)` proposal. |
| One owner compromised | Same, urgent. If remaining owners < threshold, run `changeThreshold` first via a proposal signed by current threshold of owners. |
| All-but-one owner lost | If `1 < threshold`, vault is bricked. Threshold sizing rule (see `gaokey-mobile/docs/multisig/cold-signer-mode.md`) — 2-of-3 / 3-of-5 minimum for treasury — exists specifically to prevent this. |
| Last owner removed | Impossible by construction (`LastOwnerCannotBeRemoved`). |
| All owners lost | Funds are bricked. No backdoor in Genesis. Document and rehearse signer custody. |
| Contract bug | The production-readiness gate in `gaokey-mobile/docs/multisig/production-readiness-gate.md` requires an independent audit before mainnet. |

---

## 10. Open items pending PR 2 review

These are TBD **because they pin only after audit / explorer-verification**, not because the design is incomplete:

- Exact runtime bytecode hash of the implementation singleton at a chosen Solidity compiler version + optimizer runs.
- Final CREATE2 prediction values for any post-audit deployment.
- Audit report reference.
- Per-chain factory deployed addresses (added only after the gaokey-mobile production-readiness gate is met for that chain — in a separate, single-purpose PR).
