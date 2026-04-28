// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  GaoDomainAnchor
/// @notice Append-only on-chain anchor for `.gao` domain ownership /
///         wallet mapping / snapshot hashes computed off-chain by
///         `gao-id-worker`. The contract is deliberately minimal:
///
///           - no token custody, no payable surface
///           - no external calls, no delegatecall, no upgradeability
///           - no owner / no access control — public anchoring is
///             permitted; the backend recomputes the canonical
///             payload hash and compares it with the indexed event +
///             tx sender, so a spurious anchor by a third party
///             changes nothing the backend trusts (it just leaves a
///             public log entry the backend ignores)
///           - no arrays, no large-string storage; only three
///             "latest hash" mappings for cheap reads, the full
///             history lives in event logs
///
/// @dev    Wire shape MUST stay stable across deployments. The
///         backend ABI consumer in `gao-id-worker` will pin:
///
///           function anchorDomain(bytes32,bytes32)
///           function anchorSnapshot(bytes32,bytes32,bytes32)
///           function anchorMapping(bytes32,bytes32)
///
///           event DomainAnchored(bytes32,bytes32,address,uint256)
///           event SnapshotAnchored(bytes32,bytes32,bytes32,address,uint256)
///           event MappingAnchored(bytes32,bytes32,address,uint256)
///
///         Changing any signature is a worker-coordinated breaking
///         change.
///
///         The `payloadHash` here is `keccak256(toBytes(canonicalJSON))`
///         where canonicalJSON is the RFC-8785-style canonical
///         serialisation produced by `gao-id-worker:lib/anchor-payload`.
///         The same primitive backs `escrow.adapter.computeDomainHash`
///         in the worker, so off-chain re-verification is symmetric.
contract GaoDomainAnchor {
    // ── Errors ─────────────────────────────────────────────────────────
    //
    // Custom errors instead of `require(_, "msg")` for cheaper revert
    // payloads and explicit decoding on the worker side.

    error ZeroDomainHash();
    error ZeroPayloadHash();
    error ZeroSnapshotId();
    error ZeroMerkleRoot();
    error ZeroMappingsHash();

    // ── Events (primary immutable audit log) ──────────────────────────
    //
    // Three indexed topics each so the worker can `eth_getLogs`
    // efficiently on (domainHash, payloadHash, sender) /
    // (snapshotId, merkleRoot, sender) / (domainHash, mappingsHash,
    // sender) without scanning every block.

    event DomainAnchored(
        bytes32 indexed domainHash,
        bytes32 indexed payloadHash,
        address indexed anchorer,
        uint256 timestamp
    );

    event SnapshotAnchored(
        bytes32 indexed snapshotId,
        bytes32 indexed merkleRoot,
        // payloadHash is intentionally non-indexed: it's not a useful
        // filter key (the backend already knows it from the
        // anchor-job row). Keeping it un-indexed saves one topic slot
        // and one keccak per anchor.
        bytes32 payloadHash,
        address indexed anchorer,
        uint256 timestamp
    );

    event MappingAnchored(
        bytes32 indexed domainHash,
        bytes32 indexed mappingsHash,
        address indexed anchorer,
        uint256 timestamp
    );

    // ── Latest-hash storage (convenience reads for backend) ───────────
    //
    // Full anchor history lives in event logs. These mappings only
    // expose the most-recent payload hash for each (domain or
    // snapshotId) so the backend can do a single SLOAD instead of an
    // event scan when answering "what's the latest committed hash".
    //
    // The backend SHOULD NOT treat these as authoritative — they can
    // be overwritten by anyone (anchoring is public). The
    // authoritative answer is "the latest event whose anchorer matches
    // the expected gao-id-worker signer / dapp wallet, AND whose
    // payloadHash equals the worker's recomputed hash".

    /// @notice Latest payloadHash anchored against `domainHash` via
    ///         `anchorDomain`. Anyone can overwrite — the backend
    ///         must verify off-chain.
    mapping(bytes32 => bytes32) public latestDomainPayloadHash;

    /// @notice Latest payloadHash anchored against `snapshotId` via
    ///         `anchorSnapshot`. Same caveat as above.
    mapping(bytes32 => bytes32) public latestSnapshotPayloadHash;

    /// @notice Latest mappingsHash anchored against `domainHash` via
    ///         `anchorMapping`. Same caveat as above.
    mapping(bytes32 => bytes32) public latestMappingHash;

    // ── Anchor methods ────────────────────────────────────────────────

    /// @notice Anchor a domain ownership / purchase payload hash on
    ///         chain. Public; the backend verifies off-chain that the
    ///         emitted event matches the expected (domainHash,
    ///         payloadHash, anchorer) tuple before flipping the
    ///         off-chain anchor job to `confirmed`.
    /// @param  domainHash  keccak256(lowercased normalised .gao handle)
    /// @param  payloadHash keccak256(canonical JSON of the payload)
    function anchorDomain(bytes32 domainHash, bytes32 payloadHash) external {
        if (domainHash == bytes32(0)) revert ZeroDomainHash();
        if (payloadHash == bytes32(0)) revert ZeroPayloadHash();

        latestDomainPayloadHash[domainHash] = payloadHash;

        emit DomainAnchored(domainHash, payloadHash, msg.sender, block.timestamp);
    }

    /// @notice Anchor a snapshot — typed by `snapshotId` and committed
    ///         to a merkleRoot + payloadHash. Used by mapping
    ///         snapshots, ownership snapshots, and any future
    ///         deterministic read-model anchors.
    /// @param  snapshotId   bytes32-compatible snapshot identifier
    ///                      (e.g. `keccak256(snapshotId_string)`)
    /// @param  merkleRoot   merkle root over the snapshot records
    /// @param  payloadHash  keccak256 of the canonical-JSON payload
    function anchorSnapshot(
        bytes32 snapshotId,
        bytes32 merkleRoot,
        bytes32 payloadHash
    ) external {
        if (snapshotId == bytes32(0)) revert ZeroSnapshotId();
        if (merkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (payloadHash == bytes32(0)) revert ZeroPayloadHash();

        latestSnapshotPayloadHash[snapshotId] = payloadHash;

        emit SnapshotAnchored(
            snapshotId,
            merkleRoot,
            payloadHash,
            msg.sender,
            block.timestamp
        );
    }

    /// @notice Anchor the canonical hash of a domain's verified +
    ///         default mappings set. Backend computes the snapshot
    ///         off-chain (see `gao-id-worker:lib/anchor-payload.
    ///         buildDomainMappingsSnapshotPayload`) and submits the
    ///         resulting hash here.
    /// @param  domainHash    keccak256(lowercased normalised handle)
    /// @param  mappingsHash  keccak256 of the canonical mappings payload
    function anchorMapping(bytes32 domainHash, bytes32 mappingsHash) external {
        if (domainHash == bytes32(0)) revert ZeroDomainHash();
        if (mappingsHash == bytes32(0)) revert ZeroMappingsHash();

        latestMappingHash[domainHash] = mappingsHash;

        emit MappingAnchored(domainHash, mappingsHash, msg.sender, block.timestamp);
    }
}
