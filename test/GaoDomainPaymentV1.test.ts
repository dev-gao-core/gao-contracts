// GaoDomainPaymentV1 unit tests.
//
// GaoDomainPaymentV1 replaces the GaoDomainDepositV3 escrow/settle launch
// path with a custody-free direct-to-treasury model. The contract pulls
// an allowlisted ERC-20 from the buyer and forwards it to the treasury in
// the same transaction, emitting a single `DomainPurchased` evidence
// event. There is no escrow balance, no settle, no withdraw, no affiliate
// surface, and no backend signer in the purchase path.
//
// Coverage:
//   * happy path: USDC moves buyer -> treasury, contract balance stays 0
//   * DomainPurchased event carries all 11 fields
//   * owner == payer == msg.sender (v1 invariant)
//   * replay guard (duplicate invoice reverts)
//   * domainName / domainHash binding
//   * token allowlist, zero amount / invoice / domain / profile guards
//   * pause / unpause
//   * owner-only admin + treasury update + token rescue
//   * SafeERC20 behaviour (no-return + false-return tokens)
//   * reentrancy guard

import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const AMOUNT = 199_000_000n; // 199 USDC (6 decimals)
const PROFILE_URI = "ipfs://bafybeibgaodomainprofilev1testcidplaceholder";

describe("GaoDomainPaymentV1", () => {
  async function deployFresh() {
    const [owner, payer, treasury, otherUser, attacker, rescueTarget] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Other = await ethers.getContractFactory("MockERC20");
    const otherToken = await Other.deploy();
    await otherToken.waitForDeployment();

    const Payment = await ethers.getContractFactory("GaoDomainPaymentV1");
    const payment = await Payment.deploy(
      await owner.getAddress(),
      await treasury.getAddress(),
    );
    await payment.waitForDeployment();

    const paymentAddr = await payment.getAddress();
    const tokenAddr = await token.getAddress();

    // Allowlist USDC + fund the payer with 10,000 USDC.
    await (await payment.connect(owner).setAllowedToken(tokenAddr, true)).wait();
    await (await token.mint(await payer.getAddress(), 10_000_000_000n)).wait();

    return {
      owner,
      payer,
      treasury,
      otherUser,
      attacker,
      rescueTarget,
      token,
      otherToken,
      payment,
      paymentAddr,
      tokenAddr,
      otherTokenAddr: await otherToken.getAddress(),
      treasuryAddr: await treasury.getAddress(),
    };
  }

  function ids(seed = "pi_pay_001", domain = "11111111.gao") {
    return {
      invoiceId: ethers.keccak256(ethers.toUtf8Bytes(seed)),
      domainHash: ethers.keccak256(ethers.toUtf8Bytes(domain)),
      domainName: domain,
      profileHash: ethers.keccak256(ethers.toUtf8Bytes(`${seed}:${domain}:profile`)),
    };
  }

  // Approve + pay against the standard MockERC20 token.
  async function fundAndPay(
    fx: Awaited<ReturnType<typeof deployFresh>>,
    amount: bigint,
    seed = "pi_pay_001",
    domain = "11111111.gao",
  ) {
    const { invoiceId, domainHash, domainName, profileHash } = ids(seed, domain);
    await (await fx.token.connect(fx.payer).approve(fx.paymentAddr, amount)).wait();
    const tx = await fx.payment
      .connect(fx.payer)
      .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, amount, PROFILE_URI, profileHash);
    return { tx, invoiceId, domainHash, domainName, profileHash };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Happy path + evidence
  // ═══════════════════════════════════════════════════════════════════

  describe("happy path + DomainPurchased evidence", () => {
    it("P1 — moves USDC buyer -> treasury, contract balance stays zero, invoicePaid set", async () => {
      const fx = await deployFresh();
      const payerAddr = await fx.payer.getAddress();
      const payerBefore = await fx.token.balanceOf(payerAddr);
      const treasBefore = await fx.token.balanceOf(fx.treasuryAddr);

      const { invoiceId } = await fundAndPay(fx, AMOUNT);

      expect(await fx.token.balanceOf(payerAddr)).to.equal(payerBefore - AMOUNT);
      expect(await fx.token.balanceOf(fx.treasuryAddr)).to.equal(treasBefore + AMOUNT);
      // The contract NEVER holds funds.
      expect(await fx.token.balanceOf(fx.paymentAddr)).to.equal(0n);
      expect(await fx.payment.invoicePaid(invoiceId)).to.equal(true);
    });

    it("P2 — emits DomainPurchased with all fields; owner == payer == msg.sender", async () => {
      const fx = await deployFresh();
      const payerAddr = await fx.payer.getAddress();
      const { invoiceId, domainHash, domainName, profileHash } = ids();
      await (await fx.token.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();

      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      )
        .to.emit(fx.payment, "DomainPurchased")
        .withArgs(
          invoiceId,
          payerAddr, // payer (indexed)
          domainHash,
          payerAddr, // owner == payer in v1
          domainName,
          fx.tokenAddr,
          AMOUNT,
          fx.treasuryAddr,
          PROFILE_URI,
          profileHash,
          anyValue, // block.timestamp
        );
    });

    it("P3 — contract balance remains zero across multiple distinct purchases", async () => {
      const fx = await deployFresh();
      await fundAndPay(fx, AMOUNT, "pi_a", "aaa.gao");
      await fundAndPay(fx, 50_000_000n, "pi_b", "bbb.gao");
      await fundAndPay(fx, 1n, "pi_c", "ccc.gao");
      expect(await fx.token.balanceOf(fx.paymentAddr)).to.equal(0n);
      const treas = await fx.token.balanceOf(fx.treasuryAddr);
      expect(treas).to.equal(AMOUNT + 50_000_000n + 1n);
    });

    it("P4 — anyone can pay (msg.sender is payer+owner); a different wallet purchases for itself", async () => {
      const fx = await deployFresh();
      const otherAddr = await fx.otherUser.getAddress();
      await (await fx.token.mint(otherAddr, AMOUNT)).wait();
      await (await fx.token.connect(fx.otherUser).approve(fx.paymentAddr, AMOUNT)).wait();
      const { invoiceId, domainHash, domainName, profileHash } = ids("pi_other", "other.gao");
      await expect(
        fx.payment
          .connect(fx.otherUser)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      )
        .to.emit(fx.payment, "DomainPurchased")
        .withArgs(
          invoiceId,
          otherAddr,
          domainHash,
          otherAddr,
          domainName,
          fx.tokenAddr,
          AMOUNT,
          fx.treasuryAddr,
          PROFILE_URI,
          profileHash,
          anyValue,
        );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Validation reverts
  // ═══════════════════════════════════════════════════════════════════

  describe("validation reverts", () => {
    it("P5 — duplicate invoiceId reverts InvoiceAlreadyPaid", async () => {
      const fx = await deployFresh();
      await fundAndPay(fx, AMOUNT, "dup", "dup.gao");
      const { invoiceId, domainHash, domainName, profileHash } = ids("dup", "dup.gao");
      await (await fx.token.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "InvoiceAlreadyPaid");
    });

    it("P6 — domainName not matching domainHash reverts DomainNameHashMismatch", async () => {
      const fx = await deployFresh();
      const { invoiceId, profileHash } = ids("mismatch", "real.gao");
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("different.gao"));
      await (await fx.token.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, wrongHash, "real.gao", fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "DomainNameHashMismatch");
    });

    it("P7 — token not on allowlist reverts TokenNotAllowed", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash, domainName, profileHash } = ids("notallowed", "na.gao");
      await (await fx.otherToken.mint(await fx.payer.getAddress(), AMOUNT)).wait();
      await (await fx.otherToken.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.otherTokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "TokenNotAllowed");
    });

    it("P8 — zero amount reverts InvalidAmount", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash, domainName, profileHash } = ids("amt0", "amt0.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, 0n, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "InvalidAmount");
    });

    it("P9 — zero invoiceId reverts ZeroInvoiceId", async () => {
      const fx = await deployFresh();
      const { domainHash, domainName, profileHash } = ids("inv0", "inv0.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(ethers.ZeroHash, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroInvoiceId");
    });

    it("P10 — zero domainHash reverts ZeroDomainHash", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainName, profileHash } = ids("dh0", "dh0.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, ethers.ZeroHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroDomainHash");
    });

    it("P11 — empty domainName reverts EmptyDomainName", async () => {
      const fx = await deployFresh();
      const { invoiceId, profileHash } = ids("emptyname", "x.gao");
      // domainHash must be non-zero to reach the domainName check.
      const someHash = ethers.keccak256(ethers.toUtf8Bytes(""));
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, someHash, "", fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "EmptyDomainName");
    });

    it("P12 — empty profileURI reverts EmptyProfileURI", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash, domainName, profileHash } = ids("emptyuri", "eu.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, "", profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "EmptyProfileURI");
    });

    it("P13 — zero profileHash reverts ZeroProfileHash", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash, domainName } = ids("ph0", "ph0.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroProfileHash");
    });

    it("P14 — zero token address reverts ZeroAddress", async () => {
      const fx = await deployFresh();
      const { invoiceId, domainHash, domainName, profileHash } = ids("tok0", "tok0.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, ZERO_ADDR, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroAddress");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Pause
  // ═══════════════════════════════════════════════════════════════════

  describe("pause / unpause", () => {
    it("P15 — pause blocks payForDomain with EnforcedPause", async () => {
      const fx = await deployFresh();
      await (await fx.payment.connect(fx.owner).pause()).wait();
      const { invoiceId, domainHash, domainName, profileHash } = ids("paused", "paused.gao");
      await (await fx.token.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, fx.tokenAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "EnforcedPause");
    });

    it("P16 — unpause resumes payForDomain", async () => {
      const fx = await deployFresh();
      await (await fx.payment.connect(fx.owner).pause()).wait();
      await (await fx.payment.connect(fx.owner).unpause()).wait();
      await expect((await fundAndPay(fx, AMOUNT, "resumed", "resumed.gao")).tx).to.emit(
        fx.payment,
        "DomainPurchased",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Admin / owner-only
  // ═══════════════════════════════════════════════════════════════════

  describe("constructor + admin", () => {
    it("P17 — constructor rejects zero treasury and zero owner; emits initial TreasuryUpdated", async () => {
      const [a] = await ethers.getSigners();
      const Payment = await ethers.getContractFactory("GaoDomainPaymentV1");
      await expect(
        Payment.deploy(await a.getAddress(), ZERO_ADDR),
      ).to.be.revertedWithCustomError(Payment, "ZeroAddress");
      await expect(
        Payment.deploy(ZERO_ADDR, await a.getAddress()),
      ).to.be.revertedWithCustomError(Payment, "OwnableInvalidOwner");
      // Successful construction emits TreasuryUpdated(0, treasury).
      const treasuryAddr = await a.getAddress();
      const p = await Payment.deploy(await a.getAddress(), treasuryAddr);
      await expect(p.deploymentTransaction())
        .to.emit(p, "TreasuryUpdated")
        .withArgs(ZERO_ADDR, treasuryAddr);
    });

    it("P18 — setTreasury updates + emits + rejects zero; new payment routes to new treasury", async () => {
      const fx = await deployFresh();
      const newT = await fx.otherUser.getAddress();
      await expect(fx.payment.connect(fx.owner).setTreasury(newT))
        .to.emit(fx.payment, "TreasuryUpdated")
        .withArgs(fx.treasuryAddr, newT);
      expect(await fx.payment.treasury()).to.equal(newT);
      await expect(
        fx.payment.connect(fx.owner).setTreasury(ZERO_ADDR),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroAddress");

      // A subsequent purchase pays the NEW treasury.
      const newBefore = await fx.token.balanceOf(newT);
      await fundAndPay(fx, AMOUNT, "afterT", "aftert.gao");
      expect(await fx.token.balanceOf(newT)).to.equal(newBefore + AMOUNT);
    });

    it("P19 — setAllowedToken toggles + emits + rejects zero", async () => {
      const fx = await deployFresh();
      expect(await fx.payment.allowedTokens(fx.otherTokenAddr)).to.equal(false);
      await expect(fx.payment.connect(fx.owner).setAllowedToken(fx.otherTokenAddr, true))
        .to.emit(fx.payment, "AllowedTokenUpdated")
        .withArgs(fx.otherTokenAddr, true);
      expect(await fx.payment.allowedTokens(fx.otherTokenAddr)).to.equal(true);
      await expect(fx.payment.connect(fx.owner).setAllowedToken(fx.otherTokenAddr, false))
        .to.emit(fx.payment, "AllowedTokenUpdated")
        .withArgs(fx.otherTokenAddr, false);
      await expect(
        fx.payment.connect(fx.owner).setAllowedToken(ZERO_ADDR, true),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroAddress");
    });

    it("P20 — non-owner cannot call any onlyOwner function", async () => {
      const fx = await deployFresh();
      const E = fx.payment.connect(fx.attacker);
      const attackerAddr = await fx.attacker.getAddress();
      const cases: Array<() => Promise<unknown>> = [
        () => E.setAllowedToken(fx.tokenAddr, false),
        () => E.setTreasury(attackerAddr),
        () => E.pause(),
        () => E.unpause(),
        () => E.rescueToken(fx.tokenAddr, attackerAddr, 1n),
      ];
      for (const c of cases) {
        await expect(c()).to.be.revertedWithCustomError(fx.payment, "OwnableUnauthorizedAccount");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // rescueToken
  // ═══════════════════════════════════════════════════════════════════

  describe("rescueToken (accidental transfers)", () => {
    it("P21 — owner rescues stray tokens to a recipient; emits TokenRescued", async () => {
      const fx = await deployFresh();
      const stray = 12_345n;
      // Simulate a stray transfer into the payment contract.
      await (await fx.token.mint(fx.paymentAddr, stray)).wait();
      const to = await fx.rescueTarget.getAddress();
      const toBefore = await fx.token.balanceOf(to);
      await expect(fx.payment.connect(fx.owner).rescueToken(fx.tokenAddr, to, stray))
        .to.emit(fx.payment, "TokenRescued")
        .withArgs(fx.tokenAddr, to, stray);
      expect(await fx.token.balanceOf(to)).to.equal(toBefore + stray);
      expect(await fx.token.balanceOf(fx.paymentAddr)).to.equal(0n);
    });

    it("P22 — rescueToken rejects zero address + zero amount", async () => {
      const fx = await deployFresh();
      const to = await fx.rescueTarget.getAddress();
      await expect(
        fx.payment.connect(fx.owner).rescueToken(ZERO_ADDR, to, 1n),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroAddress");
      await expect(
        fx.payment.connect(fx.owner).rescueToken(fx.tokenAddr, ZERO_ADDR, 1n),
      ).to.be.revertedWithCustomError(fx.payment, "ZeroAddress");
      await expect(
        fx.payment.connect(fx.owner).rescueToken(fx.tokenAddr, to, 0n),
      ).to.be.revertedWithCustomError(fx.payment, "InvalidAmount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SafeERC20 behaviour
  // ═══════════════════════════════════════════════════════════════════

  describe("SafeERC20 behaviour", () => {
    it("P23 — no-return (USDT-style) token works; funds reach treasury", async () => {
      const fx = await deployFresh();
      const NR = await ethers.getContractFactory("NoReturnERC20");
      const nr = await NR.deploy();
      await nr.waitForDeployment();
      const nrAddr = await nr.getAddress();
      await (await fx.payment.connect(fx.owner).setAllowedToken(nrAddr, true)).wait();
      await (await nr.mint(await fx.payer.getAddress(), AMOUNT)).wait();
      await (await nr.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();

      const { invoiceId, domainHash, domainName, profileHash } = ids("nr", "nr.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, nrAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.emit(fx.payment, "DomainPurchased");
      expect(await nr.balanceOf(fx.treasuryAddr)).to.equal(AMOUNT);
      expect(await nr.balanceOf(fx.paymentAddr)).to.equal(0n);
    });

    it("P24 — false-return token reverts SafeERC20FailedOperation", async () => {
      const fx = await deployFresh();
      const FR = await ethers.getContractFactory("FalseReturnERC20");
      const fr = await FR.deploy();
      await fr.waitForDeployment();
      const frAddr = await fr.getAddress();
      await (await fx.payment.connect(fx.owner).setAllowedToken(frAddr, true)).wait();
      await (await fr.mint(await fx.payer.getAddress(), AMOUNT)).wait();
      await (await fr.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();

      const { invoiceId, domainHash, domainName, profileHash } = ids("fr", "fr.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, frAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "SafeERC20FailedOperation");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Reentrancy
  // ═══════════════════════════════════════════════════════════════════

  describe("reentrancy guard", () => {
    it("P25 — a re-entrant token transferFrom is rejected by nonReentrant", async () => {
      const fx = await deployFresh();
      const RE = await ethers.getContractFactory("ReentrantERC20");
      const re = await RE.deploy();
      await re.waitForDeployment();
      const reAddr = await re.getAddress();
      await (await re.setPayment(fx.paymentAddr)).wait();
      await (await fx.payment.connect(fx.owner).setAllowedToken(reAddr, true)).wait();
      await (await re.mint(await fx.payer.getAddress(), AMOUNT)).wait();
      await (await re.connect(fx.payer).approve(fx.paymentAddr, AMOUNT)).wait();

      const { invoiceId, domainHash, domainName, profileHash } = ids("re", "re.gao");
      await expect(
        fx.payment
          .connect(fx.payer)
          .payForDomain(invoiceId, domainHash, domainName, reAddr, AMOUNT, PROFILE_URI, profileHash),
      ).to.be.revertedWithCustomError(fx.payment, "ReentrancyGuardReentrantCall");
    });
  });
});
