// GaoDomainDeposit unit tests.
//
// Mirrors the failure-reason taxonomy of the off-chain verifier. Each
// rejection branch in the contract has a matching "rejected" branch in
// `gao-id-worker/src/contracts/escrow.adapter.ts:verifyDepositTx` —
// these tests pin the contract behaviour so a future revision cannot
// silently change verification semantics.

import { expect } from "chai";
import { ethers } from "hardhat";

// MockERC20 is compiled from src/test/MockERC20.sol — Hardhat picks it
// up automatically because it lives under our `paths.sources`.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("GaoDomainDeposit", () => {
  async function deployFresh() {
    const [owner, payer, buyer, other] = await ethers.getSigners();

    // Deploy the mock ERC-20 by inlining the source via solc options.
    // Hardhat doesn't support inline contracts directly; we emit a
    // tmp .sol file would be heavier. Use the `MockERC20` if it's in
    // src/test/, otherwise fall back to deploying via a factory built
    // from the inline source. For simplicity here we rely on a
    // companion file at src/MockERC20.sol (also kept in the package).
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Escrow = await ethers.getContractFactory("GaoDomainDeposit");
    const escrow = await Escrow.deploy(await owner.getAddress());
    await escrow.waitForDeployment();

    // Allowlist the mock token.
    await (await escrow.setAllowedToken(await token.getAddress(), true)).wait();

    // Fund payer with 1,000 USDC (1e9 base units at 6 decimals).
    await (await token.mint(await payer.getAddress(), 1_000_000_000n)).wait();

    return {
      owner,
      payer,
      buyer,
      other,
      token,
      escrow,
      tokenAddr: await token.getAddress(),
      escrowAddr: await escrow.getAddress(),
    };
  }

  function ids() {
    const invoiceId = ethers.keccak256(ethers.toUtf8Bytes("pi_test_001"));
    const domainHash = ethers.keccak256(ethers.toUtf8Bytes("kinggao.gao"));
    return { invoiceId, domainHash };
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  it("allows a deposit and emits Deposited", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n; // $199 in USDC base units

    await (await token.connect(payer).approve(escrowAddr, amount)).wait();

    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount),
    )
      .to.emit(escrow, "Deposited")
      .withArgs(
        invoiceId,
        await buyer.getAddress(),
        domainHash,
        tokenAddr,
        amount,
        await payer.getAddress(),
      );

    expect(await escrow.isPending(invoiceId)).to.equal(true);

    const tuple = await escrow.getDeposit(invoiceId);
    expect(tuple[0]).to.equal(await buyer.getAddress());     // buyer
    expect(tuple[1]).to.equal(1);                            // status DEPOSITED
    expect(tuple[3]).to.equal(false);                        // isReserved
    expect(tuple[4]).to.equal(tokenAddr);                    // paymentToken
    expect(tuple[5]).to.equal(amount);                       // amount
    expect(tuple[6]).to.equal(domainHash);                   // domainHash
    expect(tuple[8]).to.equal(await payer.getAddress());     // payer

    expect(await token.balanceOf(escrowAddr)).to.equal(amount);
  });

  it("supports payer ≠ buyer (gift / treasury sponsor)", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;

    await (await token.connect(payer).approve(escrowAddr, amount)).wait();

    // payer ≠ buyer
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);

    const tuple = await escrow.getDeposit(invoiceId);
    expect(tuple[0]).to.equal(await buyer.getAddress());
    expect(tuple[8]).to.equal(await payer.getAddress());
  });

  // ── Validation rejections ─────────────────────────────────────────────────

  it("rejects buyer = address(0)", async () => {
    const { payer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    await (await token.connect(payer).approve(escrowAddr, 1n)).wait();
    await expect(
      escrow.connect(payer).deposit(ZERO_ADDR, invoiceId, domainHash, tokenAddr, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidBuyer");
  });

  it("rejects domainHash = 0x0", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    await (await token.connect(payer).approve(escrowAddr, 1n)).wait();
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), ids().invoiceId, ZERO_BYTES32, tokenAddr, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidDomainHash");
  });

  it("rejects amount = 0", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    await (await token.connect(payer).approve(escrowAddr, 0n)).wait();
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, 0n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("rejects invoiceId = 0x0", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { domainHash } = ids();
    await (await token.connect(payer).approve(escrowAddr, 1n)).wait();
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), ZERO_BYTES32, domainHash, tokenAddr, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidInvoiceId");
  });

  it("rejects token not in allowedTokens", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    await (await escrow.setAllowedToken(tokenAddr, false)).wait();
    await (await token.connect(payer).approve(escrowAddr, 1n)).wait();
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, 1n),
    ).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
  });

  it("rejects duplicate invoiceId", async () => {
    const { payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    await (await token.connect(payer).approve(escrowAddr, amount * 2n)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount),
    ).to.be.revertedWithCustomError(escrow, "InvoiceAlreadyExists");
  });

  // ── Admin: settle / refund ────────────────────────────────────────────────

  it("settle() flips DEPOSITED → SETTLED and is owner-only", async () => {
    const { owner, other, payer, buyer, token, escrow, tokenAddr, escrowAddr } =
      await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);

    await expect(escrow.connect(other).settle(invoiceId))
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

    await expect(escrow.connect(owner).settle(invoiceId))
      .to.emit(escrow, "Settled")
      .withArgs(invoiceId);

    expect(await escrow.isPending(invoiceId)).to.equal(false);
    expect((await escrow.getDeposit(invoiceId))[1]).to.equal(2); // SETTLED
  });

  it("refund() returns tokens to payer and is owner-only", async () => {
    const { owner, other, payer, buyer, token, escrow, tokenAddr, escrowAddr } =
      await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    const payerBefore = await token.balanceOf(await payer.getAddress());
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);

    await expect(escrow.connect(other).refund(invoiceId))
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

    await expect(escrow.connect(owner).refund(invoiceId))
      .to.emit(escrow, "Refunded")
      .withArgs(invoiceId, await payer.getAddress(), amount);

    expect((await escrow.getDeposit(invoiceId))[1]).to.equal(3); // REFUNDED
    expect(await token.balanceOf(await payer.getAddress())).to.equal(payerBefore);
    expect(await token.balanceOf(escrowAddr)).to.equal(0n);
  });

  it("settle() rejects when not in DEPOSITED state", async () => {
    const { owner, escrow } = await deployFresh();
    const { invoiceId } = ids();
    await expect(escrow.connect(owner).settle(invoiceId))
      .to.be.revertedWithCustomError(escrow, "InvoiceNotInDepositedState");
  });

  it("refund() rejects after settle()", async () => {
    const { owner, payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);
    await escrow.connect(owner).settle(invoiceId);
    await expect(escrow.connect(owner).refund(invoiceId))
      .to.be.revertedWithCustomError(escrow, "InvoiceNotInDepositedState");
  });

  it("settle() rejects after refund()", async () => {
    const { owner, payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);
    await escrow.connect(owner).refund(invoiceId);
    await expect(escrow.connect(owner).settle(invoiceId))
      .to.be.revertedWithCustomError(escrow, "InvoiceNotInDepositedState");
  });

  // ── Pause ────────────────────────────────────────────────────────────────

  it("pause() blocks new deposits but settle/refund still work", async () => {
    const { owner, payer, buyer, token, escrow, tokenAddr, escrowAddr } = await deployFresh();
    const { invoiceId, domainHash } = ids();
    const amount = 199_000_000n;
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await escrow
      .connect(payer)
      .deposit(await buyer.getAddress(), invoiceId, domainHash, tokenAddr, amount);

    await escrow.connect(owner).pause();

    const invoice2 = ethers.keccak256(ethers.toUtf8Bytes("pi_test_002"));
    await (await token.connect(payer).approve(escrowAddr, amount)).wait();
    await expect(
      escrow
        .connect(payer)
        .deposit(await buyer.getAddress(), invoice2, domainHash, tokenAddr, amount),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");

    // Settle / refund still work while paused.
    await expect(escrow.connect(owner).settle(invoiceId)).to.emit(escrow, "Settled");

    await escrow.connect(owner).unpause();
  });

  // ── Allowlist event ──────────────────────────────────────────────────────

  it("setAllowedToken emits AllowedTokenSet", async () => {
    const { owner, escrow, tokenAddr } = await deployFresh();
    await expect(escrow.connect(owner).setAllowedToken(tokenAddr, false))
      .to.emit(escrow, "AllowedTokenSet")
      .withArgs(tokenAddr, false);
  });

  it("setAllowedToken / pause / unpause are owner-only", async () => {
    const { other, escrow, tokenAddr } = await deployFresh();
    await expect(escrow.connect(other).setAllowedToken(tokenAddr, false))
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    await expect(escrow.connect(other).pause())
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    await expect(escrow.connect(other).unpause())
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

});
