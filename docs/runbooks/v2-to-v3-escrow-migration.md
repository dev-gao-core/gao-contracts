# V2 → V3 Escrow Migration Runbook

> **Operator-only ceremony.** Not part of any code-only PR. This
> runbook describes the steps to take the deployed `GaoDomainDepositV2`
> contract out of production and bring the V3 contract online with
> zero custody loss.
>
> **Status as of this revision:** V3 source + tests are merged in
> `gao-contracts` (PR opened by *GaoDomainDepositV3 Affiliate Withdraw
> Lock*). **V3 is NOT deployed.** Production launch remains BLOCKED.

---

## 1. Purpose

The deployed `GaoDomainDepositV2` at Base Sepolia
`0xd14fa3fb57494d23C21C2E8a3B7b7b06a3A312f0` carries a documented
hardening blocker: public `withdrawAffiliate(address,uint256)` lets
any wallet with non-zero `affiliateWithdrawable[wallet][token]`
pull funds unilaterally, without operator approval. V2 is immutable
— the deployed bytecode has no upgrade path — so this blocker
cannot be fixed in-place.

`GaoDomainDepositV3` is a new contract (new address on every chain)
that hardens the affiliate path:

- `withdrawAffiliate(address,uint256)` ALWAYS reverts with custom
  error `AffiliateSelfWithdrawDisabled`.
- `withdrawAffiliateFor(affiliate, token, amount)` is `onlyOwner` +
  `whenNotPaused` + `nonReentrant`; funds always route to the
  `affiliate` parameter (the owner cannot redirect).
- Every other V2 surface is preserved byte-for-byte (selectors,
  events, storage layout, behaviours). The BE adapter that reads V2
  reads V3 without any decoder change.

See `docs/security/affiliate-onchain-withdraw-lock.md` for the
detailed analysis.

## 2. Prerequisites — must be true BEFORE the operator starts

1. V3 source merged on `main` of `dev-gao-core/gao-contracts`.
2. V3 hardhat test suite green on CI (123 tests).
3. Operator has reviewed V3 against the spec in
   `docs/security/affiliate-onchain-withdraw-lock.md` §5 and signed
   off in the operator change-control record.
4. BE-side `gao-id-worker` PR has landed a hard-block list with the
   current V1 escrow address; the migration adds V2 to the same
   list in step 7.
5. A two-person operator approval channel exists (BE-side: Impl-D
   multisign in `gao-id-worker`; or out-of-band ceremony recorded
   in the operator change-control record).
6. The operator has confirmed the dev/test signer custody surface
   (H-3 dev/test closure report). **Mainnet operator approval is a
   SEPARATE go/no-go decision and is out of scope of this runbook.**

## 3. Deploy V3 (dev/test only)

> Mainnet deploy is out of scope. The mainnet ceremony is a separate
> operator-approved runbook to be drafted only after dev/test smoke
> + audit baseline regeneration + operator cutover approval.

1. Operator (NOT this PR / NOT the CI) runs the dev/test deploy
   from a trusted workstation with a wrangler-/Hardhat-secret
   deployer key:

   ```sh
   # Dev/test only. Mainnet has a separate runbook.
   export DEPLOYER_PRIVATE_KEY="<set via 1Password / secrets vault — never committed>"
   export BASE_SEPOLIA_RPC_URL="https://..."
   export BASESCAN_API_KEY="<from Basescan>"
   npx hardhat run scripts/deployV3.ts --network baseSepolia
   ```

   (`scripts/deployV3.ts` is NOT part of this PR. It will be drafted
   alongside the operator-approved deploy step. The drafted script
   MUST set `initialTreasury` to the same value as the deployed V2,
   and `initialOwner` to the operator's controlled key — same hot-EOA
   pattern as V2 in dev/test, multisig in production.)

2. Verify on Basescan:
   ```sh
   npx hardhat verify --network baseSepolia <V3_ADDRESS> <INITIAL_OWNER> <INITIAL_TREASURY>
   ```
   The verifier must publish source + ABI before any BE config
   references the new address.

3. Initialise the V3 token allowlist to the exact same set as V2:
   ```sh
   # For each USDC / allowed-token address that V2 currently
   # accepts, call setAllowedToken(token, true) on V3 from the
   # operator wallet.
   ```

4. Capture evidence:
   - V3 deployed transaction hash + V3 contract address.
   - Basescan verification proof URL.
   - Deployer wallet address (NOT private key).
   - Block number at deploy time.
   - Constructor args (initial owner + initial treasury).

## 4. Smoke V3 against the test matrix

Run the full V3 hardhat suite against the deployed contract via a
test EOA / test funds, mirroring §6 of
`docs/security/affiliate-onchain-withdraw-lock.md`:

