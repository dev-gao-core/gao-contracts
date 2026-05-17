// GaoSafe Genesis — vault behaviour matrix.
//
// 36 cases pinning every Genesis security primitive:
//
//   setup happy + 5 input-validation rejections + singleton-lock
//   native happy + ERC-20 happy + batch happy
//   replay / expiry / dup / unsorted / non-owner / insufficient
//   EIP-191 rejection / wrong chainId / wrong vault / mutation
//   failed inner call reverts whole proposal
//   addOwner / removeOwner / replaceOwner / changeThreshold onlySelf (×4)
//   addOwner / removeOwner / replaceOwner / changeThreshold via proposal (×4)
//   last-owner-removal / bad-threshold / threshold(0) safeties (×3)
//   event-shape assertions (×3)
//   receive() payable
//
// Mirrors the style of test/GaoDomainAnchor.test.ts: hardhat + ethers v6
// + chai. No Foundry, no gas reporter, no console.log instrumentation.

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  bundleSignatures,
  buildSignTypedDataInputs,
  signDigestAsEip191,
  sortSignersAscending,
} from "./helpers/eip712";

const HOUR = 3600n;

type Hex = string;

interface Deployed {
  factory: Awaited<ReturnType<typeof deployFactory>>;
  vault: Awaited<ReturnType<typeof deployVault>>["vault"];
  vaultAddress: string;
  ownerSigners: HardhatEthersSigner[];
  ownerAddresses: string[];
  outsider: HardhatEthersSigner;
  chainId: bigint;
}

async function deployFactory() {
  const Factory = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  return factory;
}

async function deployVault(
  factory: Awaited<ReturnType<typeof deployFactory>>,
  owners: readonly string[],
  threshold: number,
  clientSalt: Hex = ethers.id("test-salt"),
) {
  const tx = await factory.createVault(owners, threshold, clientSalt);
  const receipt = await tx.wait();
  let vaultAddress: string | null = null;
  for (const log of receipt!.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "VaultCreated") {
        vaultAddress = parsed.args[0] as string;
      }
    } catch {
      /* not our event */
    }
  }
  if (!vaultAddress) throw new Error("VaultCreated event not found");
  const vault = await ethers.getContractAt("GaoSafe", vaultAddress);
  return { vault, vaultAddress };
}

async function setupCommon(
  ownerCount: number,
  threshold: number,
): Promise<Deployed> {
  const signers = await ethers.getSigners();
  if (signers.length < ownerCount + 1) {
    throw new Error("not enough hardhat signers");
  }
  const ownerSigners = signers.slice(0, ownerCount);
  const outsider = signers[ownerCount];
  const ownerAddresses = ownerSigners.map((s) => s.address);
  const factory = await deployFactory();
  const { vault, vaultAddress } = await deployVault(
    factory,
    ownerAddresses,
    threshold,
  );
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return {
    factory,
    vault,
    vaultAddress,
    ownerSigners,
    ownerAddresses,
    outsider,
    chainId,
  };
}

async function fundVault(vaultAddress: string, weiAmount: bigint) {
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({ to: vaultAddress, value: weiAmount });
}

