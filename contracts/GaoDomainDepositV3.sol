// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  GaoDomainDepositV3
/// @notice Canonical escrow for `.gao` domain payments — v3.
///
///         V3 is a security hardening of V2. The only behavioural
///         changes vs V2 are:
///
///           1. **Public self-service affiliate withdraw is REMOVED.**
///              `withdrawAffiliate(token, amount)` keeps the same
///              ABI selector as V2 so old clients that target the V2
///              selector against a V3 deployment receive a clear,
///              decode-able revert (`AffiliateSelfWithdrawDisabled`)
///              instead of the generic "function does not exist" /
///              empty-fallback path. The function ALWAYS reverts —
///              no caller can ever pull affiliate funds.
///           2. **`withdrawAffiliateFor` is now `whenNotPaused`.**
///              The operator-driven affiliate payout path can be
///              kill-switched during an incident. V2's analogue was
///              not pausable.
///           3. **Affiliate ledger still accrues normally.**
///              `settle(invoiceId, affiliate, affiliateAmount)`
///              continues to credit `affiliateWithdrawable[affiliate][token]`
///              with the same semantics as V2 — the only difference
///              is that the credited balance can be released ONLY
///              through the owner-driven, pausable
///              `withdrawAffiliateFor` path. There is no self-service
///              exit and no automatic on-settle transfer.
///
///         Everything else is byte-identical V2 behaviour:
///
///           * Three liability buckets per token, strictly disjoint:
///               lockedLiability[token]
///               treasuryWithdrawable[token]
///               affiliateWithdrawable[affiliate][token]
///                 (aggregated by `totalAffiliateWithdrawable[token]`)
///
///           * Strict balance invariant preserved by every mutator:
///               erc20.balanceOf(this) >= lockedLiability[t]
///                                      + treasuryWithdrawable[t]
///                                      + totalAffiliateWithdrawable[t]
///             Any positive gap is "excess"; ONLY `rescueExcessToken`
///             may release it. Any mutation that would underflow the
///             invariant reverts with `ContractUnderCollateralized`.
///
///           * Treasury withdraw (`withdrawTreasury`) remains
///             non-paused so the operator can drain settled treasury
///             funds during an incident response. (Per the V3 spec.)
///
///           * Settle remains `onlyOwner` (no `whenNotPaused`) so
///             in-flight deposits can close out while the contract
///             is paused.
///
///           * Refund remains `onlyOwner` (no `whenNotPaused`) so
///             in-flight refunds can complete while the contract is
///             paused.
///
///           * Token allowlist (`allowedTokens` / `setAllowedToken`)
///             remains enforced at `deposit()` only — same as V2 —
///             so a token removed from the allowlist post-credit
///             does not orphan affiliate / treasury balances (the
///             owner-driven `withdrawAffiliateFor` and
///             `withdrawTreasury` ignore the allowlist by design).
///
/// @dev    Wire compatibility with V2:
///           - Constructor signature SAME: `(initialOwner, initialTreasury)`.
///           - `deposit(buyer, invoiceId, domainHash, token, amount)` SAME.
///           - `settle(bytes32, address, uint256)` SAME.
///           - `refund(bytes32)` SAME.
///           - `withdrawTreasury(token, amount)` SAME.
///           - `withdrawAffiliate(address, uint256)` SAME SELECTOR /
///             ALWAYS REVERTS with `AffiliateSelfWithdrawDisabled()`.
///           - `withdrawAffiliateFor(affiliate, token, amount)` SAME
///             selector / ADDED `whenNotPaused` modifier.
///           - `rescueExcessToken(token, to, amount)` SAME.
///           - Event signatures SAME.
///           - Read shape (`getDeposit`, `isPending`,
///             `accountedBalance`, `excessBalance`, public storage
///             getters) SAME — the BE adapter that reads V2 can
///             read V3 without any decoder change.
///
///         **Migration ceremony** (operator-only, NOT part of this
///         PR): see `docs/runbooks/v2-to-v3-escrow-migration.md`.
///         **V3 is not deployed by this PR.** Production launch
///         remains BLOCKED until V3 is deployed, V2 is drained +
///         decommissioned, and the BE-side pre-audit blocker
///         sequence is complete.
contract GaoDomainDepositV3 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Enums ───────────────────────────────────────────────────────────────

    /// @notice Lifecycle state of a deposit. Wire-stable; the off-chain
    ///         worker mirrors this enum ordering. Identical to V2.
    enum Status {
        NONE,        // 0 — no deposit recorded for this invoiceId
        DEPOSITED,   // 1 — funds held in escrow, awaiting settle / refund
        SETTLED,     // 2 — recognized; gross split into treasury + affiliate buckets
        REFUNDED     // 3 — funds returned to payer
    }

    // ── Types ───────────────────────────────────────────────────────────────

    /// @notice Per-invoice record. Mutated only by `deposit / settle / refund`.
    ///         Wire-stable; identical to V2.
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
    ///
    ///         **V3 lock contract:** this balance can only be moved
    ///         to the affiliate via the owner-driven, pausable
    ///         `withdrawAffiliateFor` path. There is no self-service
    ///         exit on V3 — `withdrawAffiliate` always reverts with
    ///         `AffiliateSelfWithdrawDisabled`.
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

    /// @notice V3-specific: public self-service affiliate withdraw
    ///         is permanently disabled at the contract layer. The
    ///         only payout path is owner-driven
    ///         `withdrawAffiliateFor`, which is `onlyOwner`,
    ///         `whenNotPaused`, `nonReentrant`, and always pays the
    ///         affiliate address (the owner cannot redirect funds).
    error AffiliateSelfWithdrawDisabled();

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

    /// @notice Pause new deposits AND `withdrawAffiliateFor`. Settle /
    ///         refund / treasury-withdraw / rescue remain available so
    ///         the operator can wind down in-flight deposits AND drain
    ///         settled treasury revenue during an incident even when
    ///         the contract is paused.
    ///
    ///         **V3 change vs V2:** pause now ALSO blocks
    ///         `withdrawAffiliateFor`. V2's pause did not stop the
    ///         operator-driven affiliate payout path; V3's does.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ── Deposit (public entry point) ────────────────────────────────────────

    /// @notice Lock `amount` of `token` against `invoiceId`. Wire shape
    ///         matches V2 / V1 so an existing wallet / FE flow keeps
    ///         working.
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

    /// @notice Full deposit record. Wire-stable shape — identical to V2;
    ///         the worker adapter consumes this struct directly.
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
    ///
    ///         **No tokens move on settle.** The function adjusts the
    ///         three accounting buckets atomically: `lockedLiability`
    ///         decreases by `gross`, `treasuryWithdrawable` increases
    ///         by `gross - affiliateAmount`, and (if an affiliate was
    ///         named) `affiliateWithdrawable[affiliate][token]`
    ///         increases by `affiliateAmount`. The contract holds the
    ///         same `gross` tokens as before; only the bookkeeping
    ///         changes. **There is NO automatic on-settle transfer
    ///         to the affiliate.** Releasing affiliate funds requires
    ///         an explicit owner call to `withdrawAffiliateFor` while
    ///         the contract is not paused.
    ///
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
    ///
    ///         **Not `whenNotPaused`.** Per the V3 spec, the operator
    ///         retains the ability to drain settled treasury funds
    ///         during an incident even when the contract is paused.
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

    /// @notice **V3 LOCK** — public self-service affiliate withdraw is
    ///         permanently disabled. The function preserves the V2
    ///         selector so an old client that targets the V2 ABI
    ///         against a V3 deployment receives a clear, decode-able
    ///         revert (`AffiliateSelfWithdrawDisabled`) instead of
    ///         the generic "function not found" / empty-fallback path.
    ///
    ///         There is no internal branch and no admin override:
    ///         every call reverts. The only affiliate payout path on
    ///         V3 is `withdrawAffiliateFor`, owner-driven and pausable.
    ///
    /// @dev    `_token` and `_amount` are unused; named to match the
    ///         V2 selector. Solidity's unused-argument warning is
    ///         silenced by the parameter names (no `_` prefix
    ///         convention because the selector must match V2 exactly).
    // solhint-disable-next-line no-empty-blocks
    function withdrawAffiliate(address /* token */, uint256 /* amount */)
        external
        pure
    {
        revert AffiliateSelfWithdrawDisabled();
    }

    /// @notice Owner pays out an affiliate on their behalf. Funds are
    ///         always routed to the affiliate address — the owner
    ///         cannot redirect affiliate balances to a third party.
    ///
    ///         **V3 changes vs V2:**
    ///           * Now `whenNotPaused`. Pausing the contract halts
    ///             the affiliate payout pipeline.
    ///           * Remains the only path to release accrued
    ///             affiliate balances (since `withdrawAffiliate` is
    ///             permanently disabled).
    function withdrawAffiliateFor(address affiliate, address token, uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (affiliate == address(0)) revert ZeroAddress();
        _withdrawAffiliate(affiliate, token, amount);
    }

    /// @dev Shared core. Always pays the affiliate (`to == affiliate`).
    ///      Identical to V2's `_withdrawAffiliate` semantics, except
    ///      that the only public caller is the pausable
    ///      `withdrawAffiliateFor`.
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
