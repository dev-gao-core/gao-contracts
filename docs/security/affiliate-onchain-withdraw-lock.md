# Affiliate Onchain Withdraw Lock — V2 Analysis & V3 Spec & Implementation

> **V3 implementation landed (source + tests).** This doc retains
> the V2 analysis + V3 spec for historical context; the
> implementation, test matrix, and migration ceremony are now
> tracked alongside the source:
>
>   * Contract: `contracts/GaoDomainDepositV3.sol`
>   * Tests:    `test/GaoDomainDepositV3.test.ts` (47 V3 cases)
>   * Migration runbook: `docs/runbooks/v2-to-v3-escrow-migration.md`
>
> **No contract is deployed by the implementation PR.** Deployment
> is an operator-only step per the migration runbook.
>
> Production launch remains **BLOCKED** until V3 is deployed to
> mainnet, V2 is drained + decommissioned, the BE pre-audit blocker
> sequence (`gao-id-worker` Owner-Only Admin Access Impl-A through
> Impl-F + regenerated audit baseline + H-9 first rotation +
> operator production cutover approval) is complete, AND a
> third-party audit of V3 source has been completed.

---

## 1. Scope

Audit the deployed V2 contract for the operator's hardening
requirement:

> *"Affiliate withdraw must be locked onchain, because users can
> call contract `withdrawAffiliate` directly; BE/FE guard alone is
> insufficient."*

In-scope:

- All public / external functions in
  [`contracts/GaoDomainDepositV2.sol`](../../contracts/GaoDomainDepositV2.sol)
  that move tokens from the contract.
- Inherited modifiers from `Ownable`, `Pausable`, `ReentrancyGuard`
  (OpenZeppelin v5).
- Upgradeability status.

Out-of-scope (separate findings):

- BE-side `AUTO_ONCHAIN_SETTLEMENT` / `AUTO_TREASURY_WITHDRAW`
  flags — owned by `gao-id-worker`.
- Treasury withdraw flow — admin-side flow is being built in
  `gao-id-worker` PR 3.
- H-3 signer custody — separate finding in `gao-id-worker`.

## 2. V2 contract surface — the functions that move tokens

| Function | Visibility / Modifiers | Pull or push? | `whenNotPaused`? |
|---|---|---|---|
| `deposit(buyer, invoiceId, domainHash, token, amount)` | `external whenNotPaused nonReentrant` | push (caller→contract) | **YES** |
| `settle(invoiceId, affiliate, affiliateAmount)` | `external onlyOwner` | bookkeeping only — moves accounting buckets; transfers NO tokens | NO (intentional) |
| `refund(invoiceId)` | `external onlyOwner nonReentrant` | push (contract→payer) | NO (intentional) |
| `withdrawTreasury(token, amount)` | `external onlyOwner nonReentrant` | push (contract→treasury) | NO (intentional) |
| **`withdrawAffiliate(token, amount)`** | **`external nonReentrant`** | **pull (contract→`msg.sender`)** | **NO** |
| `withdrawAffiliateFor(affiliate, token, amount)` | `external onlyOwner nonReentrant` | push (contract→affiliate) | NO |
| `rescueExcessToken(token, to, amount)` | `external onlyOwner nonReentrant` | push (contract→to, bounded by excess) | NO |

The two affiliate functions share the same internal helper
`_withdrawAffiliate` ([line 423](../../contracts/GaoDomainDepositV2.sol)),
which always transfers to the `affiliate` parameter and decrements
`affiliateWithdrawable[affiliate][token]` first (effects-before-interaction).

**The bug surface:** `withdrawAffiliate(token, amount)` is publicly
callable by ANY address — `msg.sender` becomes the `affiliate`
parameter. Any wallet whose accumulated `affiliateWithdrawable[wallet][token] > 0`
can drain its balance unilaterally, without operator approval.

## 3. Pause semantics — the explicit non-mitigation

[Line 195-200 of V2](../../contracts/GaoDomainDepositV2.sol):

```solidity
/// @notice Pause new deposits. Settle / refund / withdraws / rescue
///         all remain available so the operator can wind down
///         in-flight deposits during an incident.
function pause() external onlyOwner {
    _pause();
}
```

The contract's documented pause behavior **excludes `withdrawAffiliate`
from `whenNotPaused`** by design. The reasoning at deploy time was
"operator can wind down in-flight deposits during an incident" — a
reasonable goal that becomes a hardening blocker for the new
requirement.