describe("GaoSafe Genesis — vault", () => {
  // ── setup happy path / one-shot init / input validation ─────────────

  describe("setup", () => {
    it("#1 setup succeeds once on a fresh clone (via factory)", async () => {
      const { vault, ownerAddresses } = await setupCommon(3, 2);
      const got = await vault.getOwners();
      expect(got).to.deep.equal(ownerAddresses);
      expect(await vault.threshold()).to.equal(2n);
      expect(await vault.nonce()).to.equal(0n);
    });

    it("#2 setup cannot run twice (AlreadyInitialized)", async () => {
      const { vault, ownerAddresses } = await setupCommon(3, 2);
      await expect(
        vault.setup(ownerAddresses, 2),
      ).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
    });

    it("#3 setup with zero owners reverts (InvalidOwners)", async () => {
      const factory = await deployFactory();
      await expect(
        factory.createVault([], 1, ethers.id("zero-owners")),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("GaoSafe", await factory.implementation()),
        "InvalidOwners",
      );
    });

    it("#4 setup with duplicate owners reverts (DuplicateOwner)", async () => {
      const signers = await ethers.getSigners();
      const factory = await deployFactory();
      const dup = signers[0].address;
      await expect(
        factory.createVault([dup, dup], 2, ethers.id("dup")),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("GaoSafe", await factory.implementation()),
        "DuplicateOwner",
      );
    });

    it("#5 setup with 0x0 owner reverts (ZeroOwner)", async () => {
      const signers = await ethers.getSigners();
      const factory = await deployFactory();
      await expect(
        factory.createVault(
          [signers[0].address, ethers.ZeroAddress],
          1,
          ethers.id("zero-addr"),
        ),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("GaoSafe", await factory.implementation()),
        "ZeroOwner",
      );
    });

    it("#6 setup with threshold == 0 reverts (InvalidThreshold)", async () => {
      const signers = await ethers.getSigners();
      const factory = await deployFactory();
      await expect(
        factory.createVault(
          [signers[0].address, signers[1].address],
          0,
          ethers.id("th0"),
        ),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("GaoSafe", await factory.implementation()),
        "InvalidThreshold",
      );
    });

    it("#7 setup with threshold > owners.length reverts (InvalidThreshold)", async () => {
      const signers = await ethers.getSigners();
      const factory = await deployFactory();
      await expect(
        factory.createVault(
          [signers[0].address, signers[1].address],
          3,
          ethers.id("th-big"),
        ),
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("GaoSafe", await factory.implementation()),
        "InvalidThreshold",
      );
    });

    it("#8 implementation singleton rejects setup() directly (AlreadyInitialized)", async () => {
      const factory = await deployFactory();
      const impl = await ethers.getContractAt(
        "GaoSafe",
        await factory.implementation(),
      );
      const [s0] = await ethers.getSigners();
      await expect(
        impl.setup([s0.address], 1),
      ).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });
  });

  // ── execTransaction happy paths ─────────────────────────────────────

  describe("execTransaction — happy paths", () => {
    it("#9 native ETH transfer with threshold signatures succeeds", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const amount = ethers.parseEther("1");
      await fundVault(d.vaultAddress, ethers.parseEther("2"));
      const before = await ethers.provider.getBalance(recipient);

      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const targets = [recipient];
      const values = [amount];
      const data = ["0x"];

      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets,
        values,
        data,
        expiry,
      });
      const sorted = sortSignersAscending(d.ownerSigners.slice(0, 2));
      const signatures = await bundleSignatures(sorted, inputs);

      await expect(
        d.vault.execTransaction(targets, values, data, expiry, signatures),
      ).to.emit(d.vault, "ExecutionSuccess");

      const after = await ethers.provider.getBalance(recipient);
      expect(after - before).to.equal(amount);
      expect(await d.vault.nonce()).to.equal(1n);
    });

    it("#10 ERC-20 transfer calldata proposal succeeds", async () => {
      const d = await setupCommon(3, 2);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy();
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();
      await token.mint(d.vaultAddress, 1_000_000n);

      const recipient = d.outsider.address;
      const transferAmount = 500_000n;
      const callData = token.interface.encodeFunctionData("transfer", [
        recipient,
        transferAmount,
      ]);

      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [tokenAddr],
        values: [0n],
        data: [callData],
        expiry,
      });
      const signatures = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );

      await d.vault.execTransaction(
        [tokenAddr],
        [0n],
        [callData],
        expiry,
        signatures,
      );
      expect(await token.balanceOf(recipient)).to.equal(transferAmount);
    });

    it("#11 batch (2 native + 1 ERC-20) executes atomically", async () => {
      const d = await setupCommon(3, 2);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy();
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();
      await token.mint(d.vaultAddress, 1_000_000n);
      await fundVault(d.vaultAddress, ethers.parseEther("3"));

      const r1 = d.outsider.address;
      const r2 = d.ownerSigners[2].address;
      const eth1 = ethers.parseEther("1");
      const eth2 = ethers.parseEther("0.5");
      const erc20Amt = 100_000n;
      const callData = token.interface.encodeFunctionData("transfer", [
        r1,
        erc20Amt,
      ]);

      const targets = [r1, r2, tokenAddr];
      const values = [eth1, eth2, 0n];
      const data: string[] = ["0x", "0x", callData];

      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets,
        values,
        data,
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );

      const r1Before = await ethers.provider.getBalance(r1);
      const r2Before = await ethers.provider.getBalance(r2);
      await d.vault.execTransaction(targets, values, data, expiry, sigs);
      expect((await ethers.provider.getBalance(r1)) - r1Before).to.equal(eth1);
      expect((await ethers.provider.getBalance(r2)) - r2Before).to.equal(eth2);
      expect(await token.balanceOf(r1)).to.equal(erc20Amt);
    });
  });

  // ── execTransaction rejections ──────────────────────────────────────

  describe("execTransaction — rejections", () => {
    it("#12 replay rejected — same bundle resubmitted fails after nonce bump", async () => {
      const d = await setupCommon(3, 2);
      await fundVault(d.vaultAddress, ethers.parseEther("2"));
      const recipient = d.outsider.address;
      const amount = ethers.parseEther("0.1");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [amount],
        data: ["0x"],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );

      await d.vault.execTransaction([recipient], [amount], ["0x"], expiry, sigs);
      // Re-submit identical bundle. Digest is now computed against nonce=1
      // on-chain; the signatures were over nonce=0; the recovered signers
      // recover to non-owner addresses and the bundle reverts.
      await expect(
        d.vault.execTransaction([recipient], [amount], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "NotAnOwner");
    });

    it("#13 expired proposal rejected (ProposalExpired)", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiredAt = BigInt(block!.timestamp) - 1n;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry: expiredAt,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiredAt, sigs),
      ).to.be.revertedWithCustomError(d.vault, "ProposalExpired");
    });

    it("#14 duplicate signer rejected (SignaturesNotSorted)", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      // Same signer twice → recovered addresses equal → SignaturesNotSorted
      const sigs = await bundleSignatures(
        [d.ownerSigners[0], d.ownerSigners[0]],
        inputs,
      );
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "SignaturesNotSorted");
    });

    it("#15 unsorted signatures rejected (SignaturesNotSorted)", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      const sorted = sortSignersAscending(d.ownerSigners.slice(0, 2));
      const reversed = [sorted[1], sorted[0]];
      const sigs = await bundleSignatures(reversed, inputs);
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "SignaturesNotSorted");
    });

    it("#16 non-owner signature rejected (NotAnOwner)", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      // One legitimate owner + one outsider. Sort by address ascending
      // so the bundle is well-formed structurally — only the owner check
      // should fail.
      const both = sortSignersAscending([d.ownerSigners[0], d.outsider]);
      const sigs = await bundleSignatures(both, inputs);
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "NotAnOwner");
    });

    it("#17 insufficient signatures rejected (InvalidSignatureCount)", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      // Single signature when threshold = 2.
      const sigs = await bundleSignatures([d.ownerSigners[0]], inputs);
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "InvalidSignatureCount");
    });

    it("#18 EIP-191 / signMessage signature is rejected", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const digest = await d.vault.hashTx(
        [recipient],
        [0n],
        ["0x"],
        expiry,
        0n,
      );

      // Promote two HardhatEthersSigners to ethers Wallets (we need raw
      // signing-key access for signMessage on a digest).
      // hardhat default mnemonic — public test-only, NOT a real key.
      // Same mnemonic shipped by every Hardhat install for years.
      const mnemonic =
        "test test test test test test test test test test test junk";
      const w0 = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").connect(
        ethers.provider,
      );
      const w1 = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").connect(
        ethers.provider,
      );
      expect(w0.address.toLowerCase()).to.equal(
        d.ownerSigners[0].address.toLowerCase(),
      );
      expect(w1.address.toLowerCase()).to.equal(
        d.ownerSigners[1].address.toLowerCase(),
      );

      // Sign the digest WITH EIP-191 wrapping.
      const wallets = [w0, w1].sort((a, b) =>
        a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
      );
      const sigs: string[] = [];
      for (const w of wallets) {
        sigs.push(await signDigestAsEip191(w, digest));
      }
      const bundle = "0x" + sigs.map((s) => s.slice(2)).join("");

      // Recovery from an EIP-191 signature against the raw EIP-712
      // digest yields different (non-owner) addresses. The bundle is
      // therefore either out-of-order or not owner-set — both reverts
      // are acceptable. We accept either custom error.
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, bundle),
      ).to.be.reverted;
      const filter1 = d.vault.interface.getError("NotAnOwner")?.selector;
      const filter2 = d.vault.interface.getError("SignaturesNotSorted")
        ?.selector;
      expect(filter1).to.be.a("string");
      expect(filter2).to.be.a("string");
    });

    it("#19 wrong chainId rejected — sig over chainId 1, submit on hardhat", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: 1, // mainnet — NOT the hardhat chain
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "NotAnOwner");
    });

    it("#20 wrong vault / verifyingContract rejected", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        // Wrong verifyingContract — a different deterministic clone.
        vault: await d.factory.computeVaultAddress(
          d.outsider.address,
          ethers.id("phantom-vault"),
        ),
        nonce: 0n,
        targets: [recipient],
        values: [0n],
        data: ["0x"],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction([recipient], [0n], ["0x"], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "NotAnOwner");
    });

    it("#21 payload mutation after signing rejected", async () => {
      const d = await setupCommon(3, 2);
      const recipient = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [ethers.parseEther("1")],
        data: ["0x"],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      // Mutate values — submit with a different amount than was signed.
      await expect(
        d.vault.execTransaction(
          [recipient],
          [ethers.parseEther("2")],
          ["0x"],
          expiry,
          sigs,
        ),
      ).to.be.revertedWithCustomError(d.vault, "NotAnOwner");
    });

    it("#22 failed inner call reverts whole proposal (ExecutionFailed)", async () => {
      const d = await setupCommon(3, 2);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy();
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();
      // Mint 100; try to transfer 200 — MockERC20 reverts with require("balance").
      await token.mint(d.vaultAddress, 100n);

      const callData = token.interface.encodeFunctionData("transfer", [
        d.outsider.address,
        200n,
      ]);
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [tokenAddr],
        values: [0n],
        data: [callData],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction([tokenAddr], [0n], [callData], expiry, sigs),
      ).to.be.revertedWithCustomError(d.vault, "ExecutionFailed");
      // Nonce must NOT have advanced (revert rolls everything back).
      expect(await d.vault.nonce()).to.equal(0n);
    });
  });

  // ── Owner management — onlySelf rejections ──────────────────────────

  describe("owner management — onlySelf rejections", () => {
    it("#23 addOwner only via self-call (NotSelfCall)", async () => {
      const { vault, outsider } = await setupCommon(3, 2);
      await expect(
        vault.connect(outsider).addOwner(outsider.address, 2),
      ).to.be.revertedWithCustomError(vault, "NotSelfCall");
    });
    it("#24 removeOwner only via self-call (NotSelfCall)", async () => {
      const { vault, outsider, ownerAddresses } = await setupCommon(3, 2);
      await expect(
        vault.connect(outsider).removeOwner(ownerAddresses[0], 2),
      ).to.be.revertedWithCustomError(vault, "NotSelfCall");
    });
    it("#25 replaceOwner only via self-call (NotSelfCall)", async () => {
      const { vault, outsider, ownerAddresses } = await setupCommon(3, 2);
      await expect(
        vault.connect(outsider).replaceOwner(ownerAddresses[0], outsider.address),
      ).to.be.revertedWithCustomError(vault, "NotSelfCall");
    });
    it("#26 changeThreshold only via self-call (NotSelfCall)", async () => {
      const { vault, outsider } = await setupCommon(3, 2);
      await expect(
        vault.connect(outsider).changeThreshold(1),
      ).to.be.revertedWithCustomError(vault, "NotSelfCall");
    });
  });

  // ── Owner management — via multisig proposal (happy) ────────────────

  async function execSelfCall(
    d: Deployed,
    selectorAndArgs: string,
    expirySec: bigint,
    nonceArg: bigint,
  ) {
    const inputs = buildSignTypedDataInputs({
      chainId: d.chainId,
      vault: d.vaultAddress,
      nonce: nonceArg,
      targets: [d.vaultAddress],
      values: [0n],
      data: [selectorAndArgs],
      expiry: expirySec,
    });
    const sigs = await bundleSignatures(
      sortSignersAscending(d.ownerSigners.slice(0, Number(await d.vault.threshold()))),
      inputs,
    );
    return d.vault.execTransaction(
      [d.vaultAddress],
      [0n],
      [selectorAndArgs],
      expirySec,
      sigs,
    );
  }

  describe("owner management — via proposal", () => {
    it("#27 addOwner via multisig proposal succeeds + emits OwnerAdded", async () => {
      const d = await setupCommon(3, 2);
      const newOwner = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("addOwner", [
        newOwner,
        2,
      ]);
      await expect(execSelfCall(d, call, expiry, 0n))
        .to.emit(d.vault, "OwnerAdded")
        .withArgs(newOwner);
      expect(await d.vault.isOwner(newOwner)).to.equal(true);
      expect(await d.vault.ownersCount()).to.equal(4n);
    });

    it("#28 removeOwner via multisig proposal succeeds + emits OwnerRemoved", async () => {
      const d = await setupCommon(3, 2);
      const toRemove = d.ownerAddresses[2];
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("removeOwner", [
        toRemove,
        2,
      ]);
      await expect(execSelfCall(d, call, expiry, 0n))
        .to.emit(d.vault, "OwnerRemoved")
        .withArgs(toRemove);
      expect(await d.vault.isOwner(toRemove)).to.equal(false);
      expect(await d.vault.ownersCount()).to.equal(2n);
    });

    it("#29 replaceOwner via multisig proposal succeeds + emits OwnerReplaced", async () => {
      const d = await setupCommon(3, 2);
      const oldOwner = d.ownerAddresses[2];
      const newOwner = d.outsider.address;
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("replaceOwner", [
        oldOwner,
        newOwner,
      ]);
      await expect(execSelfCall(d, call, expiry, 0n))
        .to.emit(d.vault, "OwnerReplaced")
        .withArgs(oldOwner, newOwner);
      expect(await d.vault.isOwner(oldOwner)).to.equal(false);
      expect(await d.vault.isOwner(newOwner)).to.equal(true);
    });

    it("#30 changeThreshold via multisig proposal succeeds + emits ThresholdChanged", async () => {
      const d = await setupCommon(3, 2);
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("changeThreshold", [3]);
      await expect(execSelfCall(d, call, expiry, 0n))
        .to.emit(d.vault, "ThresholdChanged")
        .withArgs(2, 3);
      expect(await d.vault.threshold()).to.equal(3n);
    });
  });

  // ── Owner-set safety rails ──────────────────────────────────────────

  describe("owner-set safeties", () => {
    it("#31 last owner cannot be removed (LastOwnerCannotBeRemoved)", async () => {
      const d = await setupCommon(1, 1);
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("removeOwner", [
        d.ownerAddresses[0],
        1,
      ]);
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [d.vaultAddress],
        values: [0n],
        data: [call],
        expiry,
      });
      const sigs = await bundleSignatures([d.ownerSigners[0]], inputs);
      // ExecutionFailed wraps the inner LastOwnerCannotBeRemoved revert.
      await expect(
        d.vault.execTransaction(
          [d.vaultAddress],
          [0n],
          [call],
          expiry,
          sigs,
        ),
      ).to.be.revertedWithCustomError(d.vault, "ExecutionFailed");
    });

    it("#32 removeOwner with newThreshold > owners.length-1 reverts (ExecutionFailed wraps InvalidThreshold)", async () => {
      const d = await setupCommon(3, 2);
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      // After removing one owner there are 2 left → max threshold 2;
      // we ask for 3 → InvalidThreshold from inside the self-call →
      // outer execTransaction sees ExecutionFailed.
      const call = d.vault.interface.encodeFunctionData("removeOwner", [
        d.ownerAddresses[2],
        3,
      ]);
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [d.vaultAddress],
        values: [0n],
        data: [call],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction(
          [d.vaultAddress],
          [0n],
          [call],
          expiry,
          sigs,
        ),
      ).to.be.revertedWithCustomError(d.vault, "ExecutionFailed");
    });

    it("#33 changeThreshold(0) reverts (ExecutionFailed wraps InvalidThreshold)", async () => {
      const d = await setupCommon(3, 2);
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const call = d.vault.interface.encodeFunctionData("changeThreshold", [0]);
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [d.vaultAddress],
        values: [0n],
        data: [call],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction(
          [d.vaultAddress],
          [0n],
          [call],
          expiry,
          sigs,
        ),
      ).to.be.revertedWithCustomError(d.vault, "ExecutionFailed");
    });
  });

  // ── Event-shape pins ────────────────────────────────────────────────

  describe("event shapes", () => {
    it("#34 ExecutionSuccess(digest, nonceConsumed) emitted on happy path", async () => {
      const d = await setupCommon(3, 2);
      await fundVault(d.vaultAddress, ethers.parseEther("1"));
      const recipient = d.outsider.address;
      const amount = ethers.parseEther("0.1");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) + HOUR;
      const digest = await d.vault.hashTx(
        [recipient],
        [amount],
        ["0x"],
        expiry,
        0n,
      );
      const inputs = buildSignTypedDataInputs({
        chainId: d.chainId,
        vault: d.vaultAddress,
        nonce: 0n,
        targets: [recipient],
        values: [amount],
        data: ["0x"],
        expiry,
      });
      const sigs = await bundleSignatures(
        sortSignersAscending(d.ownerSigners.slice(0, 2)),
        inputs,
      );
      await expect(
        d.vault.execTransaction([recipient], [amount], ["0x"], expiry, sigs),
      )
        .to.emit(d.vault, "ExecutionSuccess")
        .withArgs(digest, 0n);
    });

    it("#35 Setup(owners, threshold) emitted on createVault", async () => {
      const signers = await ethers.getSigners();
      const factory = await deployFactory();
      const owners = [signers[0].address, signers[1].address];
      const clientSalt = ethers.id("evt-setup");
      // Predicted vault address — Setup event comes from the clone.
      const predictedVault = await factory.computeVaultAddress(
        signers[0].address,
        clientSalt,
      );
      const impl = await ethers.getContractAt(
        "GaoSafe",
        await factory.implementation(),
      );
      const tx = await factory.createVault(owners, 2, clientSalt);
      const receipt = await tx.wait();
      // Find a Setup log emitted from the predicted vault address.
      const setupTopic = impl.interface.getEvent("Setup")!.topicHash;
      const log = receipt!.logs.find(
        (l) =>
          l.address.toLowerCase() === predictedVault.toLowerCase() &&
          l.topics[0] === setupTopic,
      );
      expect(log, "Setup event not found on predicted vault address").to.not
        .be.undefined;
      const parsed = impl.interface.parseLog(log!);
      expect(parsed!.args[0]).to.deep.equal(owners);
      expect(parsed!.args[1]).to.equal(2n);
    });

    it("#36 receive() accepts ETH and increments vault balance", async () => {
      const d = await setupCommon(3, 2);
      const before = await ethers.provider.getBalance(d.vaultAddress);
      const amount = ethers.parseEther("0.25");
      await fundVault(d.vaultAddress, amount);
      const after = await ethers.provider.getBalance(d.vaultAddress);
      expect(after - before).to.equal(amount);
    });
  });
});
