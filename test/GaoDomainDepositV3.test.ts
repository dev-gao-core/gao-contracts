// GaoDomainDepositV3 unit tests.
//
// V3 hardens V2 against the public-affiliate-self-withdraw blocker
// documented in `docs/security/affiliate-onchain-withdraw-lock.md`.
// The behavioural changes vs V2 (and therefore the new tests here)
// are:
//
//   1. `withdrawAffiliate(token, amount)` ALWAYS reverts with
//      `AffiliateSelfWithdrawDisabled` — no caller, ever, can pull
//      affiliate funds via the V2 selector.
//   2. `withdrawAffiliateFor(affiliate, token, amount)` is now
//      `whenNotPaused`. Pausing the contract halts the affiliate
//      payout pipeline.
//   3. `settle()` continues to credit `affiliateWithdrawable` but
//      MUST NOT auto-push funds (verified by checking no token
//      balance flows on the settle tx).
//
// Every V2 invariant is re-asserted on V3 (deposit/settle/refund/
// treasury/rescue/allowlist/pause-blocks-deposit) so a future
// regression in V3 cannot silently weaken the core accounting.

import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const D_NONE = 0n;
const D_DEPOSITED = 1n;
const D_SETTLED = 2n;
const D_REFUNDED = 3n;

// Index positions inside the getDeposit() return tuple. Identical
// to V2's layout — the BE adapter reads V3 with the same decoder.
const GD = {
  payer:           0,
  buyer:           1,
  paymentToken:    2,
  grossAmount:     3,
  treasuryAmount:  4,
  affiliate:       5,
  affiliateAmount: 6,
  status:          7,
  createdAt:       8,
  settledAt:       9,
  refundedAt:      10,
} as const;

