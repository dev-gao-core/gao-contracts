// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  GaoDomainPaymentV1
/// @notice Direct-to-treasury payment + on-chain purchase evidence for
///         `.gao` domains. Replaces the `GaoDomainDepositV3`
///         escrow/settle launch path with a custody-free "pay-through"
///         model:
///
///           * The buyer pays an allowlisted ERC-20 (USDC in v1) and the
///             contract forwards it to the Gao Treasury in the SAME
///             transaction via `SafeERC20.safeTransferFrom(buyer ->
///             treasury)`. The contract NEVER holds user funds — there is
///             no escrow balance, no `settle`, no `withdrawTreasury`, no
///             affiliate ledger, and therefore NO backend signer / owner
///             key anywhere in the purchase path.
///
///           * Governance is a Safe 2/3 `owner` whose only powers are
///             configuration (token allowlist, treasury, pause) and
///             stray-token rescue. None of these can move a user payment
///             or drain the treasury (the treasury is a separate wallet).
///
///           * Each purchase emits one `DomainPurchased` event carrying
///             human-readable evidence (plaintext `domainName`, the buyer
///             wallet, token, amount, treasury, timestamp) plus the
///             pointer to the immutable off-chain profile (`profileURI` +
///             `profileHash`) that the backend pinned to IPFS BEFORE the
///             purchase.
///
/// @dev    v1 simplifications (locked product decisions):
///
///           * `payer == owner`. The caller (`msg.sender`) is BOTH the
///             payer and the domain owner — there is no separate `owner`
///             parameter. The event still emits both `owner` and `payer`
///             (equal in v1) so the log schema is stable if a future
///             version decouples them.
///
///           * No on-chain owner mapping. The D1 resolver is the source
///             of truth for active ownership; the event log + the IPFS
///             profile are the immutable evidence.
///
///           * Pricing is NOT enforced on-chain (discounts / credits are
///             dynamic). The contract only requires `amount > 0`; the
///             backend verifies `amount` against the quoted invoice.
///
///           * Refunds and affiliate payouts are manual / off-chain from
///             the Treasury — there is no on-chain refund or affiliate
///             surface.
///
///         The only protective on-chain state is `invoicePaid[invoiceId]`
///         (replay guard). The contract binds the emitted plaintext
///         `domainName` to `domainHash` via
///         `keccak256(bytes(domainName)) == domainHash`, so the
///         human-readable log can never disagree with the hash the
///         backend indexes. The gao-id-worker computes `domainHash` as
///         `keccak256(toBytes(domainName.toLowerCase()))`; callers MUST
///         pass the already-normalised (lowercased) handle.
///
///         **DEV/TEST first.** This contract is not deployed to any
///         mainnet by the PR that introduces it. The dev/test deploy
///         script enforces a chain-id allowlist + mainnet banlist; the
///         mainnet B4 ceremony is operator-only.
contract GaoDomainPaymentV1 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Storage (minimal) ─────────────────────────────────────────────

    /// @notice Recipient of every domain payment. Set in constructor;
    ///         updatable by owner; required non-zero. SHOULD be a Safe.
    address public treasury;

    /// @notice Owner-managed allowlist of ERC-20s accepted for payment.
    ///         v1 launch set = USDC only.
    mapping(address => bool) public allowedTokens;

    /// @notice Replay guard. Each `invoiceId` can be paid at most once.
    ///         Domain-level uniqueness is enforced off-chain by the
    ///         backend (one-verified-owner-per-domain); on-chain we only
    ///         prevent a single invoice being charged twice.
    mapping(bytes32 => bool) public invoicePaid;

    // ── Events ─────────────────────────────────────────────────────────

    /// @notice Canonical on-chain purchase evidence, emitted once per
    ///         successful payment. `owner` and `payer` are equal in v1
    ///         (both = `msg.sender`); both are emitted for forward
    ///         compatibility. `domainName` is plaintext so explorers
    ///         render it; `profileURI` / `profileHash` point at the
    ///         immutable IPFS profile pinned before purchase.
    ///
    ///         Indexed topics: `invoiceId`, `payer`, `domainHash`.
    event DomainPurchased(
        bytes32 indexed invoiceId,
        address indexed payer,
        bytes32 indexed domainHash,
        address owner,
        string  domainName,
        address token,
        uint256 amount,
        address treasury,
        string  profileURI,
        bytes32 profileHash,
        uint256 timestamp
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event AllowedTokenUpdated(address indexed token, bool allowed);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ── Custom errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidAmount();
    error ZeroInvoiceId();
    error ZeroDomainHash();
    error EmptyDomainName();
    error EmptyProfileURI();
    error ZeroProfileHash();
    error TokenNotAllowed();
    error InvoiceAlreadyPaid();
    error DomainNameHashMismatch();

    // ── Constructor ─────────────────────────────────────────────────────

    /// @param initialOwner    Governance owner. Safe 2/3 in production.
    ///                        Ownable v5 rejects `address(0)` itself.
    /// @param initialTreasury Wallet that receives every payment. Required
    ///                        non-zero; SHOULD be a Safe. Keeping it
    ///                        distinct from the owner is recommended.
    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert ZeroAddress();
        treasury = initialTreasury;
        emit TreasuryUpdated(address(0), initialTreasury);
    }

    // ── Purchase (sole user entry point) ────────────────────────────────

    /// @notice Pay for a `.gao` domain. `msg.sender` is BOTH the payer
    ///         and the owner (v1 invariant). The payment is pulled from
    ///         `msg.sender` and forwarded to `treasury` in this same
    ///         transaction; the contract retains nothing.
    /// @param invoiceId   keccak256 of the backend payment-intent id.
    /// @param domainHash  keccak256(normalised lowercased handle).
    /// @param domainName  the normalised lowercased handle, e.g.
    ///                     "11111111.gao". MUST satisfy
    ///                     `keccak256(bytes(domainName)) == domainHash`.
    /// @param token       allowlisted ERC-20 (USDC in v1).
    /// @param amount      payment amount in token base units (> 0).
    /// @param profileURI  "ipfs://<cid>" of the pre-pinned profile.
    /// @param profileHash keccak256(canonical JSON) of that profile.
    function payForDomain(
        bytes32 invoiceId,
        bytes32 domainHash,
        string calldata domainName,
        address token,
        uint256 amount,
        string calldata profileURI,
        bytes32 profileHash
    ) external whenNotPaused nonReentrant {
        if (invoiceId == bytes32(0))                    revert ZeroInvoiceId();
        if (domainHash == bytes32(0))                   revert ZeroDomainHash();
        if (bytes(domainName).length == 0)              revert EmptyDomainName();
        if (token == address(0))                        revert ZeroAddress();
        if (amount == 0)                                revert InvalidAmount();
        if (bytes(profileURI).length == 0)              revert EmptyProfileURI();
        if (profileHash == bytes32(0))                  revert ZeroProfileHash();
        if (!allowedTokens[token])                      revert TokenNotAllowed();
        if (invoicePaid[invoiceId])                     revert InvoiceAlreadyPaid();
        if (keccak256(bytes(domainName)) != domainHash) revert DomainNameHashMismatch();

        // Effects: seal the invoice before the external token call.
        invoicePaid[invoiceId] = true;

        // Emit evidence before the interaction (CEI). `nonReentrant` is
        // belt-and-braces against a malicious token re-entering.
        emit DomainPurchased(
            invoiceId,
            msg.sender,   // payer
            domainHash,
            msg.sender,   // owner (== payer in v1)
            domainName,
            token,
            amount,
            treasury,
            profileURI,
            profileHash,
            block.timestamp
        );

        // Interaction: forward funds straight to the treasury. The
        // contract never holds a balance under correct operation.
        IERC20(token).safeTransferFrom(msg.sender, treasury, amount);
    }

    // ── Owner / admin (no fund custody) ─────────────────────────────────

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit AllowedTokenUpdated(token, allowed);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address prev = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(prev, newTreasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens that arrived at this contract outside the
    ///         normal pay-through flow (a stray / erroneous transfer).
    ///         Under correct operation the contract balance is always 0,
    ///         so there is no user / treasury liability to protect and the
    ///         whole balance is rescuable. The underlying transfer reverts
    ///         if `amount` exceeds the actual balance.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0))    revert ZeroAddress();
        if (amount == 0)         revert InvalidAmount();
        emit TokenRescued(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }
}
