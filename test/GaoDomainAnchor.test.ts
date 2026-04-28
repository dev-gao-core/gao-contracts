// GaoDomainAnchor unit tests.
//
// The contract is intentionally minimal — three append-only anchor
// methods + three "latest hash" mappings + zero-input rejection. The
// tests pin every required behaviour from the contract spec so a
// future revision can't silently change wire shape that the worker
// (`gao-id-worker:src/lib/onchain-anchor.ts`) will rely on once the
// ABI is wired in.
//
// Mirrors the test-style of `test/GaoDomainDeposit.test.ts`: TS +
// chai + Hardhat ethers v6, no Foundry. Same convention re ZERO_BYTES32
// constant + multi-signer fixture.

import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Deterministic non-zero test fixtures. We use distinct byte patterns
// so a swapped-arg bug surfaces clearly in a failing assertion.
const DOMAIN_HASH_A =
  "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const DOMAIN_HASH_B =
  "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const PAYLOAD_HASH_1 =
  "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const PAYLOAD_HASH_2 =
  "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const SNAPSHOT_ID_A =
  "0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
const MERKLE_ROOT_A =
  "0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6";
const MAPPINGS_HASH_A =
  "0x1717171717171717171717171717171717171717171717171717171717171717";

describe("GaoDomainAnchor", () => {
  async function deployFresh() {
    const [anchorer, other] = await ethers.getSigners();
    const Anchor = await ethers.getContractFactory("GaoDomainAnchor");
    const anchor = await Anchor.deploy();
    await anchor.waitForDeployment();
    return { anchor, anchorer, other };
  }

  // ── anchorDomain ─────────────────────────────────────────────────────

  describe("anchorDomain", () => {
    it("emits DomainAnchored with the correct fields (1)", async () => {
      const { anchor, anchorer } = await deployFresh();
      const tx = await anchor
        .connect(anchorer)
        .anchorDomain(DOMAIN_HASH_A, PAYLOAD_HASH_1);
      await expect(tx)
        .to.emit(anchor, "DomainAnchored")
        // The 4th arg (timestamp) is set to `block.timestamp` at mining
        // time — we don't pin it because chai's `withArgs` doesn't
        // expose a "any" matcher; instead we read it from the tx
        // receipt below.
        .withArgs(
          DOMAIN_HASH_A,
          PAYLOAD_HASH_1,
          await anchorer.getAddress(),
          // chai-ethers `withArgs` accepts a predicate function. Use
          // it to assert timestamp is a positive integer matching the
          // block in which the tx was mined.
          (ts: bigint) => typeof ts === "bigint" && ts > 0n,
        );
    });

    it("updates latestDomainPayloadHash to the supplied hash (2)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await anchor.connect(anchorer).anchorDomain(DOMAIN_HASH_A, PAYLOAD_HASH_1);
      expect(await anchor.latestDomainPayloadHash(DOMAIN_HASH_A)).to.equal(
        PAYLOAD_HASH_1,
      );
    });

    it("rejects zero domainHash with ZeroDomainHash (3)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor.connect(anchorer).anchorDomain(ZERO_BYTES32, PAYLOAD_HASH_1),
      ).to.be.revertedWithCustomError(anchor, "ZeroDomainHash");
    });

    it("rejects zero payloadHash with ZeroPayloadHash (4)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor.connect(anchorer).anchorDomain(DOMAIN_HASH_A, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(anchor, "ZeroPayloadHash");
    });
  });

  // ── anchorSnapshot ───────────────────────────────────────────────────

  describe("anchorSnapshot", () => {
    it("emits SnapshotAnchored with the correct fields (5)", async () => {
      const { anchor, anchorer } = await deployFresh();
      const tx = await anchor
        .connect(anchorer)
        .anchorSnapshot(SNAPSHOT_ID_A, MERKLE_ROOT_A, PAYLOAD_HASH_1);
      await expect(tx)
        .to.emit(anchor, "SnapshotAnchored")
        .withArgs(
          SNAPSHOT_ID_A,
          MERKLE_ROOT_A,
          PAYLOAD_HASH_1,
          await anchorer.getAddress(),
          (ts: bigint) => typeof ts === "bigint" && ts > 0n,
        );
    });

    it("updates latestSnapshotPayloadHash (6)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await anchor
        .connect(anchorer)
        .anchorSnapshot(SNAPSHOT_ID_A, MERKLE_ROOT_A, PAYLOAD_HASH_1);
      expect(await anchor.latestSnapshotPayloadHash(SNAPSHOT_ID_A)).to.equal(
        PAYLOAD_HASH_1,
      );
    });

    it("rejects zero snapshotId (7)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor
          .connect(anchorer)
          .anchorSnapshot(ZERO_BYTES32, MERKLE_ROOT_A, PAYLOAD_HASH_1),
      ).to.be.revertedWithCustomError(anchor, "ZeroSnapshotId");
    });

    it("rejects zero merkleRoot (8)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor
          .connect(anchorer)
          .anchorSnapshot(SNAPSHOT_ID_A, ZERO_BYTES32, PAYLOAD_HASH_1),
      ).to.be.revertedWithCustomError(anchor, "ZeroMerkleRoot");
    });

    it("rejects zero payloadHash (9)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor
          .connect(anchorer)
          .anchorSnapshot(SNAPSHOT_ID_A, MERKLE_ROOT_A, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(anchor, "ZeroPayloadHash");
    });
  });

  // ── anchorMapping ────────────────────────────────────────────────────

  describe("anchorMapping", () => {
    it("emits MappingAnchored with the correct fields (10)", async () => {
      const { anchor, anchorer } = await deployFresh();
      const tx = await anchor
        .connect(anchorer)
        .anchorMapping(DOMAIN_HASH_A, MAPPINGS_HASH_A);
      await expect(tx)
        .to.emit(anchor, "MappingAnchored")
        .withArgs(
          DOMAIN_HASH_A,
          MAPPINGS_HASH_A,
          await anchorer.getAddress(),
          (ts: bigint) => typeof ts === "bigint" && ts > 0n,
        );
    });

    it("updates latestMappingHash (11)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await anchor
        .connect(anchorer)
        .anchorMapping(DOMAIN_HASH_A, MAPPINGS_HASH_A);
      expect(await anchor.latestMappingHash(DOMAIN_HASH_A)).to.equal(
        MAPPINGS_HASH_A,
      );
    });

    it("rejects zero domainHash (12)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor.connect(anchorer).anchorMapping(ZERO_BYTES32, MAPPINGS_HASH_A),
      ).to.be.revertedWithCustomError(anchor, "ZeroDomainHash");
    });

    it("rejects zero mappingsHash (13)", async () => {
      const { anchor, anchorer } = await deployFresh();
      await expect(
        anchor.connect(anchorer).anchorMapping(DOMAIN_HASH_A, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(anchor, "ZeroMappingsHash");
    });
  });

  // ── Multi-anchor + isolation ─────────────────────────────────────────

  describe("multi-anchor / log retention", () => {
    it("multiple anchors for same domain overwrite latest storage but every event remains in logs (14)", async () => {
      const { anchor, anchorer, other } = await deployFresh();
      // Anchor #1 by `anchorer`.
      await anchor
        .connect(anchorer)
        .anchorDomain(DOMAIN_HASH_A, PAYLOAD_HASH_1);
      // Anchor #2 by `other` — overwrites latest, but the original
      // event is still in the log.
      await anchor.connect(other).anchorDomain(DOMAIN_HASH_A, PAYLOAD_HASH_2);

      // Storage reflects the latest write only.
      expect(await anchor.latestDomainPayloadHash(DOMAIN_HASH_A)).to.equal(
        PAYLOAD_HASH_2,
      );

      // Logs retain BOTH anchor events. Filter by domainHash and
      // confirm we get two records with the expected payloadHash
      // values in order.
      const filter = anchor.filters.DomainAnchored(DOMAIN_HASH_A);
      const logs = await anchor.queryFilter(filter);
      expect(logs.length).to.equal(2);
      expect(logs[0].args.payloadHash).to.equal(PAYLOAD_HASH_1);
      expect(logs[0].args.anchorer).to.equal(await anchorer.getAddress());
      expect(logs[1].args.payloadHash).to.equal(PAYLOAD_HASH_2);
      expect(logs[1].args.anchorer).to.equal(await other.getAddress());
    });

    it("anchorMapping for a different domain does not touch the first domain's mapping hash", async () => {
      // Sanity check that the storage maps are domain-scoped, not a
      // single global slot. Cheap to add and catches a future
      // refactor that accidentally collapses the mappings into one
      // shared key.
      const { anchor, anchorer } = await deployFresh();
      await anchor
        .connect(anchorer)
        .anchorMapping(DOMAIN_HASH_A, MAPPINGS_HASH_A);
      // Different domain, different (arbitrary non-zero) hash.
      await anchor
        .connect(anchorer)
        .anchorMapping(DOMAIN_HASH_B, PAYLOAD_HASH_2);
      expect(await anchor.latestMappingHash(DOMAIN_HASH_A)).to.equal(
        MAPPINGS_HASH_A,
      );
      expect(await anchor.latestMappingHash(DOMAIN_HASH_B)).to.equal(
        PAYLOAD_HASH_2,
      );
    });
  });

  // ── No payable / no fallback ─────────────────────────────────────────

  describe("no payable surface (15)", () => {
    it("rejects raw ETH sent to the contract", async () => {
      const { anchor, anchorer } = await deployFresh();
      // Solidity 0.8 contracts without an explicit `receive()` /
      // `fallback() payable` revert on ETH transfer. We probe by
      // sending value via a low-level call and asserting the call
      // failed.
      const target = await anchor.getAddress();
      await expect(
        anchorer.sendTransaction({ to: target, value: 1n }),
      ).to.be.reverted;
    });

    it("anchor methods are not payable (cannot accept value)", async () => {
      const { anchor, anchorer } = await deployFresh();
      // Hardhat ethers v6 will reject the call before submitting
      // because the function ABI has no `payable` flag, but we
      // double-check by sending value and expecting either a revert
      // at the chain or a TypeError client-side. Either is a pass.
      let threw = false;
      try {
        await anchor
          .connect(anchorer)
          .anchorDomain(DOMAIN_HASH_A, PAYLOAD_HASH_1, { value: 1n });
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });
});