describe("GaoDomainDepositV3", () => {
  async function deployFresh() {
    const [owner, payer, buyer, affiliate, otherAffiliate, treasury, attacker, redirectTarget] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Other = await ethers.getContractFactory("MockERC20");
    const otherToken = await Other.deploy();
    await otherToken.waitForDeployment();

    const Escrow = await ethers.getContractFactory("GaoDomainDepositV3");
    const escrow = await Escrow.deploy(
      await owner.getAddress(),
      await treasury.getAddress(),
    );
    await escrow.waitForDeployment();

    await (await escrow.setAllowedToken(await token.getAddress(), true)).wait();

    // Fund payer with 10,000 USDC (room for many deposits).
    await (await token.mint(await payer.getAddress(), 10_000_000_000n)).wait();

    return {
      owner,
      payer,
      buyer,
      affiliate,
      otherAffiliate,
      treasury,
      attacker,
      redirectTarget,
      token,
      otherToken,
      escrow,
      tokenAddr: await token.getAddress(),
      otherTokenAddr: await otherToken.getAddress(),
      escrowAddr: await escrow.getAddress(),
      treasuryAddr: await treasury.getAddress(),
    };
  }

  function ids(seed = "pi_v3_001", domain = "kingv3.gao") {
    return {
      invoiceId: ethers.keccak256(ethers.toUtf8Bytes(seed)),
      domainHash: ethers.keccak256(ethers.toUtf8Bytes(domain)),
    };
  }

  async function fundAndDeposit(
    fx: Awaited<ReturnType<typeof deployFresh>>,
    amount: bigint,
    seed = "pi_v3_001",
    domain = "kingv3.gao",
  ) {
    const { payer, buyer, escrow, tokenAddr, escrowAddr } = fx;
    const { invoiceId, domainHash } = ids(seed, domain);
    await (await fx.token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);
    return { invoiceId, domainHash };
  }

  async function fundDepositAndSettleToAffiliate(
    fx: Awaited<ReturnType<typeof deployFresh>>,
    grossAmount: bigint,
    affiliateAmount: bigint,
    seed = "pi_v3_set",
    domain = "set.gao",
  ) {
    const { invoiceId } = await fundAndDeposit(fx, grossAmount, seed, domain);
    const aff = await fx.affiliate.getAddress();
    await (await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affiliateAmount)).wait();
    return { invoiceId, aff };
  }

  async function expectInvariant(fx: Awaited<ReturnType<typeof deployFresh>>) {
    const { escrow, tokenAddr, escrowAddr, token } = fx;
    const locked: bigint = await escrow.lockedLiability(tokenAddr);
    const tw: bigint = await escrow.treasuryWithdrawable(tokenAddr);
    const aw: bigint = await escrow.totalAffiliateWithdrawable(tokenAddr);
    const bal: bigint = await token.balanceOf(escrowAddr);
    expect(bal).to.be.gte(locked + tw + aw);
    expect(await escrow.accountedBalance(tokenAddr)).to.equal(locked + tw + aw);
    expect(await escrow.excessBalance(tokenAddr)).to.equal(bal - (locked + tw + aw));
  }

  // ═════════════════════════════════════════════════════════════════════
  // V3-specific tests — affiliate-self-withdraw lock + pause coverage
  // ═════════════════════════════════════════════════════════════════════

  describe("V3-specific: affiliate self-withdraw lock", () => {
    it("V3.1 — affiliate calling withdrawAffiliate(token, amount) reverts with AffiliateSelfWithdrawDisabled", async () => {
      const fx = await deployFresh();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_1", "v3_1.gao");
      // The affiliate now has 10_000_000 credit on V3. Self-withdraw
      // MUST revert regardless of balance.
      await expect(
        fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
    });

    it("V3.2 — any random caller (non-affiliate, non-owner) calling withdrawAffiliate reverts with same error", async () => {
      const fx = await deployFresh();
      await expect(
        fx.escrow.connect(fx.attacker).withdrawAffiliate(fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
    });

    it("V3.3 — owner calling withdrawAffiliate (V2 self-service selector) ALSO reverts — no admin override", async () => {
      const fx = await deployFresh();
      // Even the owner cannot use the self-service selector. The
      // only owner-driven payout path is `withdrawAffiliateFor`.
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliate(fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
    });

    it("V3.4 — withdrawAffiliate reverts even with zero amount (no shortcut path)", async () => {
      const fx = await deployFresh();
      await expect(
        fx.escrow.connect(fx.attacker).withdrawAffiliate(fx.tokenAddr, 0n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
    });

    it("V3.5 — withdrawAffiliate reverts even for an address with zero credit (revert precedes any state inspection)", async () => {
      const fx = await deployFresh();
      const balBefore = await fx.escrow.affiliateWithdrawable(
        await fx.attacker.getAddress(),
        fx.tokenAddr,
      );
      expect(balBefore).to.equal(0n);
      await expect(
        fx.escrow.connect(fx.attacker).withdrawAffiliate(fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
    });
  });

  describe("V3-specific: owner-driven withdrawAffiliateFor + pause coverage", () => {
    it("V3.6 — owner withdrawAffiliateFor succeeds when not paused; pays the affiliate, decrements buckets", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_6", "v3_6.gao");
      const affBalBefore = await fx.token.balanceOf(aff);
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      )
        .to.emit(fx.escrow, "AffiliateWithdrawn")
        .withArgs(aff, fx.tokenAddr, 10_000_000n, await fx.owner.getAddress());
      const affBalAfter = await fx.token.balanceOf(aff);
      expect(affBalAfter - affBalBefore).to.equal(10_000_000n);
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(0n);
      expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(0n);
      expect(await fx.escrow.totalAffiliateWithdrawn(fx.tokenAddr)).to.equal(10_000_000n);
      await expectInvariant(fx);
    });

    it("V3.7 — non-owner withdrawAffiliateFor reverts with OwnableUnauthorizedAccount", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_7", "v3_7.gao");
      await expect(
        fx.escrow.connect(fx.attacker).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "OwnableUnauthorizedAccount");
    });

    it("V3.8 — affiliate calling withdrawAffiliateFor on their own address reverts (still not owner)", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_8", "v3_8.gao");
      await expect(
        fx.escrow.connect(fx.affiliate).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "OwnableUnauthorizedAccount");
    });

    it("V3.9 — withdrawAffiliateFor reverts when paused (V3 hardening, V2 did NOT have this)", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_9", "v3_9.gao");
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "EnforcedPause");
    });

    it("V3.10 — withdrawAffiliateFor resumes after unpause", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_10", "v3_10.gao");
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "EnforcedPause");
      await (await fx.escrow.connect(fx.owner).unpause()).wait();
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n),
      ).to.emit(fx.escrow, "AffiliateWithdrawn");
    });

    it("V3.11 — withdrawAffiliateFor cannot redirect payout to arbitrary wallet — funds always go to the affiliate parameter", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      const redirect = await fx.redirectTarget.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_11", "v3_11.gao");
      const redirectBefore = await fx.token.balanceOf(redirect);
      const affBefore = await fx.token.balanceOf(aff);
      await (await fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n)).wait();
      const redirectAfter = await fx.token.balanceOf(redirect);
      const affAfter = await fx.token.balanceOf(aff);
      // Redirect target receives nothing.
      expect(redirectAfter).to.equal(redirectBefore);
      // Affiliate receives the full amount.
      expect(affAfter - affBefore).to.equal(10_000_000n);
    });

    it("V3.12 — withdrawAffiliateFor cannot drain another affiliate's balance (affiliate parameter scopes the bucket)", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      const other = await fx.otherAffiliate.getAddress();
      // Credit `aff` only.
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_12", "v3_12.gao");
      // Owner tries to pay `other` — but `other` has no balance.
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(other, fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "InsufficientAffiliateBalance");
      // aff's balance is untouched.
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(10_000_000n);
    });

    it("V3.13 — withdrawAffiliateFor reverts with ZeroAddress when affiliate=0", async () => {
      const fx = await deployFresh();
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(ZERO_ADDR, fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "ZeroAddress");
    });

    it("V3.14 — withdrawAffiliateFor reverts with InvalidAmount when amount=0", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_14", "v3_14.gao");
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 0n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvalidAmount");
    });

    it("V3.15 — withdrawAffiliateFor reverts when amount > affiliate balance (InsufficientAffiliateBalance)", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_15", "v3_15.gao");
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_001n),
      ).to.be.revertedWithCustomError(fx.escrow, "InsufficientAffiliateBalance");
    });

    it("V3.16 — withdrawAffiliateFor with token=0 reverts ZeroAddress (before reading buckets)", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await expect(
        fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, ZERO_ADDR, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "ZeroAddress");
    });
  });

  describe("V3-specific: settle credits ledger without pushing funds", () => {
    it("V3.17 — settle with affiliate increases affiliateWithdrawable but does NOT transfer tokens to affiliate", async () => {
      const fx = await deployFresh();
      const amount = 100_000_000n;
      const affAmount = 10_000_000n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "v3_17", "v3_17.gao");
      const aff = await fx.affiliate.getAddress();
      const affBalBefore = await fx.token.balanceOf(aff);
      const escrowBalBefore = await fx.token.balanceOf(fx.escrowAddr);

      const tx = await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount);
      const receipt = await tx.wait();

      // Affiliate token balance NEVER moved.
      expect(await fx.token.balanceOf(aff)).to.equal(affBalBefore);
      // Escrow holds the same balance as before settle (settle is
      // bookkeeping-only).
      expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(escrowBalBefore);
      // Accounting bucket increased by exactly affAmount.
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(affAmount);
      expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(affAmount);

      // Confirm no ERC-20 Transfer event was emitted in the settle
      // transaction (Settled event is fine; that's a domain event).
      // The MockERC20's `Transfer(address,address,uint256)` topic0:
      const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
      const tokenAddrLc = fx.tokenAddr.toLowerCase();
      const transferLogsFromToken = (receipt?.logs ?? []).filter(
        (l) =>
          (l.address ?? "").toLowerCase() === tokenAddrLc &&
          l.topics?.[0] === TRANSFER_TOPIC,
      );
      expect(transferLogsFromToken.length).to.equal(0);
      await expectInvariant(fx);
    });

    it("V3.18 — settle (address(0), 0) — pure treasury path — also pushes no tokens to affiliate", async () => {
      const fx = await deployFresh();
      const amount = 100_000_000n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "v3_18", "v3_18.gao");
      const aff = await fx.affiliate.getAddress();
      const affBalBefore = await fx.token.balanceOf(aff);

      await (await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).wait();

      expect(await fx.token.balanceOf(aff)).to.equal(affBalBefore);
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(0n);
      expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(amount);
    });

    it("V3.19 — there is no public auto-withdraw entry on V3 — only owner-driven withdrawAffiliateFor moves accrued credit", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "v3_19", "v3_19.gao");
      const affBalBefore = await fx.token.balanceOf(aff);
      // Affiliate self-call → revert (V3.1).
      await expect(
        fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
      // Attacker call → revert.
      await expect(
        fx.escrow.connect(fx.attacker).withdrawAffiliate(fx.tokenAddr, 10_000_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateSelfWithdrawDisabled");
      // After both refusals, affiliate still has not received anything.
      expect(await fx.token.balanceOf(aff)).to.equal(affBalBefore);
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(10_000_000n);
    });
  });

  describe("V3-specific: treasury withdraw remains non-paused (per spec)", () => {
    it("V3.20 — owner withdrawTreasury succeeds when paused (treasury can still be drained during incident)", async () => {
      const fx = await deployFresh();
      const amount = 100_000_000n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "v3_20", "v3_20.gao");
      // Settle 100% to treasury.
      await (await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).wait();
      // Pause.
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      // Treasury withdraw STILL succeeds.
      const tBalBefore = await fx.token.balanceOf(fx.treasuryAddr);
      await expect(
        fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount),
      )
        .to.emit(fx.escrow, "TreasuryWithdrawn")
        .withArgs(fx.tokenAddr, fx.treasuryAddr, amount);
      const tBalAfter = await fx.token.balanceOf(fx.treasuryAddr);
      expect(tBalAfter - tBalBefore).to.equal(amount);
    });

    it("V3.21 — non-owner cannot withdrawTreasury (paused or not)", async () => {
      const fx = await deployFresh();
      await expect(
        fx.escrow.connect(fx.attacker).withdrawTreasury(fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "OwnableUnauthorizedAccount");
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // V2 safety regression — ported / adapted to V3
  // ═════════════════════════════════════════════════════════════════════

  describe("V2 safety carried forward — constructor + admin", () => {
    it("R1 — constructor rejects zero treasury and zero owner", async () => {
      const [a] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("GaoDomainDepositV3");
      await expect(
        Escrow.deploy(await a.getAddress(), ZERO_ADDR),
      ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
      await expect(
        Escrow.deploy(ZERO_ADDR, await a.getAddress()),
      ).to.be.revertedWithCustomError(Escrow, "OwnableInvalidOwner");
    });

    it("R2 — setTreasury works + rejects zero", async () => {
      const fx = await deployFresh();
      const newT = await fx.attacker.getAddress();
      await expect(fx.escrow.connect(fx.owner).setTreasury(newT))
        .to.emit(fx.escrow, "TreasuryUpdated")
        .withArgs(fx.treasuryAddr, newT);
      expect(await fx.escrow.treasury()).to.equal(newT);
      await expect(
        fx.escrow.connect(fx.owner).setTreasury(ZERO_ADDR),
      ).to.be.revertedWithCustomError(fx.escrow, "ZeroAddress");
    });

    it("R3 — setAllowedToken toggles allowlist + emits + rejects zero", async () => {
      const fx = await deployFresh();
      expect(await fx.escrow.allowedTokens(fx.otherTokenAddr)).to.equal(false);
      await expect(fx.escrow.connect(fx.owner).setAllowedToken(fx.otherTokenAddr, true))
        .to.emit(fx.escrow, "AllowedTokenUpdated")
        .withArgs(fx.otherTokenAddr, true);
      expect(await fx.escrow.allowedTokens(fx.otherTokenAddr)).to.equal(true);
      await expect(
        fx.escrow.connect(fx.owner).setAllowedToken(ZERO_ADDR, true),
      ).to.be.revertedWithCustomError(fx.escrow, "ZeroAddress");
    });
  });

  describe("V2 safety carried forward — deposit", () => {
    it("R4 — deposit increments lockedLiability + writes struct", async () => {
      const fx = await deployFresh();
      const amount = 199_000_000n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "r4", "r4.gao");
      expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(amount);
      expect(await fx.escrow.totalDeposited(fx.tokenAddr)).to.equal(amount);
      expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(amount);
      expect(await fx.escrow.isPending(invoiceId)).to.equal(true);
      const t = await fx.escrow.getDeposit(invoiceId);
      expect(t[GD.status]).to.equal(D_DEPOSITED);
      expect(t[GD.grossAmount]).to.equal(amount);
      await expectInvariant(fx);
    });

    it("R5 — duplicate invoiceId reverts InvoiceAlreadyExists", async () => {
      const fx = await deployFresh();
      await fundAndDeposit(fx, 199_000_000n, "r5", "r5.gao");
      const { invoiceId, domainHash } = ids("r5", "r5.gao");
      await (await fx.token.connect(fx.payer).approve(fx.escrowAddr, 1n)).wait();
      await expect(
        fx.escrow
          .connect(fx.payer)
          .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvoiceAlreadyExists");
    });

    it("R6 — disallowed token reverts TokenNotAllowed", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash } = ids("r6", "r6.gao");
      await (await fx.otherToken.mint(await fx.payer.getAddress(), 1_000n)).wait();
      await (await fx.otherToken.connect(fx.payer).approve(fx.escrowAddr, 1_000n)).wait();
      await expect(
        fx.escrow
          .connect(fx.payer)
          .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.otherTokenAddr, 1_000n),
      ).to.be.revertedWithCustomError(fx.escrow, "TokenNotAllowed");
    });

    it("R7 — zero amount reverts InvalidAmount", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash } = ids("r7", "r7.gao");
      await expect(
        fx.escrow
          .connect(fx.payer)
          .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.tokenAddr, 0n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvalidAmount");
    });

    it("R8 — pause blocks deposit", async () => {
      const fx = await deployFresh();
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      const { invoiceId, domainHash } = ids("r8", "r8.gao");
      await (await fx.token.connect(fx.payer).approve(fx.escrowAddr, 1n)).wait();
      await expect(
        fx.escrow
          .connect(fx.payer)
          .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "EnforcedPause");
    });
  });

  describe("V2 safety carried forward — settle", () => {
    it("R9 — settle with no affiliate routes 100% to treasury bucket", async () => {
      const fx = await deployFresh();
      const amount = 199_000_000n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "r9", "r9.gao");
      await expect(fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n))
        .to.emit(fx.escrow, "Settled")
        .withArgs(invoiceId, fx.tokenAddr, amount, ZERO_ADDR, 0n);
      expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(0n);
      expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(amount);
      await expectInvariant(fx);
    });

    it("R10 — settle with affiliate splits gross", async () => {
      const fx = await deployFresh();
      const amount = 199_000_000n;
      const affAmount = 19_900_000n;
      const aff = await fx.affiliate.getAddress();
      const { invoiceId } = await fundAndDeposit(fx, amount, "r10", "r10.gao");
      await expect(fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount))
        .to.emit(fx.escrow, "Settled")
        .withArgs(invoiceId, fx.tokenAddr, amount - affAmount, aff, affAmount);
      expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(amount - affAmount);
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(affAmount);
      await expectInvariant(fx);
    });

    it("R11 — settle affiliateAmount > gross reverts AffiliateAmountExceedsGross", async () => {
      const fx = await deployFresh();
      const amount = 100n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "r11", "r11.gao");
      await expect(
        fx.escrow.connect(fx.owner).settle(invoiceId, await fx.affiliate.getAddress(), 101n),
      ).to.be.revertedWithCustomError(fx.escrow, "AffiliateAmountExceedsGross");
    });

    it("R12 — settle (affiliate=0, amount>0) and (affiliate≠0, amount=0) both revert InvalidAffiliateSplit", async () => {
      const fx = await deployFresh();
      const amount = 100n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "r12a", "r12a.gao");
      await expect(
        fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvalidAffiliateSplit");
      const { invoiceId: id2 } = await fundAndDeposit(fx, amount, "r12b", "r12b.gao");
      await expect(
        fx.escrow.connect(fx.owner).settle(id2, await fx.affiliate.getAddress(), 0n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvalidAffiliateSplit");
    });

    it("R13 — settle twice reverts InvoiceNotDeposited", async () => {
      const fx = await deployFresh();
      const { invoiceId } = await fundAndDeposit(fx, 100n, "r13", "r13.gao");
      await (await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).wait();
      await expect(
        fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n),
      ).to.be.revertedWithCustomError(fx.escrow, "InvoiceNotDeposited");
    });

    it("R14 — settle works while paused (deposits paused; in-flight close-out remains)", async () => {
      const fx = await deployFresh();
      const { invoiceId } = await fundAndDeposit(fx, 100n, "r14", "r14.gao");
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      await expect(fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).to.emit(
        fx.escrow,
        "Settled",
      );
    });
  });

  describe("V2 safety carried forward — refund", () => {
    it("R15 — refund returns full gross to payer; sets REFUNDED", async () => {
      const fx = await deployFresh();
      const amount = 199_000_000n;
      const payerAddr = await fx.payer.getAddress();
      const balBeforeDeposit = await fx.token.balanceOf(payerAddr);
      const { invoiceId } = await fundAndDeposit(fx, amount, "r15", "r15.gao");
      await expect(fx.escrow.connect(fx.owner).refund(invoiceId))
        .to.emit(fx.escrow, "Refunded")
        .withArgs(invoiceId, payerAddr, fx.tokenAddr, amount);
      expect(await fx.token.balanceOf(payerAddr)).to.equal(balBeforeDeposit);
      const t = await fx.escrow.getDeposit(invoiceId);
      expect(t[GD.status]).to.equal(D_REFUNDED);
      await expectInvariant(fx);
    });

    it("R16 — refund after settle reverts InvoiceNotDeposited", async () => {
      const fx = await deployFresh();
      const { invoiceId } = await fundAndDeposit(fx, 100n, "r16", "r16.gao");
      await (await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).wait();
      await expect(
        fx.escrow.connect(fx.owner).refund(invoiceId),
      ).to.be.revertedWithCustomError(fx.escrow, "InvoiceNotDeposited");
    });

    it("R17 — refund works while paused", async () => {
      const fx = await deployFresh();
      const { invoiceId } = await fundAndDeposit(fx, 100n, "r17", "r17.gao");
      await (await fx.escrow.connect(fx.owner).pause()).wait();
      await expect(fx.escrow.connect(fx.owner).refund(invoiceId)).to.emit(fx.escrow, "Refunded");
    });
  });

  describe("V2 safety carried forward — treasury withdraw + rescue", () => {
    it("R18 — withdrawTreasury transfers to treasury", async () => {
      const fx = await deployFresh();
      const amount = 100n;
      const { invoiceId } = await fundAndDeposit(fx, amount, "r18", "r18.gao");
      await (await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n)).wait();
      const tBalBefore = await fx.token.balanceOf(fx.treasuryAddr);
      await expect(fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount))
        .to.emit(fx.escrow, "TreasuryWithdrawn")
        .withArgs(fx.tokenAddr, fx.treasuryAddr, amount);
      expect(await fx.token.balanceOf(fx.treasuryAddr)).to.equal(tBalBefore + amount);
      expect(await fx.escrow.totalTreasuryWithdrawn(fx.tokenAddr)).to.equal(amount);
      await expectInvariant(fx);
    });

    it("R19 — withdrawTreasury > bucket reverts InsufficientWithdrawable", async () => {
      const fx = await deployFresh();
      await expect(
        fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "InsufficientWithdrawable");
    });

    it("R20 — rescueExcessToken transfers exactly the excess", async () => {
      const fx = await deployFresh();
      // Stray transfer.
      const stray = 12_345n;
      await (await fx.token.mint(fx.escrowAddr, stray)).wait();
      expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(stray);
      const rescueTo = await fx.redirectTarget.getAddress();
      await expect(fx.escrow.connect(fx.owner).rescueExcessToken(fx.tokenAddr, rescueTo, stray))
        .to.emit(fx.escrow, "ExcessTokenRescued")
        .withArgs(fx.tokenAddr, rescueTo, stray);
      expect(await fx.token.balanceOf(rescueTo)).to.equal(stray);
      expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);
    });

    it("R21 — rescueExcessToken cannot drain user / treasury / affiliate buckets", async () => {
      const fx = await deployFresh();
      // Build a state with non-zero buckets.
      const aff = await fx.affiliate.getAddress();
      await fundDepositAndSettleToAffiliate(fx, 100_000_000n, 10_000_000n, "r21", "r21.gao");
      // No excess yet.
      await expect(
        fx.escrow.connect(fx.owner).rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 1n),
      ).to.be.revertedWithCustomError(fx.escrow, "InsufficientExcessBalance");
      // All buckets still intact.
      expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(90_000_000n);
      expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(10_000_000n);
    });
  });

  describe("V2 safety carried forward — invariants + non-owner access", () => {
    it("R22 — invariant holds across deposit / settle / withdrawAffiliateFor / withdrawTreasury / refund / rescue", async () => {
      const fx = await deployFresh();
      const aff = await fx.affiliate.getAddress();
      // deposit
      const { invoiceId } = await fundAndDeposit(fx, 100_000_000n, "r22a", "r22a.gao");
      await expectInvariant(fx);
      // settle
      await (await fx.escrow.connect(fx.owner).settle(invoiceId, aff, 10_000_000n)).wait();
      await expectInvariant(fx);
      // withdrawAffiliateFor (V3-only path)
      await (await fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, 10_000_000n)).wait();
      await expectInvariant(fx);
      // withdrawTreasury
      await (await fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, 90_000_000n)).wait();
      await expectInvariant(fx);
      // refund a new deposit
      const { invoiceId: id2 } = await fundAndDeposit(fx, 5_000_000n, "r22b", "r22b.gao");
      await (await fx.escrow.connect(fx.owner).refund(id2)).wait();
      await expectInvariant(fx);
      // stray + rescue
      await (await fx.token.mint(fx.escrowAddr, 1234n)).wait();
      await (await fx.escrow.connect(fx.owner).rescueExcessToken(
        fx.tokenAddr,
        await fx.redirectTarget.getAddress(),
        1234n,
      )).wait();
      await expectInvariant(fx);
    });

    it("R23 — non-owner cannot call any onlyOwner function (settle/refund/withdrawTreasury/rescue/withdrawAffiliateFor/setAllowedToken/setTreasury/pause/unpause)", async () => {
      const fx = await deployFresh();
      const E = fx.escrow.connect(fx.attacker);
      const dummyId = ethers.keccak256(ethers.toUtf8Bytes("dummy"));
      const attackerAddr = await fx.attacker.getAddress();
      const affiliateAddr = await fx.affiliate.getAddress();
      const cases: Array<() => Promise<unknown>> = [
        () => E.settle(dummyId, ZERO_ADDR, 0n),
        () => E.refund(dummyId),
        () => E.withdrawTreasury(fx.tokenAddr, 1n),
        () => E.rescueExcessToken(fx.tokenAddr, attackerAddr, 1n),
        () => E.withdrawAffiliateFor(affiliateAddr, fx.tokenAddr, 1n),
        () => E.setAllowedToken(fx.tokenAddr, false),
        () => E.setTreasury(attackerAddr),
        () => E.pause(),
        () => E.unpause(),
      ];
      for (const c of cases) {
        await expect(c()).to.be.revertedWithCustomError(fx.escrow, "OwnableUnauthorizedAccount");
      }
    });
  });

  describe("V3 ABI compatibility for migration tooling", () => {
    it("R24 — V3 deposit / settle / refund / withdrawTreasury / withdrawAffiliateFor selectors match V2 byte-for-byte", async () => {
      // The BE adapter that pins selectors to invoke the live escrow
      // must continue to decode against V3 with the same 4-byte
      // selectors as V2 — verified here by computing both and
      // comparing.
      const v2 = await ethers.getContractFactory("GaoDomainDepositV2");
      const v3 = await ethers.getContractFactory("GaoDomainDepositV3");
      const sigs = [
        "deposit(address,bytes32,bytes32,address,uint256)",
        "settle(bytes32,address,uint256)",
        "refund(bytes32)",
        "withdrawTreasury(address,uint256)",
        "withdrawAffiliateFor(address,address,uint256)",
        "withdrawAffiliate(address,uint256)",
        "rescueExcessToken(address,address,uint256)",
        "setAllowedToken(address,bool)",
        "setTreasury(address)",
        "pause()",
        "unpause()",
        "getDeposit(bytes32)",
        "isPending(bytes32)",
        "accountedBalance(address)",
        "excessBalance(address)",
      ];
      for (const sig of sigs) {
        const v2sel = v2.interface.getFunction(sig)?.selector;
        const v3sel = v3.interface.getFunction(sig)?.selector;
        expect(v3sel, `selector for ${sig} present on V3`).to.be.a("string");
        expect(v3sel).to.equal(v2sel, `selector mismatch for ${sig}`);
      }
    });

    it("R25 — V3 storage getter shape matches V2 (allowedTokens / lockedLiability / treasuryWithdrawable / affiliateWithdrawable / totalAffiliateWithdrawable / treasury / counters)", async () => {
      const fx = await deployFresh();
      // Each call returns the V2-shaped scalar without reverting.
      expect(typeof (await fx.escrow.allowedTokens(fx.tokenAddr))).to.equal("boolean");
      expect(typeof (await fx.escrow.lockedLiability(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.treasuryWithdrawable(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.affiliateWithdrawable(
        await fx.affiliate.getAddress(),
        fx.tokenAddr,
      ))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr))).to.equal("bigint");
      expect(await fx.escrow.treasury()).to.equal(fx.treasuryAddr);
      expect(typeof (await fx.escrow.totalDeposited(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalSettled(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalRefunded(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalTreasuryWithdrawn(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalAffiliateWithdrawn(fx.tokenAddr))).to.equal("bigint");
      expect(typeof (await fx.escrow.totalExcessRescued(fx.tokenAddr))).to.equal("bigint");
    });

    it("R26 — V3 getDeposit returns the same 11-tuple as V2 (verified by tuple length + types)", async () => {
      const fx = await deployFresh();
      const { invoiceId } = await fundAndDeposit(fx, 100n, "r26", "r26.gao");
      const t = await fx.escrow.getDeposit(invoiceId);
      expect(t.length).to.equal(11);
      expect(t[GD.status]).to.equal(D_DEPOSITED);
      expect(t[GD.grossAmount]).to.equal(100n);
      // settledAt / refundedAt are zero for a fresh deposit
      expect(t[GD.settledAt]).to.equal(0n);
      expect(t[GD.refundedAt]).to.equal(0n);
    });
  });
});