| # | Case | Pass / Fail |
|---|---|---|
| 1 | Affiliate calls `withdrawAffiliate(token, amount)` → revert `AffiliateSelfWithdrawDisabled` | |
| 2 | Random non-affiliate wallet calls `withdrawAffiliate` → revert (same error) | |
| 3 | Owner calls `withdrawAffiliateFor(aff, token, amount)` unpaused → success, funds at `aff` | |
| 4 | Non-owner calls `withdrawAffiliateFor` → revert `OwnableUnauthorizedAccount` | |
| 5 | Owner calls `pause()` then `withdrawAffiliateFor` → revert `EnforcedPause` | |
| 6 | Owner calls `unpause()` then `withdrawAffiliateFor` → success | |
| 7 | Owner calls `settle(invoiceId, address(0), 0)` → success, treasury bucket credited | |
| 8 | Owner calls `settle(invoiceId, affiliate, > 0)` → success, affiliate bucket credited; affiliate cannot pull directly | |
| 9 | `settle` emits no ERC-20 Transfer event for the payment token (bookkeeping only) | |
| 10 | `withdrawTreasury` succeeds while paused (treasury-drain during incident) | |
| 11 | `deposit` blocked while paused | |
| 12 | `refund` works while paused | |

Capture pass/fail evidence for each case (block explorer tx URLs).
Do NOT proceed to the BE cutover until all 12 pass.

## 5. Pause V2 deposits

Once V3 smoke is green:

1. Operator calls `pause()` on the deployed V2 contract from the
   V2 owner wallet.

   ```solidity
   // On the deployed V2 contract.
   v2.pause();
   ```

2. Verify by attempting a `deposit()` against V2 — must revert
   `EnforcedPause`.

3. Note: V2's `pause()` does NOT block public `withdrawAffiliate`.
   Affiliates with non-zero balances CAN still self-withdraw during
   the drain window. The drain in step 6 is timed to minimise this
   window — see step 8 for the residual-risk discussion.

## 6. Drain V2 safely

For every token allowed on V2 AND for every affiliate with a
non-zero `affiliateWithdrawable[aff][token]`:

1. **Disable new affiliate accrual.** BE-side, set
   `AFFILIATE_LEDGER_CREDIT_ENABLED=false` in `gao-id-worker` (or
   the equivalent flag) so future `settle()` calls pass
   `(address(0), 0)` and do not credit any new affiliate balance on
   V2. The flag flip MUST be evidenced in the operator change log.

2. **Pull each affiliate balance via `withdrawAffiliateFor`.** Use
   the operator HMAC / owner key (V2 path — V3 has not yet
   replaced V2). Run one call per (affiliate, token) tuple:

   ```solidity
   v2.withdrawAffiliateFor(affiliate, token, balance);
   ```

3. **Drain treasury.** Once affiliate balances are zero, pull the
   treasury balance:

   ```solidity
   v2.withdrawTreasury(token, treasuryWithdrawableForToken);
   ```

4. **Confirm `accountedBalance(token) == 0`** for every allowed
   token on V2 via the read API:

   ```solidity
   v2.accountedBalance(token);   // expected 0
   v2.excessBalance(token);      // any leftover is "excess" / stray
   ```

5. **Rescue excess** if present (stray transfers / fee-on-transfer
   residuals) to the operator wallet via `rescueExcessToken`. Note
   in the evidence log.

6. Capture evidence:
   - Each `withdrawAffiliateFor` tx hash + amount + affiliate addr.
   - Each `withdrawTreasury` tx hash + amount.
   - Each `rescueExcessToken` tx hash + amount + destination.
   - Final `accountedBalance` per token (must be 0).
   - Final `excessBalance` per token (must be 0).

## 7. Hard-block V2 in BE config

Before flipping any BE traffic to V3:

1. Add the V2 address (`0xd14fa3fb57494d23C21C2E8a3B7b7b06a3A312f0`
   on Base Sepolia; mainnet address TBD when mainnet V2 is
   deployed) to the BE hard-block list in
   `gao-id-worker/src/payments/payment.config.ts` alongside the V1
   address `0xcFC746DF306Fa0C4512CA98f83aC7B6B143c2a13`.

2. The hard-block ensures a misconfiguration cannot route worker
   traffic back to the un-locked V2 surface. The BE refuses to
   construct any tx targeting a hard-blocked address.

3. Ship the BE update as its own PR + merge before the cutover.
   Capture the BE PR URL in the migration evidence.

## 8. Switch BE to V3

1. Update `gao-id-worker` `GAO_DOMAIN_ESCROW_ADDRESS` secret (or
   per-environment binding) to the V3 deployed address from step 3.
