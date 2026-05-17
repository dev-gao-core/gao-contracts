// PR 7 — GaoSafe property tests (deterministic seeded fuzz).
//
// This file pins invariants I1–I7 + I10 from
// `docs/multisig/gao-safe-invariants.md` against the GaoSafe Genesis
// contract at the audited commit `ac14411`. Every iteration is
// deterministic: the master seed `0x6A0FED1357` is XOR'd (via keccak256
// folding) with a per-property tag to derive a stable uint32 seed,
// which feeds a `mulberry32` PRNG. Failures emit the seed, the
// iteration index, and the derived inputs so any failure is
// reproducible without re-running the suite.
//
// 50 iterations per property by default (locked PR 7 plan). The
// 30-iteration fallback documented in the plan is NOT in use; if a
// future implementation pass discovers a property exceeds the local
// runtime budget, the file header gains a per-property rationale and
// the constant is reduced — see the PR 7 plan for the rationale text.
//
// THIS FILE ADDS NO NEW DEPENDENCY. It uses only the existing
// Hardhat + ethers v6 + chai + Mocha stack already pinned by
// package.json. No Foundry. No Slither (Slither runs in its own
// advisory CI workflow).

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  bundleSignatures,
  buildSignTypedDataInputs,
  sortSignersAscending,
} from "./helpers/eip712";

// ── PR 7 master seed and PRNG (locked plan) ─────────────────────────────

/** Master seed locked by the PR 7 plan. 40-bit hex constant. */
const MASTER_SEED = "0x6A0FED1357" as const;

/** Locked iteration count per property. */
const ITERATIONS = 50;

/**
 * Derive a stable uint32 seed from the master seed and a property tag.
 * Uses keccak256 folding (low 32 bits) so the same `(master, tag)`
 * pair always produces the same seed across CI runs and machines.
 */
function seedForProperty(propertyTag: string): number {
  const h = ethers.keccak256(
    ethers.toUtf8Bytes(`${MASTER_SEED}:${propertyTag}`),
  );
  return Number(BigInt(h) & 0xffffffffn);
}

/**
 * mulberry32 — small, deterministic, well-distributed uint32 PRNG.
 * Returns a function that emits a float in [0, 1) per call.
 * Reference: https://en.wikipedia.org/wiki/Linear_congruential_generator
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] inclusive. */
function randIntInclusive(rand: () => number, lo: number, hi: number): number {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

/** Random bigint in [1n, hiInclusive]. */
function randBigInt(rand: () => number, hiInclusive: bigint): bigint {
  // Combine two PRNG draws so the bigint range can exceed 2^32-1.
  const hi = Number(hiInclusive);
  if (Number.isFinite(hi) && hi <= 2 ** 30) {
    return BigInt(randIntInclusive(rand, 1, hi));
  }
  const high = BigInt(Math.floor(rand() * 0x10000));
  const low = BigInt(Math.floor(rand() * 0x10000));
  const v = (high << 16n) ^ low;
  return (v % hiInclusive) + 1n;
}

const HOUR = 3600n;

// ── shared deployment helpers ───────────────────────────────────────────

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
  const F = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await F.deploy();
  await factory.waitForDeployment();
  return factory;
}

