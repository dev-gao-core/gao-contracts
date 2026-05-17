// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { GaoSafe } from "./GaoSafe.sol";

/// @title  GaoSafeFactory — Genesis CREATE2 factory
/// @notice Deploys deterministic EIP-1167 clones of an immutable
///         GaoSafe Genesis implementation. The factory itself is
///         ownerless, non-upgradeable, and has no admin surface.
///
///         Address derivation:
///
///           salt   = keccak256(abi.encode(msg.sender, clientSalt))
///           vault  = predictDeterministicAddress(implementation, salt, factory)
///
///         The `msg.sender` binding in the salt is the address-squatting
///         mitigation: only `deployer` can claim the vault address
///         derived from its (deployer, clientSalt) pair. A third party
///         observing a deployer's pending clientSalt cannot front-run
///         the deployment because their salt would resolve to a
///         different address.
///
///         Genesis exclusions documented in GaoSafe.sol also apply
///         here: no admin function, no implementation replacement,
///         no per-chain factory registry on-chain. The deployment
///         runbook (operator-only, post-audit) is the source of truth
///         for which factory address is canonical per chain.
contract GaoSafeFactory {
    /// @notice Immutable address of the locked GaoSafe Genesis
    ///         implementation singleton. Deployed in this factory's
    ///         constructor and locked there via the implementation's
    ///         own constructor (`_initialized = true`), so no external
    ///         party can ever call `setup()` on the bare singleton.
    address public immutable implementation;

    event VaultCreated(
        address indexed vault,
        address indexed deployer,
        bytes32 indexed clientSalt,
        address[] owners,
        uint256 threshold
    );

    /// @notice Deploys the Genesis implementation singleton and locks
    ///         it. Subsequent `createVault` calls deploy EIP-1167 minimal
    ///         proxies pointing at this singleton.
    constructor() {
        implementation = address(new GaoSafe());
    }

    /// @notice Create a new vault as a deterministic clone of the
    ///         Genesis implementation. The same (deployer, clientSalt)
    ///         pair can only be used once — a second call reverts
    ///         (Clones.cloneDeterministic reverts on address collision).
    /// @param owners      Initial owner set forwarded to GaoSafe.setup.
    /// @param threshold   Initial M-of-N threshold forwarded to GaoSafe.setup.
    /// @param clientSalt  Caller-chosen entropy. Hashed with `msg.sender`
    ///                    to form the CREATE2 salt; the deployer binding
    ///                    prevents address squatting.
    /// @return vault      Address of the newly-deployed clone.
    function createVault(
        address[] calldata owners,
        uint256 threshold,
        bytes32 clientSalt
    ) external returns (address vault) {
        bytes32 salt = keccak256(abi.encode(msg.sender, clientSalt));
        vault = Clones.cloneDeterministic(implementation, salt);
        GaoSafe(payable(vault)).setup(owners, threshold);
        emit VaultCreated(vault, msg.sender, clientSalt, owners, threshold);
    }

    /// @notice Predict the vault address that `createVault(_, _, clientSalt)`
    ///         would deploy when called by `deployer`. Pure read; does
    ///         not require the vault to exist yet. Use this to pre-fund
    ///         the future vault before calling `createVault`.
    function computeVaultAddress(address deployer, bytes32 clientSalt)
        external
        view
        returns (address)
    {
        bytes32 salt = keccak256(abi.encode(deployer, clientSalt));
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }
}
