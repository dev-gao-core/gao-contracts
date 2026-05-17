// GaoSafeFactory Genesis — factory behaviour matrix (10 cases).

import { expect } from "chai";
import { ethers } from "hardhat";

describe("GaoSafeFactory Genesis", () => {
  async function deployFactory() {
    const F = await ethers.getContractFactory("GaoSafeFactory");
    const factory = await F.deploy();
    await factory.waitForDeployment();
    return factory;
  }

  it("F1 constructor deploys an implementation singleton", async () => {
    const factory = await deployFactory();
    const impl = await factory.implementation();
    expect(impl).to.not.equal(ethers.ZeroAddress);
    // Implementation has runtime bytecode (not a clone, not an EOA).
    const code = await ethers.provider.getCode(impl);
    expect(code).to.not.equal("0x");
    expect(code.length).to.be.greaterThan(2 + 45 * 2); // > EIP-1167 stub
  });

  it("F2 createVault returns a clone of the implementation", async () => {
    const factory = await deployFactory();
    const [s0, s1] = await ethers.getSigners();
    const tx = await factory.createVault(
      [s0.address, s1.address],
      2,
      ethers.id("f2-salt"),
    );
    const receipt = await tx.wait();
    let vaultAddress = "";
    for (const log of receipt!.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "VaultCreated") {
          vaultAddress = parsed.args[0] as string;
        }
      } catch {
        /* skip */
      }
    }
    expect(vaultAddress).to.not.equal("");
    const code = await ethers.provider.getCode(vaultAddress);
    // EIP-1167 minimal proxy bytecode is exactly 45 bytes (0x prefix + 90 hex chars).
    expect(code.length).to.equal(2 + 45 * 2);
    // The clone's bytecode contains the implementation address.
    const impl = await factory.implementation();
    expect(code.toLowerCase()).to.include(impl.slice(2).toLowerCase());
  });

  it("F3 computeVaultAddress matches the deployed vault address", async () => {
    const factory = await deployFactory();
    const [s0, s1] = await ethers.getSigners();
    const clientSalt = ethers.id("f3-salt");
    const predicted = await factory.computeVaultAddress(s0.address, clientSalt);
    const tx = await factory
      .connect(s0)
      .createVault([s0.address, s1.address], 2, clientSalt);
    const receipt = await tx.wait();
    let actual = "";
    for (const log of receipt!.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "VaultCreated") {
          actual = parsed.args[0] as string;
        }
      } catch {
        /* skip */
      }
    }
    expect(actual.toLowerCase()).to.equal(predicted.toLowerCase());
  });

  it("F4 same clientSalt from different deployers produces different addresses", async () => {
    const factory = await deployFactory();
    const [s0, s1, s2] = await ethers.getSigners();
    const clientSalt = ethers.id("shared-salt");
    const a = await factory.computeVaultAddress(s0.address, clientSalt);
    const b = await factory.computeVaultAddress(s1.address, clientSalt);
    expect(a).to.not.equal(b);

    // And the actual deploys also differ — each can claim its own.
    await factory
      .connect(s0)
      .createVault([s0.address, s2.address], 2, clientSalt);
    await factory
      .connect(s1)
      .createVault([s1.address, s2.address], 2, clientSalt);
    expect(await ethers.provider.getCode(a)).to.not.equal("0x");
    expect(await ethers.provider.getCode(b)).to.not.equal("0x");
  });

  it("F5 same (deployer, clientSalt) called twice reverts", async () => {
    const factory = await deployFactory();
    const [s0, s1] = await ethers.getSigners();
    const clientSalt = ethers.id("dup-salt");
    await factory.createVault([s0.address, s1.address], 2, clientSalt);
    await expect(
      factory.createVault([s0.address, s1.address], 2, clientSalt),
    ).to.be.reverted;
  });

  it("F6 createVault propagates setup failures (duplicate owners → revert)", async () => {
    const factory = await deployFactory();
    const [s0] = await ethers.getSigners();
    const impl = await ethers.getContractAt(
      "GaoSafe",
      await factory.implementation(),
    );
    await expect(
      factory.createVault([s0.address, s0.address], 2, ethers.id("dup-prop")),
    ).to.be.revertedWithCustomError(impl, "DuplicateOwner");
  });

  it("F7 vault isOwner reflects supplied owners", async () => {
    const factory = await deployFactory();
    const [s0, s1, s2, outsider] = await ethers.getSigners();
    const owners = [s0.address, s1.address, s2.address];
    const tx = await factory.createVault(owners, 2, ethers.id("f7"));
    const r = await tx.wait();
    let v = "";
    for (const log of r!.logs) {
      try {
        const p = factory.interface.parseLog(log);
        if (p && p.name === "VaultCreated") v = p.args[0] as string;
      } catch {
        /* skip */
      }
    }
    const vault = await ethers.getContractAt("GaoSafe", v);
    for (const o of owners) {
      expect(await vault.isOwner(o)).to.equal(true);
    }
    expect(await vault.isOwner(outsider.address)).to.equal(false);
  });

  it("F8 vault threshold and getOwners reflect supplied values", async () => {
    const factory = await deployFactory();
    const [s0, s1, s2] = await ethers.getSigners();
    const owners = [s0.address, s1.address, s2.address];
    const tx = await factory.createVault(owners, 3, ethers.id("f8"));
    const r = await tx.wait();
    let v = "";
    for (const log of r!.logs) {
      try {
        const p = factory.interface.parseLog(log);
        if (p && p.name === "VaultCreated") v = p.args[0] as string;
      } catch {
        /* skip */
      }
    }
    const vault = await ethers.getContractAt("GaoSafe", v);
    expect(await vault.threshold()).to.equal(3n);
    expect(await vault.getOwners()).to.deep.equal(owners);
    expect(await vault.ownersCount()).to.equal(3n);
  });

  it("F9 VaultCreated event emitted with (vault, deployer, clientSalt, owners, threshold)", async () => {
    const factory = await deployFactory();
    const [s0, s1] = await ethers.getSigners();
    const owners = [s0.address, s1.address];
    const clientSalt = ethers.id("f9");
    const predicted = await factory.computeVaultAddress(s0.address, clientSalt);
    await expect(factory.connect(s0).createVault(owners, 2, clientSalt))
      .to.emit(factory, "VaultCreated")
      .withArgs(predicted, s0.address, clientSalt, owners, 2);
  });

  it("F10 factory has no admin function — no setImplementation / owner / transferOwnership in ABI", async () => {
    const factory = await deployFactory();
    const fragments = factory.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as { name: string }).name.toLowerCase());
    // Negative checks — these admin-style functions MUST NOT exist.
    for (const banned of [
      "setimplementation",
      "owner",
      "transferownership",
      "renounceownership",
      "pause",
      "unpause",
      "upgradeto",
    ]) {
      expect(fragments, `factory must not expose ${banned}`).to.not.include(
        banned,
      );
    }
    // Positive checks — the Genesis surface is exactly:
    expect(fragments).to.include("createvault");
    expect(fragments).to.include("computevaultaddress");
    expect(fragments).to.include("implementation");
  });
});