async function deployVault(
  factory: Awaited<ReturnType<typeof deployFactory>>,
  owners: readonly string[],
  threshold: number,
  clientSalt: string,
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
  clientSaltSuffix = "shared",
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
    ethers.id(`pr7-invariants-${clientSaltSuffix}`),
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

// ── tests ──────────────────────────────────────────────────────────────

describe("PR 7 — GaoSafe property tests (deterministic seeded fuzz)", () => {
  // ── I1 ────────────────────────────────────────────────────────────────
  describe("I1 — nonce monotonicity", () => {
    it(`nonce increments exactly once per successful execTransaction across ${ITERATIONS} randomised proposals`, async () => {
      const seed = seedForProperty("I1-nonce-monotonicity");
      const rand = mulberry32(seed);

      const d = await setupCommon(3, 2, "I1");
      await fundVault(d.vaultAddress, ethers.parseEther("10"));

      // Initial state.
      expect(await d.vault.nonce()).to.equal(0n);

      for (let i = 0; i < ITERATIONS; i++) {
        const expectedNonce = BigInt(i);
        const recipient = d.outsider.address;
        const amount = randBigInt(rand, 10_000_000_000_000n); // up to ~10 µETH
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;
        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce: expectedNonce,
          targets: [recipient],
          values: [amount],
          data: ["0x"],
          expiry,
        });
        const sigs = await bundleSignatures(
          sortSignersAscending(d.ownerSigners.slice(0, 2)),
          inputs,
        );

        await d.vault.execTransaction(
          [recipient],
          [amount],
          ["0x"],
          expiry,
          sigs,
        );

        const newNonce = await d.vault.nonce();
        expect(newNonce, `seed=${seed}, iter=${i}, master=${MASTER_SEED}`).to.equal(
          expectedNonce + 1n,
        );
      }
      // Final nonce equals ITERATIONS exactly — strict monotonicity.
      expect(await d.vault.nonce()).to.equal(BigInt(ITERATIONS));
    });
  });

  // ── I2 ────────────────────────────────────────────────────────────────
  describe("I2 — threshold ≤ owners.length after every mutation", () => {
    it(`invariant holds across ${ITERATIONS} randomised changeThreshold proposals`, async () => {
      const seed = seedForProperty("I2-threshold-le-owners");
      const rand = mulberry32(seed);

      const ownerCount = 4;
      const d = await setupCommon(ownerCount, 2, "I2");
      let currentNonce = 0n;

      for (let i = 0; i < ITERATIONS; i++) {
        // Pick a new threshold in [1, ownerCount].
        const newThreshold = randIntInclusive(rand, 1, ownerCount);

        // Encode the changeThreshold(uint256) self-call.
        const safeIface = d.vault.interface;
        const callData = safeIface.encodeFunctionData("changeThreshold", [
          newThreshold,
        ]) as string;
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;

        // Use the CURRENT vault threshold to size the signature bundle —
        // the proposal mutates threshold AFTER the bundle is verified.
        const currentThreshold = Number(await d.vault.threshold());

        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce: currentNonce,
          targets: [d.vaultAddress],
          values: [0n],
          data: [callData],
          expiry,
        });
        const sigs = await bundleSignatures(
          sortSignersAscending(d.ownerSigners.slice(0, currentThreshold)),
          inputs,
        );

        await d.vault.execTransaction(
          [d.vaultAddress],
          [0n],
          [callData],
          expiry,
          sigs,
        );
        currentNonce += 1n;

        // Invariant: threshold ≤ owners.length always.
        const obsThreshold = await d.vault.threshold();
        const obsCount = await d.vault.ownersCount();
        expect(
          obsThreshold,
          `seed=${seed}, iter=${i}, master=${MASTER_SEED}, newThreshold=${newThreshold}`,
        ).to.be.lte(obsCount);
        // And: threshold ≥ 1 (changeThreshold(0) reverts; the contract
        // refuses the mutation so the prior valid value persists).
        expect(obsThreshold).to.be.gte(1n);
        // And: the mutation actually applied (the proposal succeeded).
        expect(obsThreshold).to.equal(BigInt(newThreshold));
      }
    });
  });

  // ── I3 ────────────────────────────────────────────────────────────────
  describe("I3 — threshold ≥ 1 after setup", () => {
    it(`every valid setup over ${ITERATIONS} randomised configs produces threshold ≥ 1`, async () => {
      const seed = seedForProperty("I3-threshold-positive-after-setup");
      const rand = mulberry32(seed);

      const factory = await deployFactory();
      const signers = await ethers.getSigners();

      for (let i = 0; i < ITERATIONS; i++) {
        // Pick a valid owner-count in [1, 6] and a valid threshold in [1, ownerCount].
        const ownerCount = randIntInclusive(rand, 1, 6);
        const threshold = randIntInclusive(rand, 1, ownerCount);

        // Sample owner addresses from a stable pool (first 6 hardhat signers).
        // For ownerCount=k, take the first k signers' addresses — deterministic
        // and never produces duplicates.
        const owners = signers.slice(0, ownerCount).map((s) => s.address);
        const tx = await factory.createVault(
          owners,
          threshold,
          ethers.id(`pr7-I3-${seed}-${i}`),
        );
        const receipt = await tx.wait();
        let vaultAddress: string | null = null;
        for (const log of receipt!.logs) {
          try {
            const p = factory.interface.parseLog(log);
            if (p && p.name === "VaultCreated") {
              vaultAddress = p.args[0] as string;
            }
          } catch {
            /* skip */
          }
        }
        expect(vaultAddress).to.not.be.null;
        const vault = await ethers.getContractAt("GaoSafe", vaultAddress!);
        const obsThreshold = await vault.threshold();
        const obsCount = await vault.ownersCount();
        expect(
          obsThreshold,
          `seed=${seed}, iter=${i}, ownerCount=${ownerCount}, threshold=${threshold}`,
        ).to.be.gte(1n);
        expect(obsThreshold).to.be.lte(obsCount);
        expect(obsThreshold).to.equal(BigInt(threshold));
        expect(obsCount).to.equal(BigInt(ownerCount));
      }
    });
  });

  // ── I4 ────────────────────────────────────────────────────────────────
  describe("I4 — only self-call can mutate owner set", () => {
    it(`external-caller mutator calls revert NotSelfCall across ${ITERATIONS} randomised selector + caller combos`, async () => {
      const seed = seedForProperty("I4-only-self-call-mutates");
      const rand = mulberry32(seed);

      const d = await setupCommon(3, 2, "I4");
      const signers = await ethers.getSigners();

      type MutatorTag =
        | "addOwner"
        | "removeOwner"
        | "replaceOwner"
        | "changeThreshold";
      const mutators: MutatorTag[] = [
        "addOwner",
        "removeOwner",
        "replaceOwner",
        "changeThreshold",
      ];

      for (let i = 0; i < ITERATIONS; i++) {
        const mutator = mutators[randIntInclusive(rand, 0, mutators.length - 1)];
        // Pick an external caller — never the vault itself.
        const callerIdx = randIntInclusive(rand, 0, signers.length - 1);
        const caller = signers[callerIdx];

        const target = signers[randIntInclusive(rand, 0, 9)].address;
        const newOwner = signers[randIntInclusive(rand, 0, 9)].address;
        const newThreshold = randIntInclusive(rand, 1, 5);

        let pending: Promise<unknown>;
        switch (mutator) {
          case "addOwner":
            pending = d.vault
              .connect(caller)
              .addOwner(newOwner, newThreshold);
            break;
          case "removeOwner":
            pending = d.vault
              .connect(caller)
              .removeOwner(target, newThreshold);
            break;
          case "replaceOwner":
            pending = d.vault.connect(caller).replaceOwner(target, newOwner);
            break;
          case "changeThreshold":
            pending = d.vault.connect(caller).changeThreshold(newThreshold);
            break;
        }
        await expect(
          pending,
          `seed=${seed}, iter=${i}, mutator=${mutator}, caller=${caller.address}`,
        ).to.be.revertedWithCustomError(d.vault, "NotSelfCall");
      }
    });
  });

  // ── I5 ────────────────────────────────────────────────────────────────
  describe("I5 — uninitialised execution remains blocked", () => {
    it(`bare implementation rejects every randomised execTransaction across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I5-uninit-execution-blocked");
      const rand = mulberry32(seed);

      const factory = await deployFactory();
      const implAddr = await factory.implementation();
      const impl = await ethers.getContractAt("GaoSafe", implAddr);
      const signers = await ethers.getSigners();

      for (let i = 0; i < ITERATIONS; i++) {
        // Randomised but well-formed call shape; the contract reverts on
        // the NotSetup guard before any sub-call dispatch is reached.
        const subCallCount = randIntInclusive(rand, 1, 3);
        const targets: string[] = [];
        const values: bigint[] = [];
        const data: string[] = [];
        for (let j = 0; j < subCallCount; j++) {
          targets.push(signers[randIntInclusive(rand, 0, 9)].address);
          values.push(randBigInt(rand, 1_000_000_000_000n));
          data.push("0x");
        }
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;

        // The signature bundle is empty `0x` — the contract refuses
        // before even checking bundle size because `threshold == 0` on
        // the bare implementation. This is exactly the NotSetup hole
        // that test #37 pins; PR 7 fuzzes the input space around it.
        await expect(
          impl.execTransaction(targets, values, data, expiry, "0x"),
          `seed=${seed}, iter=${i}, subCallCount=${subCallCount}`,
        ).to.be.revertedWithCustomError(impl, "NotSetup");
      }
    });
  });

  // ── I6 ────────────────────────────────────────────────────────────────
  describe("I6 — implementation singleton refuses ETH", () => {
    it(`every randomised ETH transfer to the bare implementation reverts across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I6-impl-refuses-eth");
      const rand = mulberry32(seed);

      const factory = await deployFactory();
      const implAddr = await factory.implementation();
      const impl = await ethers.getContractAt("GaoSafe", implAddr);
      const [s0] = await ethers.getSigners();

      const beforeBalance = await ethers.provider.getBalance(implAddr);

      for (let i = 0; i < ITERATIONS; i++) {
        // Randomised non-zero value in [1, 1 ETH].
        const value = randBigInt(rand, ethers.parseEther("1"));
        await expect(
          s0.sendTransaction({ to: implAddr, value }),
          `seed=${seed}, iter=${i}, value=${value}`,
        ).to.be.revertedWithCustomError(impl, "ImplementationCannotReceiveEth");
      }

      // Implementation balance must remain unchanged across all attempts.
      expect(await ethers.provider.getBalance(implAddr)).to.equal(beforeBalance);
    });
  });

  // ── I7 ────────────────────────────────────────────────────────────────
  describe("I7 — clone receive() ETH succeeds", () => {
    it(`every randomised ETH transfer to a setup-initialised clone succeeds across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I7-clone-receives-eth");
      const rand = mulberry32(seed);

      const d = await setupCommon(2, 2, "I7");
      const [s0] = await ethers.getSigners();

      let cumulative = await ethers.provider.getBalance(d.vaultAddress);

      for (let i = 0; i < ITERATIONS; i++) {
        const value = randBigInt(rand, ethers.parseEther("1"));
        await s0.sendTransaction({ to: d.vaultAddress, value });
        const after = await ethers.provider.getBalance(d.vaultAddress);
        expect(
          after - cumulative,
          `seed=${seed}, iter=${i}, value=${value}`,
        ).to.equal(value);
        cumulative = after;
      }
    });
  });

  // ── I10 ───────────────────────────────────────────────────────────────
  describe("I10 — wrong-chain / wrong-vault digest rejected", () => {
    it(`every randomised wrong-chain or wrong-vault digest substitution reverts across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I10-wrong-chain-or-vault-digest");
      const rand = mulberry32(seed);

      const d = await setupCommon(3, 2, "I10");
      await fundVault(d.vaultAddress, ethers.parseEther("5"));
      const signers = await ethers.getSigners();

      for (let i = 0; i < ITERATIONS; i++) {
        // Build a well-formed proposal targeting the live vault.
        const recipient = d.outsider.address;
        const amount = randBigInt(rand, ethers.parseEther("0.01"));
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;

        // Substitute either chainId or vault in the EIP-712 domain
        // before signing. The signature bundle's recovered signers
        // will fail the on-chain `isOwner` check (because the
        // contract recomputes the digest using ITS chainId and
        // address(this), and that digest recovers a different
        // address from the supplied bundle). Expected revert:
        // NotAnOwner (or SignaturesNotSorted if recovered address
        // happens to be less than the running prev) — both are
        // valid rejections that prove cross-chain / cross-vault
        // replay is blocked.
        const subBranch = randIntInclusive(rand, 0, 1);
        const badChainId: bigint =
          subBranch === 0
            ? d.chainId + 1n + BigInt(randIntInclusive(rand, 0, 9999))
            : d.chainId;
        // Bad vault is the implementation address (a real, deployed
        // contract on this chain that is NOT the live vault).
        const implAddr = await d.factory.implementation();
        const badVault: string =
          subBranch === 1 ? implAddr : d.vaultAddress;

        const inputs = buildSignTypedDataInputs({
          chainId: badChainId,
          vault: badVault,
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
          d.vault.execTransaction(
            [recipient],
            [amount],
            ["0x"],
            expiry,
            sigs,
          ),
          `seed=${seed}, iter=${i}, branch=${
            subBranch === 0 ? "wrong-chain" : "wrong-vault"
          }`,
        ).to.be.reverted; // either NotAnOwner or SignaturesNotSorted; both are valid rejections.
        // No state change.
        expect(await d.vault.nonce()).to.equal(0n);
        // Suppress unused-variable warning when signers is not used downstream
        void signers;
      }
    });
  });
});