2. Re-deploy `gao-id-worker` to the dev/test tier.
3. Verify the `/v2/contracts/health` endpoint reports `healthy`
   against V3.
4. Run a small live deposit + settle + treasury-withdraw cycle
   end-to-end on V3 (dev/test funds only). Capture evidence.

## 9. Decommission V2

Once V3 is taking traffic and V2 has zero accounted balance:

1. Mark V2 in the operator change log as "decommissioned" — no
   further operator action needed; the contract is immutable and
   now holds no value.
2. Keep V2 paused (deposits already blocked from step 5).
3. Retain V2 in the BE hard-block list permanently.

## 10. Evidence checklist

Captured by the operator into the change-control record:

- [ ] V3 deploy tx hash + contract address (per chain).
- [ ] Basescan / Etherscan verification proof URL (per chain).
- [ ] V3 init owner + treasury constructor args.
- [ ] V3 token allowlist init txs.
- [ ] V3 smoke matrix (§4) — 12 cases, each pass with evidence URL.
- [ ] `AFFILIATE_LEDGER_CREDIT_ENABLED=false` flag-flip evidence.
- [ ] V2 `pause()` tx hash.
- [ ] V2 drain `withdrawAffiliateFor` tx hashes (one per affiliate).
- [ ] V2 drain `withdrawTreasury` tx hashes.
- [ ] V2 `rescueExcessToken` tx hashes (if any).
- [ ] V2 final `accountedBalance` per token (must be 0).
- [ ] V2 final `excessBalance` per token (must be 0).
- [ ] BE hard-block PR URL (V2 added).
- [ ] BE `gao-id-worker` config update PR URL (V3 address wired).
- [ ] BE health check against V3 passing.
- [ ] Live small cycle on V3 (deposit + settle + treasury) tx URLs.
- [ ] Operator change-control record sign-off (two-person rule).

## 11. Rollback conditions

If ANY of the following happens, the operator pauses V3 immediately
(`v3.pause()`) AND files an incident report. **The migration does
NOT roll back to V2** — V2 remains decommissioned. Rollback means
"halt V3 and assess".

- V3 smoke matrix (§4) fails any case.
- V3 invariant fails at any point: `balanceOf(V3) <
  lockedLiability + treasuryWithdrawable + totalAffiliateWithdrawable`.
- An unexpected revert path is observed on a happy-path tx.
- An off-cluster monitor reports a divergence between V3 read API
  + BE bookkeeping.
- Any wallet other than the affiliate parameter receives funds on a
  `withdrawAffiliateFor` call (this would be a critical V3 bug).

Re-enabling V3 after rollback requires:

1. Root-cause analysis of the trigger.
2. Patch + new V3 version (V3.1) deployed at a NEW address.
3. Migration of V3-state funds following this same runbook with
   V3 in the role of "V2".
4. Two-person operator sign-off in the change-control record.

## 12. Risk during the drain window (steps 5 → 7)

V2 is paused (no new deposits), `AFFILIATE_LEDGER_CREDIT_ENABLED`
is `false` (no new affiliate accrual), AND the operator is pulling
existing affiliate balances via `withdrawAffiliateFor`. Affiliates
with non-zero pre-existing balances CAN still call
`withdrawAffiliate(token, amount)` directly on V2 — the V2
contract's pause does not block this.

Because every payout (operator-pulled OR affiliate-pulled) routes
to the same affiliate address, **no custody loss is possible**. The
race is purely about which path is in the operator's audit trail:

- Operator-pulled → in the operator's two-person change log.
- Affiliate-pulled → on chain only; NOT in the operator's audit
  trail.

Operator SHOULD aim to drain V2 within a single business day of
flipping `AFFILIATE_LEDGER_CREDIT_ENABLED=false`. Any
affiliate-self-pull is recorded on chain (V2 `AffiliateWithdrawn`
event) and can be cross-referenced from BE post-migration.

## 13. Production cutover gate

This runbook covers dev/test only. Mainnet cutover requires, IN
ADDITION TO THE ABOVE:

- [ ] Third-party audit of V3 source.
- [ ] H-3 production custody decision (external signer service
      live + first H-9 rotation executed).
- [ ] Regenerated audit baseline incorporating Impl-A through
      Impl-F of the BE owner-only admin access work (`gao-id-worker`).
- [ ] Operator change-control record signed off by two principals.
- [ ] Operator-controlled deployer key custody confirmed (1Password
      / KMS — NEVER committed, NEVER passed through CI).
- [ ] No `wrangler secret put` / no `hardhat run scripts/deploy*.ts`
      runs from CI for mainnet. All mainnet ops are operator-side
      from a trusted workstation.

Production launch remains **BLOCKED** until all of the above are
complete.
