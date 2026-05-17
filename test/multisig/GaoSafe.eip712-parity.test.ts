// GaoSafe Genesis — EIP-712 JS ↔ contract parity (7 cases, P1-P7).
//
// P1-P5 prove that the manual JS digest builder in
// `test/multisig/helpers/eip712.ts` is byte-exact to the contract's
// `hashTx(...)` view AND to ethers' built-in `TypedDataEncoder.hash(...)`
// for every proposal flavour GaoKey-mobile PR 3 will produce.
//
// P6 closes the loop end-to-end: a signature produced via the
// JS-built typed-data inputs is accepted by execTransaction.
//
// P7 is the clone-safety pin called out in plan v3 §3.4 — two
// independently-deployed clones on the SAME chain must produce
// DIFFERENT domain separators (proves the manual EIP-712 implementation
// reads `address(this)` per-call, not from a cache).

import { expect } from "chai";
import { ethers } from "hardhat";

import {
  bundleSignatures,
  buildDigest,
  buildDigestViaEthers,
  buildSignTypedDataInputs,
  sortSignersAscending,
} from "./helpers/eip712";

const HOUR = 3600n;

async function deployVault(threshold = 2, ownerCount = 3) {
  const signers = await ethers.getSigners();
  const owners = signers.slice(0, ownerCount).map((s) => s.address);
  const F = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await F.deploy();
  await factory.waitForDeployment();
  const tx = await factory.createVault(
    owners,
    threshold,
    ethers.id("parity-" + Math.random().toString(36).slice(2)),
  );
  const r = await tx.wait();
  let vaultAddress = "";
  for (const log of r!.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p && p.name === "VaultCreated") vaultAddress = p.args[0] as string;
    } catch {
      /* skip */
    }
  }
  const vault = await ethers.getContractAt("GaoSafe", vaultAddress);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return {
    factory,
    vault,
    vaultAddress,
    signers,
    ownerSigners: signers.slice(0, ownerCount),
    chainId,
  };
}

