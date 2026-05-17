// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title  GaoSafe — Genesis (institutional-baseline multisign vault)
/// @notice Minimal, deeply-auditable M-of-N vault. Genesis ships the
///         complete institutional-grade security primitive set:
///
///           - M-of-N threshold with strict owner / threshold validation
///           - per-vault nonce replay protection
///           - per-proposal expiry enforced on-chain
///           - EIP-712 typed-data digest only (EIP-191 / signMessage
///             is rejected by construction — see §EIP-712 below)
///           - chainId + vault address bound into BOTH the EIP-712
///             domain separator AND the typed-data body — defends
///             against both cross-chain and cross-vault replay
///           - signatures sorted ascending by recovered signer
///             address; duplicates rejected; non-owners rejected;
///             insufficient bundles rejected
///           - all-or-nothing batch execution; nonce incremented
///             before inner calls (re-entrancy-safe)
///           - owner-set mutations (addOwner / removeOwner /
///             replaceOwner / changeThreshold) are `onlySelf` — they
///             only succeed when the multisig itself reaches threshold
///             and calls back into the vault
///
///         Modules, plugins, upgradeability, ERC-1271 execution, PQ
///         verification, timelock, spending limits, allowlist guards,
///         and best-effort batch are deliberately OUT of the Genesis
///         core to keep audit surface small. Each may be added later
///         only if it passes a separate design review and audit and
///         ships as its own contract rather than as a patch to this
///         core.
///
///         Status: pre-audit. GaoSafe Genesis targets Safe-grade core
///         security and is designed toward Safe-grade security. Not
///         deployed to mainnet. Not approved for real funds until the
///         production-readiness gate is satisfied.
///
/// @dev    EIP-712 implementation is intentionally MANUAL. GaoSafe
///         Genesis does NOT inherit OpenZeppelin's EIP712 base
///         contract (`utils/cryptography/EIP712.sol`). OZ's EIP712
///         caches the domain separator and `address(this)` in
///         immutable variables initialised in its constructor; that
///         constructor never runs for an EIP-1167 minimal proxy, so
///         cached values would reflect the singleton implementation
///         rather than the clone. The manual implementation below
///         computes the domain separator on every call from
///         `block.chainid` and `address(this)`, both of which resolve
///         correctly inside a clone's delegatecall. Pinned by
///         `GaoSafe.eip712-parity.test.ts` case P7.
contract GaoSafe {
    // ── EIP-712 (manual, clone-safe) ─────────────────────────────────────
    //
    // Constants live in bytecode, not storage. A clone reads them
    // through delegatecall into the singleton's runtime bytecode, so
    // these resolve identically for every clone.

    /// @notice EIP-712 domain typehash. Fields: name, version, chainId, verifyingContract.
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice keccak256("GaoSafe"). The contract name baked into the EIP-712 domain.
    bytes32 private constant _NAME_HASH = keccak256(bytes("GaoSafe"));

    /// @notice keccak256("1"). The Genesis version anchor.
    bytes32 private constant _VERSION_HASH = keccak256(bytes("1"));

    /// @notice TX type hash. The struct definition is mirrored in
    ///         gaokey-mobile's `MultisigTypedDataMessage` and in
    ///         `test/multisig/helpers/eip712.ts`.
    bytes32 public constant TX_TYPEHASH = keccak256(
        "GaoMultisigTx(uint256 chainId,address vault,uint256 nonce,bytes32 targetsHash,bytes32 valuesHash,bytes32 dataHash,uint256 expiry)"
    );

    // ── State ────────────────────────────────────────────────────────────

    /// @dev Owner list (storage). Read externally via `getOwners()`.
    address[] internal _owners;

    /// @notice O(1) owner-membership map. Kept in sync with `_owners`.
    mapping(address => bool) public isOwner;

    /// @notice M of `_owners.length`. Validated `0 < threshold <= owners.length`.
    uint256 public threshold;

    /// @notice Per-vault nonce, incremented BEFORE inner calls on every
    ///         successful `execTransaction`. Replay rejected by the
    ///         digest pre-image changing.
    uint256 public nonce;

    /// @dev One-shot initialisation flag. Set true in the implementation
    ///      constructor to lock the bare singleton; set true again in
    ///      `setup()` to lock each clone after first init.
    bool internal _initialized;

    // ── Events ───────────────────────────────────────────────────────────

    event Setup(address[] owners, uint256 threshold);
    event ExecutionSuccess(bytes32 indexed digest, uint256 indexed nonceConsumed);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event OwnerReplaced(address indexed oldOwner, address indexed newOwner);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

    // ── Errors ───────────────────────────────────────────────────────────

    error AlreadyInitialized();
    error InvalidOwners();
    error DuplicateOwner();
    error ZeroOwner();
    error InvalidThreshold();
    error InvalidLengths();
    error ProposalExpired();
    error InvalidSignatureCount();
    error SignaturesNotSorted();
    error NotAnOwner();
    error NotSelfCall();
    error ExecutionFailed(uint256 callIndex, bytes reason);
    error LastOwnerCannotBeRemoved();
    error OwnerNotFound();
    error NotSetup();
    error ImplementationCannotReceiveEth();

    // ── Implementation self-pin (clone-aware ETH ingress guard) ──────────
    //
    // `_IMPLEMENTATION_SELF` is assigned in the constructor to the
    // address of the GaoSafe singleton itself. Because `immutable`
    // values live in the contract's RUNTIME BYTECODE rather than in
    // storage, every EIP-1167 clone reads the same baked-in value when
    // it delegate-calls into the singleton — so this constant identifies
    // "the bare implementation" from inside any clone's execution
    // context. Compared to `address(this)` (which a delegatecall
    // resolves to the clone's address), `_IMPLEMENTATION_SELF` is the
    // singleton's address even when read through a clone. `receive()`
    // uses the difference to refuse direct ETH transfers to the bare
    // singleton — see the `receive()` block at the bottom of this file.
    address private immutable _IMPLEMENTATION_SELF;

    // ── Constructor (singleton lock) ─────────────────────────────────────

    /// @notice Constructor runs exactly once — at implementation deploy.
    ///         Sets `_initialized = true` on the implementation so a
    ///         direct `setup()` against the bare singleton reverts.
    ///         EIP-1167 clones DO NOT run this constructor; each clone
    ///         starts with default (zero-initialised) storage and
    ///         `_initialized = false`, exactly as required for one-shot
    ///         init on the clone.
    ///
    ///         The constructor also bakes the implementation singleton's
    ///         own address into the immutable `_IMPLEMENTATION_SELF`
    ///         pin. Because `immutable` lives in bytecode, every clone
    ///         reads the same value through delegatecall — used by
    ///         `receive()` to refuse direct ETH ingress to the bare
    ///         singleton.
    constructor() {
        _initialized = true;
        _IMPLEMENTATION_SELF = address(this);
    }

    // ── Setup (one-time per clone) ───────────────────────────────────────

    /// @notice Initialise a freshly-cloned vault. Callable exactly once
    ///         per clone — subsequent calls revert with `AlreadyInitialized`.
    /// @param owners_     Owner set. Must be non-empty, no zero address,
    ///                    no duplicates.
    /// @param threshold_  M-of-N threshold. Must satisfy `0 < threshold_ <= owners_.length`.
    function setup(address[] calldata owners_, uint256 threshold_) external {
        if (_initialized) revert AlreadyInitialized();
        uint256 len = owners_.length;
        if (len == 0) revert InvalidOwners();
        if (threshold_ == 0 || threshold_ > len) revert InvalidThreshold();

        for (uint256 i = 0; i < len; ) {
            address owner = owners_[i];
            if (owner == address(0)) revert ZeroOwner();
            if (isOwner[owner]) revert DuplicateOwner();
            isOwner[owner] = true;
            _owners.push(owner);
            unchecked { ++i; }
        }
        threshold = threshold_;
        _initialized = true;

        emit Setup(owners_, threshold_);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice Returns the owner list in storage order. Not necessarily
    ///         sorted; consumers that need ordering must sort client-side.
    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    /// @notice Owner count. Equivalent to `getOwners().length`.
    function ownersCount() external view returns (uint256) {
        return _owners.length;
    }

    /// @notice EIP-712 domain separator computed fresh per call.
    ///         Clone-safe: `block.chainid` and `address(this)` both
    ///         return correct values inside an EIP-1167 delegatecall.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                _NAME_HASH,
                _VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Build the EIP-712 typed-data digest from a struct hash.
    ///      Intentionally named `_hashTypedData` (not `_hashTypedDataV4`)
    ///      so the absence of OZ inheritance is visible at the call site.
    ///      The `hex"1901"` prefix is the canonical EIP-712 two-byte
    ///      sentinel (0x19, 0x01) that distinguishes typed-data digests
    ///      from EIP-191 personal-sign and other prefixed-message forms.
    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// @notice Compute the EIP-712 digest that signers must sign over.
    ///         The contract calls this internally during `execTransaction`
    ///         with `nonceArg = nonce` (the current storage value).
    ///         Off-chain signers must call with the same `nonce` they
    ///         expect to consume; otherwise the produced signatures
    ///         won't match the contract's computed digest.
    function hashTx(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[]   calldata data,
        uint256 expiry,
        uint256 nonceArg
    ) public view returns (bytes32) {
        bytes32 targetsHash = keccak256(abi.encodePacked(targets));
        bytes32 valuesHash  = keccak256(abi.encodePacked(values));

        bytes32[] memory dataHashes = new bytes32[](data.length);
        for (uint256 i = 0; i < data.length; ) {
            dataHashes[i] = keccak256(data[i]);
            unchecked { ++i; }
        }
        bytes32 dataHash = keccak256(abi.encodePacked(dataHashes));

        bytes32 structHash = keccak256(
            abi.encode(
                TX_TYPEHASH,
                block.chainid,
                address(this),
                nonceArg,
                targetsHash,
                valuesHash,
                dataHash,
                expiry
            )
        );
        return _hashTypedData(structHash);
    }

    // ── execTransaction ──────────────────────────────────────────────────

    /// @notice Execute a multisig proposal. All-or-nothing batch: any
    ///         sub-call revert reverts the whole transaction and the
    ///         nonce increment is rolled back. The submitter need not
    ///         be an owner — only the signatures matter.
    /// @param targets     Per sub-call recipient.
    /// @param values      Per sub-call wei amount.
    /// @param data        Per sub-call calldata. Empty `0x` for native transfer.
    /// @param expiry      Unix-seconds wall-clock expiry. Rejected if
    ///                    `block.timestamp > expiry`.
    /// @param signatures  Concatenation of exactly `threshold` 65-byte
    ///                    ECDSA signatures over the EIP-712 digest,
    ///                    sorted strictly ascending by recovered signer
    ///                    address. No EIP-191 wrapping. No ERC-1271.
    function execTransaction(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[]   calldata data,
        uint256 expiry,
        bytes calldata signatures
    ) external {
        // ── Defense-in-depth NotSetup guard ────────────────────────────
        //
        // Refuse before any other check. Two distinct scenarios this
        // catches:
        //
        //   (a) The bare implementation singleton. Its constructor
        //       sets `_initialized = true`, but `threshold == 0` and
        //       `_owners.length == 0`. Without this guard, a caller
        //       could pass a zero-length signature bundle (which would
        //       satisfy `signatures.length == 65 * 0`) and trigger the
        //       inner-call loop on the implementation itself.
        //
        //   (b) A manually-deployed EIP-1167 clone that bypassed the
        //       factory and never had `setup()` called. Such a clone
        //       has `_initialized == false`, `threshold == 0`,
        //       `_owners.length == 0` — same hole as (a) for the same
        //       reason.
        //
        // Either form is rejected up front so neither can drain ETH
        // through a zero-threshold short-circuit. Pinned by tests #37
        // and #38 in GaoSafe.test.ts.
        if (!_initialized || threshold == 0 || _owners.length == 0) revert NotSetup();

        // ── Length parity ─────────────────────────────────────────────
        uint256 n = targets.length;
        if (n == 0) revert InvalidLengths();
        if (values.length != n || data.length != n) revert InvalidLengths();

        // ── Expiry ────────────────────────────────────────────────────
        if (block.timestamp > expiry) revert ProposalExpired();

        // ── Bundle size ───────────────────────────────────────────────
        uint256 t = threshold;
        if (signatures.length != 65 * t) revert InvalidSignatureCount();

        // ── Digest + signature verification ───────────────────────────
        uint256 consumedNonce = nonce;
        bytes32 digest = hashTx(targets, values, data, expiry, consumedNonce);
        _verifySignatures(digest, signatures, t);

        // ── Increment nonce BEFORE inner calls (re-entrancy-safe) ─────
        nonce = consumedNonce + 1;

        // ── Execute all-or-nothing ────────────────────────────────────
        _executeCalls(targets, values, data);

        emit ExecutionSuccess(digest, consumedNonce);
    }

    /// @dev Sorted-ascending, deduped, owner-only verification of a
    ///      concatenated 65-byte signature bundle. Pulled out of
    ///      execTransaction to keep that function's stack shallow
    ///      (avoid via-ir requirement; no hardhat config change).
    function _verifySignatures(
        bytes32 digest,
        bytes calldata signatures,
        uint256 t
    ) internal view {
        address prev;
        for (uint256 i = 0; i < t; ) {
            uint256 off = i * 65;
            bytes memory sig = signatures[off:off + 65];
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
            if (err != ECDSA.RecoverError.NoError) revert NotAnOwner();
            if (recovered <= prev) revert SignaturesNotSorted();
            if (!isOwner[recovered]) revert NotAnOwner();
            prev = recovered;
            unchecked { ++i; }
        }
    }

    /// @dev All-or-nothing inner-call loop. Pulled out of execTransaction
    ///      to keep stack pressure low. A revert from any sub-call
    ///      reverts the outer transaction; the nonce increment that
    ///      execTransaction performed before calling this helper is
    ///      rolled back along with everything else.
    function _executeCalls(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[]   calldata data
    ) internal {
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; ) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(data[i]);
            if (!ok) revert ExecutionFailed(i, ret);
            unchecked { ++i; }
        }
    }

    // ── Owner management — onlySelf ──────────────────────────────────────
    //
    // Each mutator is callable ONLY when `msg.sender == address(this)`,
    // which is only possible when execTransaction's inner-call loop
    // calls back into the vault. That call requires the threshold to
    // have already been met for the proposal containing it.

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelfCall();
        _;
    }

    /// @notice Add an owner and (re)set the threshold atomically.
    /// @dev    `newThreshold` must satisfy `0 < newThreshold <= ownersCount + 1`.
    function addOwner(address newOwner, uint256 newThreshold) external onlySelf {
        if (newOwner == address(0)) revert ZeroOwner();
        if (isOwner[newOwner]) revert DuplicateOwner();
        _owners.push(newOwner);
        isOwner[newOwner] = true;

        uint256 len = _owners.length;
        if (newThreshold == 0 || newThreshold > len) revert InvalidThreshold();
        uint256 oldT = threshold;
        threshold = newThreshold;

        emit OwnerAdded(newOwner);
        if (oldT != newThreshold) emit ThresholdChanged(oldT, newThreshold);
    }

    /// @notice Remove an owner and (re)set the threshold atomically.
    /// @dev    Cannot remove the last owner. `newThreshold` must satisfy
    ///         `0 < newThreshold <= ownersCount - 1`.
    function removeOwner(address ownerToRemove, uint256 newThreshold) external onlySelf {
        if (_owners.length == 1) revert LastOwnerCannotBeRemoved();
        if (!isOwner[ownerToRemove]) revert OwnerNotFound();

        // swap-and-pop removal
        uint256 last = _owners.length - 1;
        for (uint256 i = 0; i <= last; ) {
            if (_owners[i] == ownerToRemove) {
                if (i != last) _owners[i] = _owners[last];
                _owners.pop();
                break;
            }
            unchecked { ++i; }
        }
        isOwner[ownerToRemove] = false;

        uint256 newLen = _owners.length;
        if (newThreshold == 0 || newThreshold > newLen) revert InvalidThreshold();
        uint256 oldT = threshold;
        threshold = newThreshold;

        emit OwnerRemoved(ownerToRemove);
        if (oldT != newThreshold) emit ThresholdChanged(oldT, newThreshold);
    }

    /// @notice Replace an owner in place. Threshold is unchanged.
    function replaceOwner(address oldOwner, address newOwner) external onlySelf {
        if (newOwner == address(0)) revert ZeroOwner();
        if (!isOwner[oldOwner]) revert OwnerNotFound();
        if (isOwner[newOwner]) revert DuplicateOwner();

        uint256 len = _owners.length;
        for (uint256 i = 0; i < len; ) {
            if (_owners[i] == oldOwner) {
                _owners[i] = newOwner;
                break;
            }
            unchecked { ++i; }
        }
        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;

        emit OwnerReplaced(oldOwner, newOwner);
    }

    /// @notice Change the threshold without modifying the owner set.
    function changeThreshold(uint256 newThreshold) external onlySelf {
        if (newThreshold == 0 || newThreshold > _owners.length) revert InvalidThreshold();
        uint256 oldT = threshold;
        if (oldT != newThreshold) {
            threshold = newThreshold;
            emit ThresholdChanged(oldT, newThreshold);
        }
    }

    // ── Funds intake ─────────────────────────────────────────────────────

    /// @notice Accept plain ETH transfers into a setup-initialised clone.
    ///         No fallback function — calldata to non-existent function
    ///         selectors reverts. ETH sent directly to the bare
    ///         implementation singleton (not a clone) is refused with
    ///         `ImplementationCannotReceiveEth`. The clone-aware check
    ///         reads the bytecode-embedded `_IMPLEMENTATION_SELF` pin,
    ///         which is the singleton's address even when this `receive`
    ///         is reached through a clone's delegatecall — so a clone
    ///         compares `address(this)` (the clone) against the
    ///         singleton and accepts the transfer, while a direct
    ///         transfer to the singleton compares equal and reverts.
    ///         Pinned by test #39 (revert path) and test #36 (clone
    ///         ETH ingress remains accepted).
    receive() external payable {
        if (address(this) == _IMPLEMENTATION_SELF) revert ImplementationCannotReceiveEth();
    }
}
