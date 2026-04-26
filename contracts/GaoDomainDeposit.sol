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
///         `settle()` (marks revenue, makes funds withdrawable to
///         `treasury` via `withdrawTreasury`) or `refund()` (returns
///         funds to the original payer). Per-token `lockedLiability`
///         accounting prevents pending/refundable deposits from being
///         swept while still in DEPOSITED state.
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

    /// @notice Per-token sum of amounts currently in DEPOSITED state.
    ///         These funds belong to payers (refundable) and MUST NOT be
    ///         swept to treasury. Incremented on `deposit`, decremented on
    ///         `settle` (funds move to `withdrawableBalance`) and on
    ///         `refund` (funds go back to payer).
    mapping(address => uint256) public lockedLiability;

    /// @notice Per-token sum of settled funds available for treasury sweep.
    ///         Strictly tracked: only `settle()` increases it, only
    ///         `withdrawTreasury()` decreases it. Stray transfers into
    ///         the contract do NOT count — they remain stuck (no rescue
    ///         path) so the contract is a closed ledger over settled
    ///         revenue.
    mapping(address => uint256) public withdrawableBalance;

    /// @notice Recipient of treasury sweeps. Settable by owner; required
    ///         non-zero. Kept distinct from `owner()` so the controller
    ///         (multisig signing settle/refund) can be separate from the
    ///         wallet that ultimately receives platform revenue.
    address public treasury;

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
    event TreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event TreasuryWithdrawn(address indexed token, address indexed to, uint256 amount);

    // ── Custom errors ───────────────────────────────────────────────────────

    error InvalidBuyer();
    error InvalidDomainHash();
    error InvalidAmount();
    error InvalidInvoiceId();
    error TokenNotAllowed();
    error InvoiceAlreadyExists();
    error InvoiceNotInDepositedState();
    error InvalidTreasury();
    error InsufficientWithdrawable();

    // ── Constructor ─────────────────────────────────────────────────────────

    /// @param initialOwner    Receives `Ownable` rights. In production this
    ///                        SHOULD be a multisig (Safe), not an EOA.
    /// @param initialTreasury Wallet that receives `withdrawTreasury` sweeps.
    ///                        Must be non-zero. Distinct from `initialOwner`
    ///                        so the controller can be separated from the
    ///                        revenue-receiving wallet.
    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert InvalidTreasury();
        treasury = initialTreasury;
        emit TreasurySet(address(0), initialTreasury);
    }

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
        // Reserve the deposited amount as refundable. Cleared on settle/refund.
        lockedLiability[token] += amount;

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

    /// @notice Mark a deposit SETTLED. Funds remain in the contract; they
    ///         move from `lockedLiability` to `withdrawableBalance` and
    ///         can then be swept to `treasury` via `withdrawTreasury`.
    function settle(bytes32 invoiceId) external onlyOwner {
        Deposit storage d = _deposits[invoiceId];
        if (d.status != Status.DEPOSITED) revert InvoiceNotInDepositedState();
        d.status = Status.SETTLED;
        // Move the amount from refundable to sweepable. Both branches
        // share the same total balance held by the contract — only the
        // bucket changes.
        address tok = d.paymentToken;
        uint256 amt = d.amount;
        lockedLiability[tok]      -= amt;
        withdrawableBalance[tok]  += amt;
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
        // Release the reservation. Tokens leave the contract; the
        // liability bucket shrinks by exactly the same amount.
        lockedLiability[address(token)] -= amount;
        emit Refunded(invoiceId, payer, amount);
        token.safeTransfer(payer, amount);
    }

    /// @notice Update the treasury sink. Owner-only; non-zero required.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        address prev = treasury;
        treasury = newTreasury;
        emit TreasurySet(prev, newTreasury);
    }

    /// @notice Sweep settled funds to `treasury`. Strictly bounded by
    ///         `withdrawableBalance[token]` — pending (DEPOSITED) and
    ///         refunded amounts are unreachable. Stray transfers into
    ///         the contract are not withdrawable through this path
    ///         (no rescue function by design).
    function withdrawTreasury(address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(0))                        revert TokenNotAllowed();
        if (amount == 0)                                revert InvalidAmount();
        address to = treasury;
        if (to == address(0))                           revert InvalidTreasury();
        if (amount > withdrawableBalance[token])        revert InsufficientWithdrawable();
        // Effects before interaction (CEI + nonReentrant).
        withdrawableBalance[token] -= amount;
        emit TreasuryWithdrawn(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
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
