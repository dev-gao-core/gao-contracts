// GaoDomainDepositV2 unit tests.
//
// Pins the affiliate-aware accounting model. Every state transition
// must preserve the invariant
//
//   erc20.balanceOf(this) >= lockedLiability[t]
//                          + treasuryWithdrawable[t]
//                          + totalAffiliateWithdrawable[t]
//
// and no bucket may bleed into another. The tests below cover the
// 28-case matrix from the worker spec plus the invariant itself.

import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const D_NONE = 0n;
const D_DEPOSITED = 1n;
const D_SETTLED = 2n;
const D_REFUNDED = 3n;

// Index positions inside the getDeposit() return tuple. Must mirror the
// Solidity struct order. If the struct changes, update both.
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

describe("GaoDomainDepositV2", () => {
  async function deployFresh() {
    const [owner, payer, buyer, affiliate, otherAffiliate, treasury, attacker] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Other = await ethers.getContractFactory("MockERC20");
    const otherToken = await Other.deploy();
    await otherToken.waitForDeployment();

    const Escrow = await ethers.getContractFactory("GaoDomainDepositV2");
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
      token,
      otherToken,
      escrow,
      tokenAddr: await token.getAddress(),
      otherTokenAddr: await otherToken.getAddress(),
      escrowAddr: await escrow.getAddress(),
      treasuryAddr: await treasury.getAddress(),
    };
  }

  function ids(seed = "pi_v2_001", domain = "kingv2.gao") {
    return {
      invoiceId: ethers.keccak256(ethers.toUtf8Bytes(seed)),
      domainHash: ethers.keccak256(ethers.toUtf8Bytes(domain)),
    };
  }

  async function fundAndDeposit(
    fx: Awaited<ReturnType<typeof deployFresh>>,
    amount: bigint,
    seed = "pi_v2_001",
    domain = "kingv2.gao",
  ) {
    const { payer, buyer, escrow, tokenAddr, escrowAddr } = fx;
    const { invoiceId, domainHash } = ids(seed, domain);
    await (await fx.token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);
    return { invoiceId, domainHash };
  }

  async function expectInvariant(fx: Awaited<ReturnType<typeof deployFresh>>) {
    const { escrow, tokenAddr, escrowAddr, token } = fx;
    const locked: bigint = await escrow.lockedLiability(tokenAddr);
    const tw: bigint = await escrow.treasuryWithdrawable(tokenAddr);
    const aw: bigint = await escrow.totalAffiliateWithdrawable(tokenAddr);
    const bal: bigint = await token.balanceOf(escrowAddr);
    expect(bal).to.be.gte(locked + tw + aw);
    // Cross-check against on-chain helpers.
    expect(await escrow.accountedBalance(tokenAddr)).to.equal(locked + tw + aw);
    expect(await escrow.excessBalance(tokenAddr)).to.equal(bal - (locked + tw + aw));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. constructor validates treasury / owner
  // ─────────────────────────────────────────────────────────────────────────
  it("1. constructor rejects zero treasury and zero owner", async () => {
    const [a] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("GaoDomainDepositV2");

    // zero treasury → ZeroAddress
    await expect(
      Escrow.deploy(await a.getAddress(), ZERO_ADDR),
    ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");

    // zero owner → OZ Ownable's own custom error
    await expect(
      Escrow.deploy(ZERO_ADDR, await a.getAddress()),
    ).to.be.revertedWithCustomError(Escrow, "OwnableInvalidOwner");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. setTreasury works and rejects zero
  // ─────────────────────────────────────────────────────────────────────────
  it("2. setTreasury updates treasury and rejects zero", async () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // 3. setAllowedToken works
  // ─────────────────────────────────────────────────────────────────────────
  it("3. setAllowedToken toggles the allowlist and emits", async () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // 4. deposit works: state, struct, counters, balance
  // ─────────────────────────────────────────────────────────────────────────
  it("4. deposit increments lockedLiability + totalDeposited and writes the struct", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId, domainHash } = await fundAndDeposit(fx, amount, "pi_4", "four.gao");

    expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(amount);
    expect(await fx.escrow.totalDeposited(fx.tokenAddr)).to.equal(amount);
    expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(amount);
    expect(await fx.escrow.isPending(invoiceId)).to.equal(true);

    const t = await fx.escrow.getDeposit(invoiceId);
    expect(t[GD.payer]).to.equal(await fx.payer.getAddress());
    expect(t[GD.buyer]).to.equal(await fx.buyer.getAddress());
    expect(t[GD.paymentToken]).to.equal(fx.tokenAddr);
    expect(t[GD.grossAmount]).to.equal(amount);
    expect(t[GD.treasuryAmount]).to.equal(0n);
    expect(t[GD.affiliate]).to.equal(ZERO_ADDR);
    expect(t[GD.affiliateAmount]).to.equal(0n);
    expect(t[GD.status]).to.equal(D_DEPOSITED);
    expect(t[GD.createdAt]).to.be.gt(0n);
    expect(t[GD.settledAt]).to.equal(0n);
    expect(t[GD.refundedAt]).to.equal(0n);
    void domainHash;
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. deposit duplicate invoiceId reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("5. duplicate invoiceId reverts with InvoiceAlreadyExists", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    await fundAndDeposit(fx, amount, "pi_dup", "dup.gao");
    const { invoiceId, domainHash } = ids("pi_dup", "dup.gao");
    await (await fx.token.connect(fx.payer).approve(fx.escrowAddr, amount)).wait();
    await expect(
      fx.escrow
        .connect(fx.payer)
        .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.tokenAddr, amount),
    ).to.be.revertedWithCustomError(fx.escrow, "InvoiceAlreadyExists");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. deposit disallowed token reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("6. deposit of a disallowed token reverts with TokenNotAllowed", async () => {
    const fx = await deployFresh();
    const { invoiceId, domainHash } = ids("pi_dis", "dis.gao");
    await (await fx.otherToken.mint(await fx.payer.getAddress(), 1_000_000n)).wait();
    await (await fx.otherToken.connect(fx.payer).approve(fx.escrowAddr, 1_000_000n)).wait();
    await expect(
      fx.escrow
        .connect(fx.payer)
        .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.otherTokenAddr, 1_000_000n),
    ).to.be.revertedWithCustomError(fx.escrow, "TokenNotAllowed");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. deposit zero amount reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("7. deposit zero amount reverts with InvalidAmount", async () => {
    const fx = await deployFresh();
    const { invoiceId, domainHash } = ids("pi_zero", "zero.gao");
    await expect(
      fx.escrow
        .connect(fx.payer)
        .deposit(await fx.buyer.getAddress(), invoiceId, domainHash, fx.tokenAddr, 0n),
    ).to.be.revertedWithCustomError(fx.escrow, "InvalidAmount");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. settle no affiliate ⇒ 100% to treasury bucket
  // ─────────────────────────────────────────────────────────────────────────
  it("8. settle with no affiliate routes 100% to treasury bucket", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_8", "eight.gao");

    await expect(fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n))
      .to.emit(fx.escrow, "Settled")
      .withArgs(invoiceId, fx.tokenAddr, amount, ZERO_ADDR, 0n);

    expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(amount);
    expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalSettled(fx.tokenAddr)).to.equal(amount);

    const t = await fx.escrow.getDeposit(invoiceId);
    expect(t[GD.status]).to.equal(D_SETTLED);
    expect(t[GD.treasuryAmount]).to.equal(amount);
    expect(t[GD.affiliate]).to.equal(ZERO_ADDR);
    expect(t[GD.affiliateAmount]).to.equal(0n);
    expect(t[GD.settledAt]).to.be.gt(0n);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. settle with affiliate splits correctly
  // ─────────────────────────────────────────────────────────────────────────
  it("9. settle with affiliate splits gross between treasury and affiliate", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const affAmount = 19_900_000n; // 10%
    const trAmount = amount - affAmount;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_9", "nine.gao");

    await expect(fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount))
      .to.emit(fx.escrow, "Settled")
      .withArgs(invoiceId, fx.tokenAddr, trAmount, aff, affAmount);

    expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(trAmount);
    expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(affAmount);
    expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(affAmount);
    expect(await fx.escrow.totalSettled(fx.tokenAddr)).to.equal(amount);

    const t = await fx.escrow.getDeposit(invoiceId);
    expect(t[GD.affiliate]).to.equal(aff);
    expect(t[GD.affiliateAmount]).to.equal(affAmount);
    expect(t[GD.treasuryAmount]).to.equal(trAmount);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. settle with affiliateAmount > gross reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("10. settle rejects affiliateAmount > gross", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_over", "over.gao");
    await expect(
      fx.escrow.connect(fx.owner).settle(invoiceId, aff, amount + 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "AffiliateAmountExceedsGross");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. settle twice reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("11. settle twice reverts with InvoiceNotDeposited", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_11", "eleven.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n);
    await expect(
      fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n),
    ).to.be.revertedWithCustomError(fx.escrow, "InvoiceNotDeposited");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. refund before settlement returns full gross to payer
  // ─────────────────────────────────────────────────────────────────────────
  it("12. refund returns the full gross amount to the original payer", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_12", "twelve.gao");

    const before = await fx.token.balanceOf(await fx.payer.getAddress());
    await expect(fx.escrow.connect(fx.owner).refund(invoiceId))
      .to.emit(fx.escrow, "Refunded")
      .withArgs(invoiceId, await fx.payer.getAddress(), fx.tokenAddr, amount);
    const after = await fx.token.balanceOf(await fx.payer.getAddress());
    expect(after - before).to.equal(amount);
    expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalRefunded(fx.tokenAddr)).to.equal(amount);

    const t = await fx.escrow.getDeposit(invoiceId);
    expect(t[GD.status]).to.equal(D_REFUNDED);
    expect(t[GD.refundedAt]).to.be.gt(0n);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. refund after settlement reverts
  // ─────────────────────────────────────────────────────────────────────────
  it("13. refund after settle reverts with InvoiceNotDeposited", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_13", "thirteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n);
    await expect(
      fx.escrow.connect(fx.owner).refund(invoiceId),
    ).to.be.revertedWithCustomError(fx.escrow, "InvoiceNotDeposited");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. withdrawTreasury works
  // ─────────────────────────────────────────────────────────────────────────
  it("14. withdrawTreasury transfers to treasury and updates counters", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_14", "fourteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n);

    const before = await fx.token.balanceOf(fx.treasuryAddr);
    await expect(fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount))
      .to.emit(fx.escrow, "TreasuryWithdrawn")
      .withArgs(fx.tokenAddr, fx.treasuryAddr, amount);
    const after = await fx.token.balanceOf(fx.treasuryAddr);
    expect(after - before).to.equal(amount);
    expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalTreasuryWithdrawn(fx.tokenAddr)).to.equal(amount);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. withdrawTreasury cannot exceed treasuryWithdrawable
  // ─────────────────────────────────────────────────────────────────────────
  it("15. withdrawTreasury reverts when amount > treasuryWithdrawable", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_15", "fifteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n);
    await expect(
      fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount + 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientWithdrawable");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 16. affiliate self-withdraw works
  // ─────────────────────────────────────────────────────────────────────────
  it("16. affiliate self-withdraw transfers tokens and decrements buckets", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const affAmount = 19_900_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_16", "sixteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount);

    const before = await fx.token.balanceOf(aff);
    await expect(fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, affAmount))
      .to.emit(fx.escrow, "AffiliateWithdrawn")
      .withArgs(aff, fx.tokenAddr, affAmount, aff);
    const after = await fx.token.balanceOf(aff);
    expect(after - before).to.equal(affAmount);
    expect(await fx.escrow.affiliateWithdrawable(aff, fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalAffiliateWithdrawn(fx.tokenAddr)).to.equal(affAmount);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 17. affiliate cannot withdraw another affiliate's funds
  // ─────────────────────────────────────────────────────────────────────────
  it("17. affiliate cannot drain another affiliate's balance", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_17", "seventeen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, aff, 50_000_000n);

    await expect(
      fx.escrow.connect(fx.otherAffiliate).withdrawAffiliate(fx.tokenAddr, 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientAffiliateBalance");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 18. owner withdrawAffiliateFor works
  // ─────────────────────────────────────────────────────────────────────────
  it("18. owner withdrawAffiliateFor pays the affiliate, not the caller", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const affAmount = 19_900_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_18", "eighteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount);

    const beforeAff = await fx.token.balanceOf(aff);
    const beforeOwner = await fx.token.balanceOf(await fx.owner.getAddress());
    await expect(
      fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, affAmount),
    )
      .to.emit(fx.escrow, "AffiliateWithdrawn")
      .withArgs(aff, fx.tokenAddr, affAmount, await fx.owner.getAddress());
    const afterAff = await fx.token.balanceOf(aff);
    const afterOwner = await fx.token.balanceOf(await fx.owner.getAddress());

    expect(afterAff - beforeAff).to.equal(affAmount);
    // Owner did not receive anything; funds went to the affiliate.
    expect(afterOwner).to.equal(beforeOwner);
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 19. affiliate withdraw cannot exceed balance (over-withdraw)
  // ─────────────────────────────────────────────────────────────────────────
  it("19. affiliate withdraw cannot exceed balance", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const affAmount = 50_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_19", "nineteen.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount);

    await expect(
      fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, affAmount + 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientAffiliateBalance");
    // owner-on-behalf path also rejects.
    await expect(
      fx.escrow.connect(fx.owner).withdrawAffiliateFor(aff, fx.tokenAddr, affAmount + 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientAffiliateBalance");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 20. rescueExcessToken rescues only excess
  // ─────────────────────────────────────────────────────────────────────────
  it("20. rescueExcessToken transfers exactly the excess and never more", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    await fundAndDeposit(fx, amount, "pi_20", "twenty.gao");
    const stray = 7_000_000n;
    await (await fx.token.mint(fx.escrowAddr, stray)).wait();

    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(stray);

    const dest = await fx.attacker.getAddress();
    await expect(
      fx.escrow.connect(fx.owner).rescueExcessToken(fx.tokenAddr, dest, stray),
    )
      .to.emit(fx.escrow, "ExcessTokenRescued")
      .withArgs(fx.tokenAddr, dest, stray);
    expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(amount);
    expect(await fx.escrow.totalExcessRescued(fx.tokenAddr)).to.equal(stray);

    // After rescue, no more excess; further rescue (1 wei) reverts.
    await expect(
      fx.escrow.connect(fx.owner).rescueExcessToken(fx.tokenAddr, dest, 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientExcessBalance");
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 21. rescue cannot touch lockedLiability
  // ─────────────────────────────────────────────────────────────────────────
  it("21. rescueExcessToken cannot drain lockedLiability", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    await fundAndDeposit(fx, amount, "pi_21", "twenty-one.gao");
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);
    await expect(
      fx.escrow
        .connect(fx.owner)
        .rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientExcessBalance");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 22. rescue cannot touch treasuryWithdrawable
  // ─────────────────────────────────────────────────────────────────────────
  it("22. rescueExcessToken cannot drain treasuryWithdrawable", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_22", "twenty-two.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, ZERO_ADDR, 0n);
    expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(amount);
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);
    await expect(
      fx.escrow
        .connect(fx.owner)
        .rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientExcessBalance");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 23. rescue cannot touch affiliateWithdrawable
  // ─────────────────────────────────────────────────────────────────────────
  it("23. rescueExcessToken cannot drain affiliateWithdrawable", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const aff = await fx.affiliate.getAddress();
    const affAmount = 50_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_23", "twenty-three.gao");
    await fx.escrow.connect(fx.owner).settle(invoiceId, aff, affAmount);

    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);
    // Sweep the treasury share — affiliate share remains.
    await fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount - affAmount);
    expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(affAmount);
    expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(affAmount);
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);

    await expect(
      fx.escrow
        .connect(fx.owner)
        .rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InsufficientExcessBalance");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 24. invariant holds across a full transition sequence
  // ─────────────────────────────────────────────────────────────────────────
  it("24. invariant holds across deposit / settle / withdraw / rescue / refund sequence", async () => {
    const fx = await deployFresh();
    const aff = await fx.affiliate.getAddress();

    const amt1 = 199_000_000n;
    const amt2 = 179_100_000n;
    await fundAndDeposit(fx, amt1, "pi_24a", "a.gao");
    await expectInvariant(fx);

    await fundAndDeposit(fx, amt2, "pi_24b", "b.gao");
    await expectInvariant(fx);

    const { invoiceId: id1 } = ids("pi_24a", "a.gao");
    await fx.escrow.connect(fx.owner).settle(id1, aff, 19_900_000n);
    await expectInvariant(fx);

    await fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amt1 - 19_900_000n);
    await expectInvariant(fx);

    await fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, 19_900_000n);
    await expectInvariant(fx);

    const { invoiceId: id2 } = ids("pi_24b", "b.gao");
    await fx.escrow.connect(fx.owner).refund(id2);
    await expectInvariant(fx);

    expect(await fx.escrow.lockedLiability(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.treasuryWithdrawable(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.totalAffiliateWithdrawable(fx.tokenAddr)).to.equal(0n);
    expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(0n);

    await fx.token.mint(fx.escrowAddr, 12_345n);
    await expectInvariant(fx);
    await fx.escrow
      .connect(fx.owner)
      .rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 12_345n);
    await expectInvariant(fx);
    expect(await fx.token.balanceOf(fx.escrowAddr)).to.equal(0n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 25. pause blocks deposit; settle / refund / withdraw / rescue remain
  // ─────────────────────────────────────────────────────────────────────────
  it("25. pause blocks deposit; settle / refund / withdraw / rescue remain available", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_25", "twenty-five.gao");
    await fx.escrow.connect(fx.owner).pause();

    const next = ids("pi_25b", "twenty-five-b.gao");
    await (await fx.token.connect(fx.payer).approve(fx.escrowAddr, amount)).wait();
    await expect(
      fx.escrow
        .connect(fx.payer)
        .deposit(await fx.buyer.getAddress(), next.invoiceId, next.domainHash, fx.tokenAddr, amount),
    ).to.be.revertedWithCustomError(fx.escrow, "EnforcedPause");

    // Settle / refund / withdraw / rescue still work.
    await fx.escrow
      .connect(fx.owner)
      .settle(invoiceId, await fx.affiliate.getAddress(), 1_000_000n);
    await fx.escrow.connect(fx.owner).withdrawTreasury(fx.tokenAddr, amount - 1_000_000n);
    await fx.escrow.connect(fx.affiliate).withdrawAffiliate(fx.tokenAddr, 1_000_000n);

    await fx.token.mint(fx.escrowAddr, 5n);
    await fx.escrow
      .connect(fx.owner)
      .rescueExcessToken(fx.tokenAddr, await fx.attacker.getAddress(), 5n);

    await fx.escrow.connect(fx.owner).unpause();
    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 26. non-owner cannot call admin functions
  // ─────────────────────────────────────────────────────────────────────────
  it("26. non-owner cannot settle / refund / withdrawTreasury / rescue / withdrawAffiliateFor / setAllowedToken / setTreasury / pause / unpause", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId } = await fundAndDeposit(fx, amount, "pi_26", "twenty-six.gao");
    const aff = await fx.affiliate.getAddress();

    const bound: (() => Promise<unknown>)[] = [
      () => fx.escrow.connect(fx.attacker).settle(invoiceId, ZERO_ADDR, 0n),
      () => fx.escrow.connect(fx.attacker).refund(invoiceId),
      () => fx.escrow.connect(fx.attacker).withdrawTreasury(fx.tokenAddr, 1n),
      () =>
        fx.escrow
          .connect(fx.attacker)
          .rescueExcessToken(fx.tokenAddr, fx.escrowAddr /* any non-zero */, 1n),
      () =>
        fx.escrow
          .connect(fx.attacker)
          .withdrawAffiliateFor(aff, fx.tokenAddr, 1n),
      () => fx.escrow.connect(fx.attacker).setAllowedToken(fx.tokenAddr, false),
      () => fx.escrow.connect(fx.attacker).setTreasury(aff),
      () => fx.escrow.connect(fx.attacker).pause(),
      () => fx.escrow.connect(fx.attacker).unpause(),
    ];

    for (const fn of bound) {
      await expect(fn()).to.be.revertedWithCustomError(
        fx.escrow,
        "OwnableUnauthorizedAccount",
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 27. timestamp / status fields update correctly across the lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  it("27. timestamp + status fields update correctly across deposit / settle / refund", async () => {
    const fx = await deployFresh();

    // settled lifecycle
    const { invoiceId: id1 } = await fundAndDeposit(
      fx,
      199_000_000n,
      "pi_27a",
      "lifecycle-a.gao",
    );
    let t = await fx.escrow.getDeposit(id1);
    expect(t[GD.status]).to.equal(D_DEPOSITED);
    const created1 = t[GD.createdAt];
    expect(created1).to.be.gt(0n);
    expect(t[GD.settledAt]).to.equal(0n);
    expect(t[GD.refundedAt]).to.equal(0n);

    await fx.escrow.connect(fx.owner).settle(id1, ZERO_ADDR, 0n);
    t = await fx.escrow.getDeposit(id1);
    expect(t[GD.status]).to.equal(D_SETTLED);
    expect(t[GD.createdAt]).to.equal(created1);
    expect(t[GD.settledAt]).to.be.gte(created1);
    expect(t[GD.refundedAt]).to.equal(0n);

    // refunded lifecycle (separate invoice)
    const { invoiceId: id2 } = await fundAndDeposit(
      fx,
      179_100_000n,
      "pi_27b",
      "lifecycle-b.gao",
    );
    await fx.escrow.connect(fx.owner).refund(id2);
    t = await fx.escrow.getDeposit(id2);
    expect(t[GD.status]).to.equal(D_REFUNDED);
    expect(t[GD.createdAt]).to.be.gt(0n);
    expect(t[GD.settledAt]).to.equal(0n);
    expect(t[GD.refundedAt]).to.be.gte(t[GD.createdAt]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 28. stats counters update correctly
  // ─────────────────────────────────────────────────────────────────────────
  it("28. all stats counters update correctly", async () => {
    const fx = await deployFresh();
    const tk = fx.tokenAddr;
    const aff = await fx.affiliate.getAddress();

    expect(await fx.escrow.totalDeposited(tk)).to.equal(0n);
    expect(await fx.escrow.totalSettled(tk)).to.equal(0n);
    expect(await fx.escrow.totalRefunded(tk)).to.equal(0n);
    expect(await fx.escrow.totalTreasuryWithdrawn(tk)).to.equal(0n);
    expect(await fx.escrow.totalAffiliateWithdrawn(tk)).to.equal(0n);
    expect(await fx.escrow.totalExcessRescued(tk)).to.equal(0n);

    const a = 199_000_000n;
    const b = 179_100_000n;
    await fundAndDeposit(fx, a, "pi_28a", "a.gao");
    await fundAndDeposit(fx, b, "pi_28b", "b.gao");
    expect(await fx.escrow.totalDeposited(tk)).to.equal(a + b);

    const { invoiceId: ida } = ids("pi_28a", "a.gao");
    await fx.escrow.connect(fx.owner).settle(ida, aff, 19_900_000n);
    expect(await fx.escrow.totalSettled(tk)).to.equal(a);

    const { invoiceId: idb } = ids("pi_28b", "b.gao");
    await fx.escrow.connect(fx.owner).refund(idb);
    expect(await fx.escrow.totalRefunded(tk)).to.equal(b);

    await fx.escrow.connect(fx.owner).withdrawTreasury(tk, a - 19_900_000n);
    expect(await fx.escrow.totalTreasuryWithdrawn(tk)).to.equal(a - 19_900_000n);

    await fx.escrow.connect(fx.affiliate).withdrawAffiliate(tk, 19_900_000n);
    expect(await fx.escrow.totalAffiliateWithdrawn(tk)).to.equal(19_900_000n);

    await fx.token.mint(fx.escrowAddr, 12_345n);
    await fx.escrow
      .connect(fx.owner)
      .rescueExcessToken(tk, await fx.attacker.getAddress(), 12_345n);
    expect(await fx.escrow.totalExcessRescued(tk)).to.equal(12_345n);

    await expectInvariant(fx);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extra safety: settle (affiliate=0, amount>0) and (affiliate≠0, amount=0)
  // ─────────────────────────────────────────────────────────────────────────
  it("safety A: settle rejects (affiliate=0, amount>0) and (affiliate≠0, amount=0)", async () => {
    const fx = await deployFresh();
    const amount = 199_000_000n;
    const { invoiceId: id1 } = await fundAndDeposit(fx, amount, "pi_sa", "sa.gao");
    await expect(
      fx.escrow.connect(fx.owner).settle(id1, ZERO_ADDR, 1n),
    ).to.be.revertedWithCustomError(fx.escrow, "InvalidAffiliateSplit");

    const { invoiceId: id2 } = await fundAndDeposit(fx, amount, "pi_sb", "sb.gao");
    await expect(
      fx.escrow
        .connect(fx.owner)
        .settle(id2, await fx.affiliate.getAddress(), 0n),
    ).to.be.revertedWithCustomError(fx.escrow, "InvalidAffiliateSplit");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extra safety: views accountedBalance + excessBalance behaviour.
  // ─────────────────────────────────────────────────────────────────────────
  it("safety B: accountedBalance / excessBalance reflect bucket sums", async () => {
    const fx = await deployFresh();
    expect(await fx.escrow.accountedBalance(fx.tokenAddr)).to.equal(0n);
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);

    const amount = 199_000_000n;
    await fundAndDeposit(fx, amount, "pi_sb1", "sb1.gao");
    expect(await fx.escrow.accountedBalance(fx.tokenAddr)).to.equal(amount);
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(0n);

    await fx.token.mint(fx.escrowAddr, 5n);
    expect(await fx.escrow.excessBalance(fx.tokenAddr)).to.equal(5n);
  });
});