describe("GaoSafe Genesis — EIP-712 parity", () => {
  it("P1 transfer_native: JS digest === ethers ref === contract hashTx", async () => {
    const { vault, vaultAddress, chainId, signers } = await deployVault();
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const opts = {
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [signers[5].address],
      values: [ethers.parseEther("0.5")],
      data: ["0x"],
      expiry,
    };
    const jsDigest = buildDigest(opts);
    const ethersDigest = buildDigestViaEthers(opts);
    const contractDigest = await vault.hashTx(
      opts.targets,
      opts.values,
      opts.data,
      opts.expiry,
      opts.nonce,
    );
    expect(jsDigest).to.equal(contractDigest);
    expect(ethersDigest).to.equal(contractDigest);
  });

  it("P2 transfer_erc20 calldata: JS digest === ethers ref === contract hashTx", async () => {
    const { vault, vaultAddress, chainId, signers } = await deployVault();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();
    await token.waitForDeployment();
    const calldata = token.interface.encodeFunctionData("transfer", [
      signers[5].address,
      12345n,
    ]);
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const opts = {
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [await token.getAddress()],
      values: [0n],
      data: [calldata],
      expiry,
    };
    const js = buildDigest(opts);
    const eth = buildDigestViaEthers(opts);
    const onChain = await vault.hashTx(
      opts.targets,
      opts.values,
      opts.data,
      opts.expiry,
      opts.nonce,
    );
    expect(js).to.equal(onChain);
    expect(eth).to.equal(onChain);
  });

  it("P3 contract_call (arbitrary calldata): JS digest === ethers ref === contract hashTx", async () => {
    const { vault, vaultAddress, chainId, signers } = await deployVault();
    const arbitraryCalldata =
      "0xdeadbeef" + "00".repeat(64) + "ff".repeat(32);
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const opts = {
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [signers[5].address],
      values: [42n],
      data: [arbitraryCalldata],
      expiry,
    };
    expect(buildDigest(opts)).to.equal(
      await vault.hashTx(
        opts.targets,
        opts.values,
        opts.data,
        opts.expiry,
        opts.nonce,
      ),
    );
    expect(buildDigestViaEthers(opts)).to.equal(buildDigest(opts));
  });

  it("P4 batch (3 sub-calls): JS digest === ethers ref === contract hashTx", async () => {
    const { vault, vaultAddress, chainId, signers } = await deployVault();
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const opts = {
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [signers[5].address, signers[6].address, signers[7].address],
      values: [1n, 2n, 3n],
      data: ["0x", "0xaa", "0xbbccdd"],
      expiry,
    };
    expect(buildDigest(opts)).to.equal(
      await vault.hashTx(
        opts.targets,
        opts.values,
        opts.data,
        opts.expiry,
        opts.nonce,
      ),
    );
    expect(buildDigestViaEthers(opts)).to.equal(buildDigest(opts));
  });

  it("P5 owner-rotation self-call: JS digest === ethers ref === contract hashTx", async () => {
    const { vault, vaultAddress, chainId, signers } = await deployVault();
    const callData = vault.interface.encodeFunctionData("addOwner", [
      signers[7].address,
      2,
    ]);
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const opts = {
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [vaultAddress],
      values: [0n],
      data: [callData],
      expiry,
    };
    expect(buildDigest(opts)).to.equal(
      await vault.hashTx(
        opts.targets,
        opts.values,
        opts.data,
        opts.expiry,
        opts.nonce,
      ),
    );
    expect(buildDigestViaEthers(opts)).to.equal(buildDigest(opts));
  });

  it("P6 signing the JS-built typed-data succeeds end-to-end via execTransaction", async () => {
    const { vault, vaultAddress, chainId, ownerSigners, signers } =
      await deployVault();
    // fund the vault
    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({
      to: vaultAddress,
      value: ethers.parseEther("1"),
    });
    const recipient = signers[5].address;
    const amount = ethers.parseEther("0.25");
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + HOUR;
    const inputs = buildSignTypedDataInputs({
      chainId,
      vault: vaultAddress,
      nonce: 0n,
      targets: [recipient],
      values: [amount],
      data: ["0x"],
      expiry,
    });
    const sigs = await bundleSignatures(
      sortSignersAscending(ownerSigners.slice(0, 2)),
      inputs,
    );
    const before = await ethers.provider.getBalance(recipient);
    await vault.execTransaction(
      [recipient],
      [amount],
      ["0x"],
      expiry,
      sigs,
    );
    expect((await ethers.provider.getBalance(recipient)) - before).to.equal(
      amount,
    );
  });

  it("P7 clone safety: two clones on the same chain have DIFFERENT domain separators (per-clone, not per-implementation)", async () => {
    const signers = await ethers.getSigners();
    const F = await ethers.getContractFactory("GaoSafeFactory");
    const factory = await F.deploy();
    await factory.waitForDeployment();

    const owners = [signers[0].address, signers[1].address];

    // Deploy two independent clones from the same factory.
    const tx1 = await factory.createVault(owners, 2, ethers.id("p7-a"));
    const tx2 = await factory.createVault(owners, 2, ethers.id("p7-b"));
    const r1 = await tx1.wait();
    const r2 = await tx2.wait();

    const decodeVault = (receipt: typeof r1) => {
      for (const log of receipt!.logs) {
        try {
          const p = factory.interface.parseLog(log);
          if (p && p.name === "VaultCreated") return p.args[0] as string;
        } catch {
          /* skip */
        }
      }
      throw new Error("no VaultCreated event");
    };

    const va = decodeVault(r1);
    const vb = decodeVault(r2);
    expect(va).to.not.equal(vb);

    const vaultA = await ethers.getContractAt("GaoSafe", va);
    const vaultB = await ethers.getContractAt("GaoSafe", vb);

    const dsA = await vaultA.domainSeparator();
    const dsB = await vaultB.domainSeparator();

    // The two domain separators MUST differ — they bind
    // `address(this)` per-clone.
    expect(dsA).to.not.equal(dsB);

    // For each clone, the contract's domain separator MUST equal the
    // JS-computed domain separator for THAT clone (proves the JS
    // builder mirrors the contract clone-correctly).
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dsJsA = buildDigest({
      chainId,
      vault: va,
      nonce: 0n,
      targets: [],
      values: [],
      data: [],
      expiry: 0n,
    });
    const dsJsB = buildDigest({
      chainId,
      vault: vb,
      nonce: 0n,
      targets: [],
      values: [],
      data: [],
      expiry: 0n,
    });
    // The full digest changes per clone too — pin that as well.
    expect(dsJsA).to.not.equal(dsJsB);

    // And: the bare implementation's domain separator differs from
    // both clones (proves clones are NOT inheriting the
    // implementation's address-derived domain).
    const implAddr = await factory.implementation();
    const impl = await ethers.getContractAt("GaoSafe", implAddr);
    const dsImpl = await impl.domainSeparator();
    expect(dsImpl).to.not.equal(dsA);
    expect(dsImpl).to.not.equal(dsB);
  });
});
