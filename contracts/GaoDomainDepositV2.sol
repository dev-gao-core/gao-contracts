// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  GaoDomainDepositV2
/// @notice Canonical escrow for `.gao` domain payments — v2.
///
///         Three liability buckets per token, strictly disjoint:
///
///           lockedLiability[token]              — pending DEPOSITED funds (refundable to payer)
///           treasuryWithdrawable[token]         — settled platform revenue (sweepable to `treasury`)
///           affiliateWithdrawable[a][token]     — per-affiliate settled share
///                                                 (self-withdraw or admin-paid)
///         Per-token affiliate aggregate is `totalAffiliateWithdrawable[token]`.
///
///         Strict balance invariant — preserved by every public mutator:
///
///           erc20.balanceOf(this) ≥ lockedLiability[t]
///                                 + treasuryWithdrawable[t]
///                                 + totalAffiliateWithdrawable[t]
///
///         Any positive gap is "excess" (stray transfers / fee-on-transfer
///         residuals); ONLY `rescueExcessToken` may release the excess.
///         The contract refuses any mutation that would underflow this
///         invariant (`ContractUnderCollateralized`).
///
///         Counters (`totalDeposited` / `totalSettled` / `totalRefunded` /
///         `totalTreasuryWithdrawn` / `totalAffiliateWithdrawn` /
///         `totalExcessRescued`) are append-only per token and exist
///         purely for off-chain analytics + audit. They are NOT used in
///         any access-control or balance check; tampering with them via
///         a future upgrade would not break the invariant.
///
/// @dev    Wire compatibility with v1 is partial:
///           - `deposit(buyer, invoiceId, domainHash, token, amount)` SAME signature
///           - `getDeposit(bytes32)` returns a DIFFERENT struct shape
///             (no domainHash / commitmentLeaf / isReserved; gains
///             treasuryAmount, affiliate, affiliateAmount, settledAt,
///             refundedAt). Worker adapter must update.
///           - `isPending(bytes32) returns (bool)` SAME
///           - `Deposited` event SAME (the worker's verifier reads
///             topics + indexed fields only; payload order matches v1)
///           - `settle(bytes32,address,uint256)` NEW signature (v1 was
///             `settle(bytes32)`). Worker must update.
contract GaoDomainDepositV2 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Enums ───────────────────────────────────────────────────────────────

    /// @notice Lifecycle state of a deposit. Wire-stable; the off-chain
    ///         worker mirrors this enum ordering.
    enum Status {
        NONE,        // 0 — no deposit recorded for this invoiceId
        DEPOSITED,   // 1 — funds held in escrow, awaiting settle / refund
        SETTLED,     // 2 — recognized; gross split into treasury + affiliate buckets
        REFUNDED     // 3 — funds returned to payer
    }

    // ── Types ───────────────────────────────────────────────────────────────

    /// @notice Per-invoice record. Mutated only by `deposit / settle / refund`.
    /// @dev    `treasuryAmount`, `affiliate`, `affiliateAmount`, `settledAt`
    ///         are zero until settle. `refundedAt` is zero until refund.
    ///         `grossAmount` is immutable after deposit.
    struct Deposit {
        address payer;
        address buyer;
        address paymentToken;
        uint256 grossAmount;
        uint256 treasuryAmount;
        address affiliate;
        uint256 affiliateAmount;
        Status  status;
        uint64  createdAt;
        uint64  settledAt;
        uint64  refundedAt;
    }

    // ── Storage ─────────────────────────────────────────────────────────────

    mapping(bytes32 => Deposit) private _deposits;

    /// @notice Owner-managed allowlist of ERC-20s accepted as deposit tokens.
    mapping(address => bool) public allowedTokens;

    /// @notice Per-token sum of amounts currently in DEPOSITED state.
    mapping(address => uint256) public lockedLiability;

    /// @notice Per-token sum of settled funds owed to `treasury`.
    mapping(address => uint256) public treasuryWithdrawable;

    /// @notice Per-affiliate per-token settled balance.
    ///         affiliateWithdrawable[affiliate][token] = amount owed.
    mapping(address => mapping(address => uint256)) public affiliateWithdrawable;

    /// @notice Per-token sum of all affiliate balances.
    mapping(address => uint256) public totalAffiliateWithdrawable;

    /// @notice Recipient of `withdrawTreasury` sweeps. Set in constructor;
    ///         updatable by owner; required non-zero.
    address public treasury;

    // Append-only audit counters. Per-token totals; not used in any
    // balance check.
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalSettled;
    mapping(address => uint256) public totalRefunded;
    mapping(address => uint256) public totalTreasuryWithdrawn;
    mapping(address => uint256) public totalAffiliateWithdrawn;
    mapping(address => uint256) public totalExcessRescued;

    // ── Events ──────────────────────────────────────────────────────────────

    event Deposited(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed buyer,
        bytes32 domainHash,
        address paymentToken,
        uint256 grossAmount
    );
    event Settled(
        bytes32 indexed invoiceId,
        address indexed paymentToken,
        uint256 treasuryAmount,
        address indexed affiliate,
        uint256 affiliateAmount
    );
    event Refunded(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed token,
        uint256 grossAmount
    );
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event AllowedTokenUpdated(address indexed token, bool allowed);
    event TreasuryWithdrawn(address indexed token, address indexed treasury, uint256 amount);
    event AffiliateWithdrawn(
        address indexed affiliate,
        address indexed token,
        uint256 amount,
        address caller
    );
    event ExcessTokenRescued(address indexed token, address indexed to, uint256 amount);

    // ── Custom errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidAmount();
    error TokenNotAllowed();
    error InvoiceAlreadyExists();
    error InvoiceNotDeposited();
    error AffiliateAmountExceedsGross();
    error InvalidAffiliateSplit();
    error InsufficientWithdrawable();
    error InsufficientAffiliateBalance();
    error InsufficientExcessBalance();
    error ContractUnderCollateralized();

    // ── Constructor ─────────────────────────────────────────────────────────

    /// @param initialOwner    Receives Ownable rights. Hot EOA in dev; SHOULD
    ///                        be a multisig (Safe) in production. Ownable v5
    ///                        rejects address(0) inside its own constructor.
    /// @param initialTreasury Wallet that receives `withdrawTreasury` sweeps.
    ///                        Required non-zero. Distinct from owner so the
    ///                        controller can be separated from the
    ///                        revenue-receiving wallet.
    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert ZeroAddress();
        treasury = initialTreasury;
        emit TreasuryUpdated(address(0), initialTreasury);
    }

    // ── Admin: tokens / treasury / pause ────────────────────────────────────

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

    /// @notice Pause new deposits. Settle / refund / withdraws / rescue
    ///         all remain available so the operator can wind down
    ///         in-flight deposits during an incident.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ── Deposit (public entry point) ────────────────────────────────────────

    /// @notice Lock `amount` of `token` against `invoiceId`. Wire shape
    ///         matches v1 so an existing wallet / FE flow keeps working.
    function deposit(
        address buyer,
        bytes32 invoiceId,
        bytes32 domainHash,
        address token,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (buyer == address(0))                         revert ZeroAddress();
        if (domainHash == bytes32(0))                    revert InvalidAmount();
        if (amount == 0)                                 revert InvalidAmount();
        if (invoiceId == bytes32(0))                     revert InvalidAmount();
        if (!allowedTokens[token])                       revert TokenNotAllowed();
        if (_deposits[invoiceId].status != Status.NONE)  revert InvoiceAlreadyExists();

        _deposits[invoiceId] = Deposit({
            payer:           msg.sender,
            buyer:           buyer,
            paymentToken:    token,
            grossAmount:     amount,
            treasuryAmount:  0,
            affiliate:       address(0),
            affiliateAmount: 0,
            status:          Status.DEPOSITED,
            createdAt:       uint64(block.timestamp),
            settledAt:       0,
            refundedAt:      0
        });
        lockedLiability[token] += amount;
        totalDeposited[token]  += amount;

        // CEI: write state, then pull tokens. nonReentrant guard is
        // belt-and-braces against malicious ERC-20 hooks.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(invoiceId, msg.sender, buyer, domainHash, token, amount);
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /// @notice Full deposit record. Wire-stable shape for v2; the worker
    ///         adapter consumes this struct directly.
    function getDeposit(bytes32 invoiceId)
        external
        view
        returns (
            address payer,
            address buyer,
            address paymentToken,
            uint256 grossAmount,
            uint256 treasuryAmount,
            address affiliate,
            uint256 affiliateAmount,
            uint8   status,
            uint64  createdAt,
            uint64  settledAt,
            uint64  refundedAt
        )
    {
        Deposit storage d = _deposits[invoiceId];
        return (
            d.payer,
            d.buyer,
            d.paymentToken,
            d.grossAmount,
            d.treasuryAmount,
            d.affiliate,
            d.affiliateAmount,
            uint8(d.status),
            d.createdAt,
            d.settledAt,
            d.refundedAt
        );
    }

    function isPending(bytes32 invoiceId) external view returns (bool) {
        return _deposits[invoiceId].status == Status.DEPOSITED;
    }

    /// @notice Sum of all liability buckets for a token. Off-chain audit
    ///         tooling computes `excess = balanceOf(this) - accountedBalance(t)`.
    function accountedBalance(address token) public view returns (uint256) {
        return lockedLiability[token]
             + treasuryWithdrawable[token]
             + totalAffiliateWithdrawable[token];
    }

    /// @notice Tokens held by the contract that are NOT covered by any
    ///         liability bucket. Reverts with ContractUnderCollateralized
    ///         if the on-chain balance is somehow lower than accounted —
    ///         that case represents a critical bug (or a token whose
    ///         balanceOf has been tampered with), and we surface it
    ///         explicitly rather than returning a misleading zero.
    function excessBalance(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 acct = accountedBalance(token);
        if (bal < acct) revert ContractUnderCollateralized();
        return bal - acct;
    }

    // ── Admin: settle / refund ──────────────────────────────────────────────

    /// @notice Mark a deposit SETTLED, splitting the gross amount between
    ///         the treasury bucket and (optionally) one affiliate. The
    ///         split is provided explicitly by the off-chain worker; the
    ///         contract NEVER derives an affiliate amount on its own.
    /// @param  invoiceId         deposit to settle
    /// @param  affiliate         affiliate wallet, or address(0) if none
    /// @param  affiliateAmount   ≤ gross; must be 0 when affiliate==0,
    ///                           > 0 when affiliate≠0.
    function settle(
        bytes32 invoiceId,
        address affiliate,
        uint256 affiliateAmount
    ) external onlyOwner {
        Deposit storage d = _deposits[invoiceId];
        if (d.status != Status.DEPOSITED) revert InvoiceNotDeposited();
        uint256 gross = d.grossAmount;
        if (affiliateAmount > gross) revert AffiliateAmountExceedsGross();
        if (affiliate == address(0) && affiliateAmount != 0) revert InvalidAffiliateSplit();
        if (affiliate != address(0) && affiliateAmount == 0) revert InvalidAffiliateSplit();

        address token = d.paymentToken;
        uint256 treasuryAmount;
        unchecked {
            treasuryAmount = gross - affiliateAmount; // safe: checked above
        }

        d.status          = Status.SETTLED;
        d.settledAt       = uint64(block.timestamp);
        d.treasuryAmount  = treasuryAmount;
        d.affiliate       = affiliate;
        d.affiliateAmount = affiliateAmount;

        // Move full gross out of the locked-liability bucket. The two
        // destination buckets together absorb exactly `gross`, so the
        // per-token accounted total is unchanged.
        lockedLiability[token]      -= gross;
        treasuryWithdrawable[token] += treasuryAmount;
        if (affiliateAmount > 0) {
            affiliateWithdrawable[affiliate][token] += affiliateAmount;
            totalAffiliateWithdrawable[token]       += affiliateAmount;
        }
        totalSettled[token] += gross;

        emit Settled(invoiceId, token, treasuryAmount, affiliate, affiliateAmount);
    }

    /// @notice Return the deposited tokens to the original payer wallet.
    ///         Permitted only while status is DEPOSITED — once SETTLED
    ///         the funds are split between treasury + affiliate buckets
    ///         and refund() reverts.
    function refund(bytes32 invoiceId) external onlyOwner nonReentrant {
        Deposit storage d = _deposits[invoiceId];
        if (d.status != Status.DEPOSITED) revert InvoiceNotDeposited();

        address token  = d.paymentToken;
        uint256 amount = d.grossAmount;
        address payer  = d.payer;

        d.status     = Status.REFUNDED;
        d.refundedAt = uint64(block.timestamp);

        lockedLiability[token] -= amount;
        totalRefunded[token]   += amount;

        emit Refunded(invoiceId, payer, token, amount);
        IERC20(token).safeTransfer(payer, amount);
    }

    // ── Treasury withdraw ───────────────────────────────────────────────────

    /// @notice Sweep settled treasury funds to `treasury`. Bounded by
    ///         `treasuryWithdrawable[token]`. Owner-gated: the worker
    ///         signs as owner. The destination is always `treasury` —
    ///         the call site cannot redirect revenue.
    function withdrawTreasury(address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0)         revert InvalidAmount();
        address to = treasury;
        if (to == address(0))    revert ZeroAddress();
        if (amount > treasuryWithdrawable[token]) revert InsufficientWithdrawable();

        treasuryWithdrawable[token] -= amount;
        totalTreasuryWithdrawn[token] += amount;

        emit TreasuryWithdrawn(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    // ── Affiliate withdraw ──────────────────────────────────────────────────

    /// @notice Affiliate self-service withdraw. Pulls from the caller's
    ///         own balance only; cannot drain another affiliate's funds.
    function withdrawAffiliate(address token, uint256 amount) external nonReentrant {
        _withdrawAffiliate(msg.sender, token, amount);
    }

    /// @notice Owner pays out an affiliate on their behalf. Funds are
    ///         always routed to the affiliate address — the owner cannot
    ///         redirect affiliate balances to a third party.
    function withdrawAffiliateFor(address affiliate, address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (affiliate == address(0)) revert ZeroAddress();
        _withdrawAffiliate(affiliate, token, amount);
    }

    /// @dev Shared core. Always pays the affiliate (`to == affiliate`).
    function _withdrawAffiliate(address affiliate, address token, uint256 amount) internal {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0)         revert InvalidAmount();
        uint256 bal = affiliateWithdrawable[affiliate][token];
        if (amount > bal) revert InsufficientAffiliateBalance();

        // Effects before interaction.
        affiliateWithdrawable[affiliate][token] = bal - amount;
        totalAffiliateWithdrawable[token]      -= amount;
        totalAffiliateWithdrawn[token]          += amount;

        emit AffiliateWithdrawn(affiliate, token, amount, msg.sender);
        IERC20(token).safeTransfer(affiliate, amount);
    }

    // ── Rescue excess ───────────────────────────────────────────────────────

    /// @notice Release tokens that arrived at the contract outside of
    ///         a tracked deposit (stray transfers, fee-on-transfer
    ///         residuals). Strictly bounded by `excessBalance(token)`.
    ///         Cannot move user deposits, treasury balances, or
    ///         affiliate balances. Reverts when there is no excess.
    function rescueExcessToken(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0))    revert ZeroAddress();
        if (amount == 0)         revert InvalidAmount();

        // excessBalance() reverts on under-collateralization; surface
        // the same error consistently here even though the underflow
        // can't normally happen (bal < accounted only via a buggy
        // or malicious ERC-20).
        uint256 excess = excessBalance(token);
        if (excess == 0)       revert InsufficientExcessBalance();
        if (amount > excess)   revert InsufficientExcessBalance();

        totalExcessRescued[token] += amount;
        emit ExcessTokenRescued(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }
}
