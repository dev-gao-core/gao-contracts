# GaoSafe Genesis — Test Plan

> Test matrix for GaoSafe Genesis. Coverage is gated on **every Genesis security primitive has a pinning test**. Tests for the documented audit-scope boundaries (ERC-1271 execution, PQ verification, upgradeability, modules) intentionally do NOT exist in Genesis — those capabilities are not present in the contract, and adding tests for absent behaviour is misleading. If a boundary capability is ever added in a future audited release, that release will arrive with its own matrix.
>
> Gas analysis is a separate hardening concern and lives in a follow-up PR after Genesis correctness is locked and audited. Adding gas instrumentation to the Genesis test suite would inflate test noise without adding correctness signal.

## 1. Test files

| File | Cases | Subject |
|---|---|---|
| [`test/multisig/GaoSafe.test.ts`](../../test/multisig/GaoSafe.test.ts) | 36 (#1–#36) | Vault behaviour: setup, exec happy/rejection, owner-set onlySelf + via-proposal, safety rails, event shapes |
| [`test/multisig/GaoSafeFactory.test.ts`](../../test/multisig/GaoSafeFactory.test.ts) | 10 (F1–F10) | Factory: singleton lock, clone determinism, deployer-binding, ABI hygiene |
| [`test/multisig/GaoSafe.eip712-parity.test.ts`](../../test/multisig/GaoSafe.eip712-parity.test.ts) | 7 (P1–P7) | EIP-712 JS ↔ contract parity for every proposal flavour + clone-safety pin |
| [`test/multisig/helpers/eip712.ts`](../../test/multisig/helpers/eip712.ts) | n/a (shared helper) | JS-side EIP-712 builder; mirror for gaokey-mobile PR 3 |

**Total: 53 cases. Result on hardhat in-memory chain (chainId 31337): 53 passing.**

## 2. Vault matrix (`GaoSafe.test.ts`)

### 2.1 Setup happy + one-shot init + input validation (#1-#8)

| # | Case | Asserts |
|---|---|---|
| 1 | setup succeeds once on a fresh clone (via factory) | Owners, threshold, nonce correct |
| 2 | setup cannot run twice (AlreadyInitialized) | One-shot init |
| 3 | setup with zero owners reverts (InvalidOwners) | Input validation |
| 4 | setup with duplicate owners reverts (DuplicateOwner) | Input validation |
| 5 | setup with `0x0` owner reverts (ZeroOwner) | Input validation |
| 6 | setup with threshold == 0 reverts (InvalidThreshold) | Input validation |
| 7 | setup with threshold > owners.length reverts (InvalidThreshold) | Input validation |
| 8 | implementation singleton rejects setup() directly (AlreadyInitialized) | Singleton lock |

### 2.2 execTransaction happy paths (#9-#11)

| # | Case |
|---|---|
| 9 | Native ETH transfer with threshold signatures |
| 10 | ERC-20 transfer calldata via `MockERC20` |
| 11 | Batch (2 native + 1 ERC-20) executes atomically |

### 2.3 execTransaction rejections (#12-#22)

| # | Case | Asserts |
|---|---|---|
| 12 | Replay rejected | Nonce mismatch → NotAnOwner |
| 13 | Expired proposal rejected | ProposalExpired |
| 14 | Duplicate signer rejected | SignaturesNotSorted (equality reverts) |
| 15 | Unsorted signatures rejected | SignaturesNotSorted |
| 16 | Non-owner signature rejected | NotAnOwner |
| 17 | Insufficient signatures rejected | InvalidSignatureCount |
| 18 | EIP-191 / `signMessage` signature rejected | Digest separation → NotAnOwner / SignaturesNotSorted |
| 19 | Wrong chainId rejected | Sig over chainId 1, submit on hardhat → NotAnOwner |
| 20 | Wrong vault / verifyingContract rejected | Sig over phantom vault, submit on real vault → NotAnOwner |
| 21 | Payload mutation after signing rejected | Submit with different amount than signed → NotAnOwner |
| 22 | Failed inner call reverts whole proposal | ExecutionFailed; nonce NOT advanced |

### 2.4 Owner management onlySelf (#23-#26)

| # | Case |
|---|---|
| 23 | addOwner only via self-call (NotSelfCall) |
| 24 | removeOwner only via self-call (NotSelfCall) |
| 25 | replaceOwner only via self-call (NotSelfCall) |
| 26 | changeThreshold only via self-call (NotSelfCall) |

### 2.5 Owner management via proposal (#27-#30)

| # | Case | Asserts |
|---|---|---|
| 27 | addOwner via multisig proposal succeeds | Event OwnerAdded; owner added; threshold updated |
| 28 | removeOwner via multisig proposal succeeds | Event OwnerRemoved; owner removed; threshold updated |
| 29 | replaceOwner via multisig proposal succeeds | Event OwnerReplaced; old removed, new added |
| 30 | changeThreshold via multisig proposal succeeds | Event ThresholdChanged |

### 2.6 Owner-set safety rails (#31-#33)

| # | Case |
|---|---|
| 31 | Last owner cannot be removed (LastOwnerCannotBeRemoved → wraps as ExecutionFailed) |
| 32 | removeOwner with newThreshold > owners.length - 1 reverts (InvalidThreshold → wraps as ExecutionFailed) |
| 33 | changeThreshold(0) reverts (InvalidThreshold → wraps as ExecutionFailed) |

### 2.7 Event shapes (#34-#36)

| # | Case |
|---|---|
| 34 | ExecutionSuccess(digest, nonceConsumed) on happy path |
| 35 | Setup(owners, threshold) on createVault |
| 36 | receive() accepts ETH and increments vault balance |

## 3. Factory matrix (`GaoSafeFactory.test.ts`)

| # | Case |
|---|---|
| F1 | Constructor deploys an implementation singleton |
| F2 | createVault returns an EIP-1167 clone of the implementation |
| F3 | computeVaultAddress matches the deployed vault address |
| F4 | Same clientSalt from different deployers produces different addresses |
| F5 | Same (deployer, clientSalt) called twice reverts |
| F6 | createVault propagates setup failures (duplicate owners → revert) |
| F7 | Vault `isOwner` reflects supplied owners |
| F8 | Vault `threshold` and `getOwners()` reflect supplied values |
| F9 | `VaultCreated` event emitted with (vault, deployer, clientSalt, owners, threshold) |
| F10 | Factory has no admin function (setImplementation / owner / transferOwnership / pause / upgradeTo absent from ABI) |

## 4. EIP-712 parity matrix (`GaoSafe.eip712-parity.test.ts`)

Each parity case asserts byte-equality across three independent computations:
- JS manual builder (`test/multisig/helpers/eip712.ts`)
- Ethers' built-in `TypedDataEncoder.hash`
- Contract `hashTx(...)` view

| # | Proposal flavour |
|---|---|
| P1 | transfer_native — single ETH transfer |
| P2 | transfer_erc20 — encoded `transfer(to, amount)` calldata against MockERC20 |
| P3 | contract_call — arbitrary calldata with non-zero value |
| P4 | batch — 3 sub-calls of varying value/data shapes |
| P5 | owner rotation self-call — `addOwner(newOwner, newThreshold)` calldata targeting the vault itself |
| P6 | End-to-end — sign the JS-built typed-data and submit via execTransaction; signatures accepted |
| P7 | **Clone safety** — two clones on the same chain produce DIFFERENT domain separators, proving `address(this)` resolves per-clone (not from an OZ-style cache) |

## 5. Commands

```sh
npx hardhat compile

# Multisig-only run (faster iteration)
npx hardhat test test/multisig/GaoSafe.test.ts \
                 test/multisig/GaoSafeFactory.test.ts \
                 test/multisig/GaoSafe.eip712-parity.test.ts

# Full regression (existing + new)
npx hardhat test

# Export ABIs for the gaokey-mobile consumer (no broadcast, no env reads)
npx ts-node scripts/multisig/exportGaoSafeAbi.ts
```

## 6. What is intentionally NOT tested

These are audit-scope boundaries documented in `gao-safe-design.md` §4 and `gao-safe-threat-model.md` §6. The capabilities are not present in the contract; adding tests for absent behaviour would be misleading.

- ERC-1271 contract-signer verification
- Post-quantum signature verification (no PQ verifier exists)
- Upgradeability (no upgrade path exists)
- Modules / plugins / guards (none exist)
- Best-effort batch execution (Genesis is strictly all-or-nothing)
- Timelock / spending limit / allowlist (no such logic exists in the core)
- Gas instrumentation (deferred to a separate hardening PR after audit)

Each capability may be added later only if it passes a separate design review and audit and ships as its own contract — at which point a separate test matrix arrives with it.