**Implication:** calling `pause()` on the deployed V2 contract does
NOT block public `withdrawAffiliate`. The kill-switch the operator
has on chain today (Pausable) is not the right primitive for this
threat.

## 4. Levers the operator HAS on the deployed V2

Every lever below is enumerated and tested against the requirement
"selectively lock public affiliate self-withdraw":

| Lever | Locks `withdrawAffiliate`? | Why / why not |
|---|---|---|
| `pause()` | NO | `withdrawAffiliate` is not `whenNotPaused` ([§3](#3-pause-semantics-the-explicit-non-mitigation)). |
| `setTreasury(newTreasury)` | NO | Only affects the destination of `withdrawTreasury`; affiliate balances are unaffected. |
| Owner / `transferOwnership(newOwner)` | NO | `withdrawAffiliate` has no `onlyOwner` modifier — anyone can call it. |
| `setAllowedToken(token, false)` | NO | The token allowlist is checked only by `deposit()` (see `if (!allowedTokens[token]) revert TokenNotAllowed();`). `_withdrawAffiliate` does NOT consult `allowedTokens`. |
| Force-credit zero affiliate at settle (BE-side) | PARTIAL | If the worker passes `(affiliate=address(0), affiliateAmount=0)` on every `settle()` call, NEW affiliate balances do not accrue. **Existing** balances remain withdrawable. |
| Drain existing balances via `withdrawAffiliateFor` (admin) | PARTIAL | Operator can pull each affiliate's balance to the affiliate. While balances are non-zero, the affiliate retains the ability to call `withdrawAffiliate` directly. There is a race — admin and affiliate are pulling from the same accounting bucket. |
| Upgrade the contract | NO | V2 is **not upgradeable** (no `Initializable` / `UUPS` / `Proxy`). The deployed bytecode is final. |

**Conclusion:** **NO lever on the deployed V2 can selectively lock
public `withdrawAffiliate` without also locking the rest of the
contract.** The closest available mitigation is "drain existing
balances and stop accruing new ones", but this leaves a race window
in which the affiliate can still self-withdraw faster than the
operator's drain.

## 5. Recommended remediation — `GaoDomainDepositV3`

A new contract (`GaoDomainDepositV3`) that:

1. **Removes the public `withdrawAffiliate(address,uint256)` function
   entirely.** Calling the V2 selector against V3 reverts with the
   default "function does not exist" path. Optionally, V3 ships a
   custom `error WithdrawAffiliateDisabled();` revert at the
   matching selector to give a clear migration signal.
2. **Keeps `withdrawAffiliateFor(affiliate, token, amount)` as the
   sole payout path**, gated by `onlyOwner` AND `whenNotPaused` (the
   new `whenNotPaused` on this function is the second hardening).
   This forces every affiliate payment to be operator-driven AND
   pausable.
3. **Adds onchain two-person rule** (optional, recommended). A
   `affiliate_payouts` mapping `bytes32(proposalId) → Proposal {
   affiliate, token, amount, proposedBy, approvedBy, status }`,
   with:
   - `proposeAffiliatePayout(...)` — `onlyOwner`, status `proposed`.
   - `approveAffiliatePayout(proposalId)` — `onlyOwner`,
     `require(msg.sender != proposedBy)`, status `approved`.
   - `executeAffiliatePayout(proposalId)` — `onlyOwner whenNotPaused`,
     pulls from `affiliateWithdrawable`, transfers to affiliate.
   If the BE-side two-person flow ([gao-id-worker PR 2](../../../gao-id-worker/docs/runbooks/admin-owner-access-model.md))
   is sufficient operationally, this onchain version is optional —
   it adds a second independent layer.
4. **Settle semantics unchanged.** `settle(invoiceId, affiliate,
   affiliateAmount)` keeps the same `(address(0), 0)` allowed-shape
   so the BE can opt out of crediting affiliates per intent.
5. **Pause covers more functions.** Add `whenNotPaused` to
   `withdrawAffiliateFor` (as above). Treasury withdraw stays
   non-paused (operator may need to drain treasury during an
   incident). Settle stays non-paused (so in-flight deposits can
   close out).

## 6. V3 test matrix (when implementation is approved)

| # | Case | Expected |
|---|---|---|
| 1 | Any wallet calls `withdrawAffiliate(token, amount)` against V3 | Revert (function not on the V3 ABI, OR custom `WithdrawAffiliateDisabled` revert) |
| 2 | Owner calls `withdrawAffiliateFor(affiliate, token, amount)` against V3, unpaused | Success — affiliate balance decremented, token transferred to affiliate |
| 3 | Non-owner calls `withdrawAffiliateFor` | Revert `OwnableUnauthorizedAccount` |
| 4 | Owner calls `withdrawAffiliateFor` while paused | Revert `EnforcedPause` |
| 5 | Owner calls `pause()` then attempts `withdrawAffiliateFor` | Revert |
| 6 | Owner calls `settle(invoiceId, address(0), 0)` against V3 | Success — no affiliate credit; treasury bucket fully credited |
| 7 | Owner calls `settle(invoiceId, affiliate, amount > 0)` against V3 | Success — affiliate balance credited; affiliate still cannot pull directly (only owner-driven `withdrawAffiliateFor` works) |
| 8 | No code path moves tokens automatically on settle | Verified by `settle()` containing zero `IERC20.safeTransfer` calls (bookkeeping only) |
| 9 | Onchain proposer/approver two-person rule (if implemented): proposer attempts approve | Revert |
| 10 | Onchain proposer/approver two-person rule: approver attempts execute without approval | Revert |
| 11 | Onchain proposer/approver two-person rule: approved + executed → state moves through proposed → approved → executed | Success, event chain emitted |

## 7. V2 → V3 migration ceremony (when V3 is deployed)

This is an **operator-only ceremony**, NOT part of this PR. Listed
here so the operator can review the full picture before approving
V3 implementation.

1. **Deploy V3** to the target chain with the same `treasury`
   address as V2 and `allowedTokens` initialised to the same set.
   Verify on the explorer.
2. **Pause V2 deposits.** Call `pause()` on V2. New `deposit()`
   calls revert; in-flight settles + refunds + withdraws still work.
3. **Update BE config** ([gao-id-worker payment.config.ts](../../../gao-id-worker/src/payments/payment.config.ts)):
   - Add V3 address as the new `GAO_DOMAIN_ESCROW_ADDRESS`.
   - Keep V2 address only as a known-historical hard-block, the same
     way the V1 address (`0xcFC746DF306Fa0C4512CA98f83aC7B6B143c2a13`)
     is hard-blocked today.
4. **Drain V2.** Operator pulls remaining affiliate balances via
   `withdrawAffiliateFor` (with PR 2's two-person approval flow),
   and treasury balance via `withdrawTreasury`. Wait until
   `accountedBalance(token) == 0` for every allowed token.
5. **Decommission V2.** Mark V2 in the operator inventory as
   "decommissioned" — no further operator action needed; the
   contract is immutable and now holds no value.
6. **Smoke V3.** Operator runs the V3 test matrix (§6) against the
   deployed V3 using a test EOA / test funds. Captures evidence.
7. **Operator cutover approval.** Captured in the operator-only
   sign-off artifact per `gao-id-worker` PR 1B + future PR 4 / PR 5.

## 8. Risk during the V2-to-V3 window

While V2 is still live (steps 2–4 above), an affiliate with a
non-zero `affiliateWithdrawable[wallet][token]` can still call
`withdrawAffiliate` and drain their own balance. **This is by
design of V2 and cannot be prevented on V2.** Risk-controls during
this window:

- **Stop accruing.** The BE-side `AFFILIATE_LEDGER_CREDIT_ENABLED`
  flag (from `gao-id-worker` PR 2) ensures no new affiliate credit
  accumulates on V2 from the moment the flag flips to `false`.
- **Race the drain.** Operator's `withdrawAffiliateFor` calls race
  against possible affiliate self-withdraws. Affiliate "wins" some
  races; the operator wins others. Either way, the destination of
  the funds is the same address (the affiliate) — there is no
  custody loss, only a non-repudiation gap (the affiliate's
  unilateral pulls are not in the operator's two-person audit
  trail).
- **No financial loss.** All paths route to the same affiliate
  address. The risk is governance / non-repudiation, not theft.

This risk window is bounded by the operator's drain pace. The
operator should aim to drain V2 within a single business day after
flipping `AFFILIATE_LEDGER_CREDIT_ENABLED=false`.

## 9. What was shipped

**Original spec-only PR (#9, merged):**

- **This document** (`docs/security/affiliate-onchain-withdraw-lock.md`).
- No V3 contract source. No tests. No deployment script.

**V3 implementation PR (`GaoDomainDepositV3 Affiliate Withdraw
Lock`, this revision):**

- `contracts/GaoDomainDepositV3.sol` — full Solidity source
  implementing the §5 spec WITHOUT the optional §5.3 onchain
  two-person rule (BE-side Impl-D + Impl-E in `gao-id-worker`
  provides the equivalent off-chain guarantee). V3 changes vs V2:
  - `withdrawAffiliate(address,uint256)` ALWAYS reverts with custom
    error `AffiliateSelfWithdrawDisabled`. The V2 selector is
    preserved so old clients fail loudly, not silently.
  - `withdrawAffiliateFor(affiliate, token, amount)` is now
    `whenNotPaused`. Pausing V3 halts the affiliate payout pipeline.
  - Everything else (deposit / settle / refund / withdrawTreasury /
    rescueExcessToken / events / storage layout / selectors / read
    shape) is byte-identical to V2. The BE adapter that reads V2
    reads V3 unchanged.
- `test/GaoDomainDepositV3.test.ts` — 47 tests:
  - 5 cases on `withdrawAffiliate` self-withdraw revert (affiliate /
    random / owner / zero-amount / zero-credit).
  - 11 cases on `withdrawAffiliateFor` owner-driven payout (happy /
    non-owner / affiliate-as-caller / paused / resume / redirect
    attempt / cross-affiliate drain / zero-address / zero-amount /
    over-balance / token=0).
  - 3 cases on `settle` ledger-only (no auto-push) semantics
    including ERC-20 Transfer-event absence.
  - 2 cases on treasury-withdraw remaining non-paused per spec.
  - 23 V2-safety regression cases (constructor / setTreasury /
    setAllowedToken / deposit / pause-blocks-deposit / settle
    happy + revert paths / refund / treasury withdraw / rescue /
    invariants / non-owner refusal of every onlyOwner function).
  - 3 ABI/storage compatibility cases (selectors byte-equal to V2,
    storage getter shape preserved, getDeposit returns same
    11-tuple).
- `docs/runbooks/v2-to-v3-escrow-migration.md` — operator-only
  migration ceremony (deploy V3 / smoke V3 / pause V2 / drain V2 /
  hard-block V2 in BE config / switch BE to V3 / decommission V2 /
  evidence checklist / rollback conditions / production cutover
  gate).
- **No deployment script for mainnet.** No `wrangler secret put`.
  No `npx hardhat run scripts/deployV3.ts`. The V3 deploy is
  operator-driven from a trusted workstation as documented in the
  migration runbook.

## 10. Status language (do not weaken)

- Public V2 `withdrawAffiliate(address,uint256)` is a **PRODUCTION
  BLOCKER**.
- V2 is **immutable** — no upgrade path on the deployed bytecode.
- **V3 source + tests have landed.** V3 is **NOT deployed.**
- **V3 deployment is required** before production launch.
- BE-side guardrails (`AFFILIATE_LEDGER_CREDIT_ENABLED=false`,
  admin-only `withdrawAffiliateFor` queue) are **necessary but not
  sufficient**: they prevent new accrual but cannot defend against
  affiliates withdrawing accumulated balances unilaterally on V2.
- Production launch remains **BLOCKED** until V3 is deployed to
  mainnet, V2 is drained + decommissioned, a third-party audit of
  V3 source is completed, and the BE pre-audit blocker sequence is
  complete.

## 11. Open questions for operator review

1. **V3 scope** — onchain two-person rule (§5 point 3) yes/no? The
   BE will enforce two-person rule via PR 2 of the
   `gao-id-worker` remediation; an onchain second layer adds defence
   in depth at the cost of more contract code and gas. Recommend
   yes for value-bearing chains (mainnet, prod treasury); optional
   for dev/test.
2. **Token allowlist** — should V3 also gate `withdrawAffiliateFor`
   on the same allowlist that `deposit()` enforces, so a token
   removed from the allowlist becomes unwithdrawable? Recommend
   no — that would orphan affiliate balances if a token is later
   removed.
3. **V3 audit** — V3 is small (≈ 30-50 lines of net new code over
   V2 with the onchain two-person rule, ≈ 5-10 lines without).
   Recommend operator-paid third-party audit before mainnet
   deployment.
4. **V2 v1 hard-block pattern** — current
   `payment.config.ts:loadPaymentConfig` hard-blocks the v1 escrow
   address. Recommend adding V2 to the hard-block list once V2 is
   decommissioned, so a misconfiguration cannot route worker
   traffic back to the un-locked V2 surface.
