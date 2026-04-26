// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GaoDomainDeposit
/// @notice Canonical escrow for `.gao` domain payments. Wallets call
///         `deposit()` with an ERC-20 (typically USDC); `gao-id-worker`
///         verifies the resulting `Deposited` event off-chain and
///         settles ownership via its existing `confirmPurchase` path.
///         The contract holds funds until an admin/multisig calls
///         `settle()` (release to platform treasury — out of scope for
///         this minimal contract; settlement here just locks state) or
///         `refund()` (return funds to the original payer).
/// @dev    Wire shape MUST match `gao-id-worker/src/contracts/escrow.abi.ts`.
///         Specifically:
///           - `deposit(buyer, invoiceId, domainHash, token, amount)`
///           - `getDeposit(bytes32)` returns 9-field struct
///           - `isPending(bytes32) returns (bool)`
///           - `Deposited(bytes32 indexed, address indexed, bytes32 indexed, address, uint256, address)`
///           - status enum 0=NONE, 1=DEPOSITED, 2=SETTLED, 3=REFUNDED
///         Changing any of these breaks the worker adapter and requires
///         a coordinated worker + frontend release.
contract GaoDomainDeposit is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle state of a deposit.
    /// @dev    Ordering is wire-stable; `escrow.adapter.ts:DepositStatus`
    ///         in gao-id-worker mirrors this.
    enum Status {
        NONE,        // 0 — no deposit recorded for this invoiceId
        DEPOSITED,   // 1 — funds held in escrow, awaiting settle / refund
        SETTLED,     // 2 — admin marked complete; ownership written off-chain
        REFUNDED     // 3 — funds returned to payer
    }

    /// @dev `commitmentLeaf` = keccak256(abi.encode(buyer, domainHash, amount)).
    ///      Reserved for the future Merkle snapshot worker; not consumed by
    ///      Phase 1 verification. `isReserved` is currently always false —
    ///      the Phase 2 admin-claim path may set it true.
    struct Deposit {
        address buyer;
        Status  status;
        uint64  depositedAt;
        bool    isReserved;
        address paymentToken;
        uint256 amount;
        bytes32 domainHash;
        bytes32 commitmentLeaf;
        address payer;
    }

    /// @dev Stored separately from the public getter so the struct layout
    ///      can evolve independently of the wire-stable getDeposit() ABI.
    mapping(bytes32 => Deposit) private _deposits;

    /// @notice Allowlist of ERC-20s accepted as deposit tokens. Owner-managed.
    mapping(address => bool) public allowedTokens;

    // ── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted on a successful `deposit()`. The off-chain worker
    ///         matches every indexed + data field against the payment intent
    ///         it minted; mismatches cause verification to fail closed.
    event Deposited(
        bytes32 indexed invoiceId,
        address indexed buyer,
        bytes32 indexed domainHash,
        address paymentToken,
        uint256 amount,
        address payer
    );

    event Settled(bytes32 indexed invoiceId);
    event Refunded(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event AllowedTokenSet(address indexed token, bool allowed);

    // ── Custom errors ───────────────────────────────────────────────────────

    error InvalidBuyer();
    error InvalidDomainHash();
    error InvalidAmount();
    error InvalidInvoiceId();
    error TokenNotAllowed();
    error InvoiceAlreadyExists();
    error InvoiceNotInDepositedState();

    // ── Constructor ─────────────────────────────────────────────────────────

    /// @param initialOwner Receives `Ownable` rights. In production this
    ///                     SHOULD be a multisig (Safe), not an EOA.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Deposit (public wallet entry point) ─────────────────────────────────

    /// @notice Lock `amount` of `token` in escrow against `invoiceId`.
    /// @param  buyer        wallet that will receive the domain on settlement.
    /// @param  invoiceId    bytes32 commitment minted by gao-id-worker
    ///                      (`paymentIntentHash` = keccak256(utf8 paymentIntent.id)).
    /// @param  domainHash   keccak256(utf8 lowercased domain).
    /// @param  token        ERC-20 to pull from `msg.sender`. Must be allow-listed.
    /// @param  amount       amount in token base units (uint256). Must be > 0.
    /// @dev    `payer = msg.sender`. `buyer` may differ (gift / treasury sponsor).
    ///         A given `invoiceId` can only be deposited once.
    function deposit(
        address buyer,
        bytes32 invoiceId,
        bytes32 domainHash,
        address token,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (buyer == address(0))                       revert InvalidBuyer();
        if (domainHash == bytes32(0))                  revert InvalidDomainHash();
        if (amount == 0)                               revert InvalidAmount();
        if (invoiceId == bytes32(0))                   revert InvalidInvoiceId();
        if (!allowedTokens[token])                     revert TokenNotAllowed();
        if (_deposits[invoiceId].status != Status.NONE) revert InvoiceAlreadyExists();

        bytes32 leaf = keccak256(abi.encode(buyer, domainHash, amount));
        _deposits[invoiceId] = Deposit({
            buyer:          buyer,
            status:         Status.DEPOSITED,
            depositedAt:    uint64(block.timestamp),
            isReserved:     false,
            paymentToken:   token,
            amount:         amount,
            domainHash:     domainHash,
            commitmentLeaf: leaf,
            payer:          msg.sender
        });

        // Pull tokens AFTER state write so a malicious ERC-20's
        // re-entrant transferFrom cannot observe Status.NONE and re-enter
        // (CEI ordering, plus the explicit nonReentrant guard).
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(invoiceId, buyer, domainHash, token, amount, msg.sender);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /// @notice Full deposit record. Wire-stable shape — gao-id-worker's
    ///         adapter and the FE both rely on this ordering.
    function getDeposit(bytes32 invoiceId)
        external
        view
        returns (
            address buyer,
            uint8   status,
            uint64  depositedAt,
            bool    isReserved,
            address paymentToken,
            uint256 amount,
            bytes32 domainHash,
            bytes32 commitmentLeaf,
            address payer
        )
    {
        Deposit storage d = _deposits[invoiceId];
        return (
            d.buyer,
            uint8(d.status),
            d.depositedAt,
            d.isReserved,
            d.paymentToken,
            d.amount,
            d.domainHash,
            d.commitmentLeaf,
            d.payer
        );
    }

    /// @notice True iff this invoice is in DEPOSITED state (not yet
    ///         SETTLED or REFUNDED). Probed by gao-id-worker for ABI/
    ///         address-mismatch detection in `/v2/contracts/health` —
    ///         the FE no longer reads this as the source of truth.
    function isPending(bytes32 invoiceId) external view returns (bool) {
        return _deposits[invoiceId].status == Status.DEPOSITED;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Owner toggles whether a given ERC-20 is accepted by `deposit`.
    ///         Production should keep this list minimal (typically just USDC).
    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit AllowedTokenSet(token, allowed);
    }

    /// @notice Mark a deposit SETTLED. Funds remain in the contract — the
    ///         actual treasury sweep is intentionally out of scope here so
    ///         this contract's state is auditable by the off-chain worker
    ///         without requiring a treasury policy decision on-chain.
    /// @dev    A future revision may add a `sweep(token, to)` admin
    ///         function; that change is non-breaking for the worker
    ///         (it only consumes the Deposited event for verification).
    function settle(bytes32 invoiceId) external onlyOwner {
        Deposit storage d = _deposits[invoiceId];
        if (d.status != Status.DEPOSITED) revert InvoiceNotInDepositedState();
        d.status = Status.SETTLED;
        emit Settled(invoiceId);
    }

    /// @notice Return the deposited tokens to the original payer wallet.
    ///         Permitted only while status is DEPOSITED — once SETTLED
    ///         the funds are considered platform revenue.
    function refund(bytes32 invoiceId) external onlyOwner nonReentrant {
        Deposit storage d = _deposits[invoiceId];
        if (d.status != Status.DEPOSITED) revert InvoiceNotInDepositedState();
        d.status = Status.REFUNDED;
        // Cache locals before external call (CEI).
        address payer = d.payer;
        uint256 amount = d.amount;
        IERC20 token = IERC20(d.paymentToken);
        emit Refunded(invoiceId, payer, amount);
        token.safeTransfer(payer, amount);
    }

    /// @notice Pause new deposits. Settlement + refund remain available so
    ///         the operator can wind down in-flight deposits during an
    ///         incident.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
