// One-off cleanup: refund every DEPOSITED invoice from the deprecated
// GaoDomainDeposit deployment on Base Sepolia.
//
// Why this exists. The escrow at 0xcFC746DF306Fa0C4512CA98f83aC7B6B143c2a13
// is the commit-42b6c2e revision; it has `deposit / settle / refund` but
// NO `withdrawTreasury` / `setTreasury` / `lockedLiability` /
// `withdrawableBalance` selectors. Calling `settle()` on it is a one-way
// trap: status flips to SETTLED but no funds move, and `refund` then
// reverts (`InvoiceNotInDepositedState`). The 9 audited deposits are
// still in DEPOSITED state, so refund() is the only on-chain exit that
// doesn't permanently lock the funds in the contract.
//
// What this script does:
//   1. Re-validates each invoice on-chain (status, payer, amount, token)
//      against the audit table baked in below.
//   2. Prints a dry-run plan including the eligible-refund list and
//      total amount.
//   3. Aborts if any DEPOSITED invoice's on-chain values disagree with
//      the audit table — we will not refund into an unverified address.
//   4. Only broadcasts refund() txs when CONFIRM_REFUND_OLD_ESCROW=true.
//   5. After each refund, awaits the receipt, re-reads getDeposit, and
//      asserts the on-chain status is now REFUNDED (3) before moving on.
//   6. Prints the contract's USDC balance before + after.
//
// What this script does NOT do:
//   - Never calls settle(). Never. Not even with a flag. Calling settle()
//     on this revision permanently locks the funds and there is no
//     subsequent path to recover them.
//   - Never sweeps stray balance (~19.9 USDC at audit time). The
//     deployment has no rescue selector.
//
// Usage:
//   # dry run
//   npx hardhat run scripts/refund-old-escrow.ts --network baseSepolia
//
//   # broadcast
//   CONFIRM_REFUND_OLD_ESCROW=true \
//     npx hardhat run scripts/refund-old-escrow.ts --network baseSepolia
//
// Required env (loaded from contracts/.env, which is gitignored):
//   DEPLOYER_PRIVATE_KEY  — must be the current contract owner
//                           (0x64cc9f9107951f557709c3c0d3d3c92678461d55).
//   BASE_SEPOLIA_RPC_URL  — private RPC endpoint.
//
// Idempotent. Safe to re-run after partial failure: invoices already in
// REFUNDED state are skipped, the script reverts only on unexpected
// state transitions (e.g. a third party flipped one to SETTLED in
// between runs — at which point there's nothing left to do for that row).

import { ethers, network } from "hardhat";

const OLD_ESCROW = "0xcFC746DF306Fa0C4512CA98f83aC7B6B143c2a13";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EXPECTED_CHAIN_ID = 84532; // Base Sepolia
const EXPECTED_OWNER = "0x64cc9f9107951f557709c3c0d3d3c92678461d55";

// Audit baseline taken from gao-id-worker on 2026-04-29. Each row was
// cross-checked against:
//   - getDeposit(invoiceId) on the deployed contract
//   - payment_intents row in the gao-id-dev D1 (status SETTLED,
//     identity_domains link verified, identity_billing_index PAID)
//
// Order is chronological by deposit blockNumber. Domain is
// informational; the on-chain check uses invoiceId / payer / amount only.
interface InvoiceTarget {
  domain: string;
  invoiceId: string;
  payer: string;
  amount: bigint; // USDC base units (6 decimals)
}

const TARGETS: readonly InvoiceTarget[] = [
  {
    domain: "kinggao.gao",
    invoiceId: "0x882fab4575d3fa423035147c8c4108637fc068d671b8f756f9cb0631ae1574cb",
    payer: "0x36cc88093d47334327a5cae3a1e65f1c326fbfb1",
    amount: 199_000_000n,
  },
  {
    domain: "luongntapp.gao",
    invoiceId: "0x3da99b3037cb33233037473468fef961fe419de0a2be76d04e27d3d8a81078e6",
    payer: "0x49f794c03a1528c585e1617c1a546ec9ae82a125",
    amount: 199_000_000n,
  },
  {
    domain: "ntluongapp.gao",
    invoiceId: "0x5b14c5f4c048d1efeefdc1402f0ad4b2f2c47b9f1a4394df36d0a4ee3c54d62e",
    payer: "0x49f794c03a1528c585e1617c1a546ec9ae82a125",
    amount: 199_000_000n,
  },
  {
    domain: "queengao.gao",
    invoiceId: "0xee1ae149198b6d6d7731cb6e716e1e385c79d0682e9e59cd676c09eef5db4e8c",
    payer: "0x64cc9f9107951f557709c3c0d3d3c92678461d55",
    amount: 199_000_000n,
  },
  {
    domain: "11111111.gao",
    invoiceId: "0x913403a809b1279b1a8ba27d6fceeb116296462045cdd07e867d8da5b03cc394",
    payer: "0xc072c0e4f790c00f75e26be6053b4d23ffc040d1",
    amount: 179_100_000n,
  },
  {
    domain: "22222222.gao",
    invoiceId: "0x9f290787c3973b89255014520ca99ceed3d30072793ace5d49572b26fb18a40a",
    payer: "0x64cc9f9107951f557709c3c0d3d3c92678461d55",
    amount: 179_100_000n,
  },
  {
    domain: "33333333.gao",
    invoiceId: "0x98ba5c9101a1a247e93031d3b24eb4933b415437c7cb6ee48aba8384c7892c1f",
    payer: "0xc072c0e4f790c00f75e26be6053b4d23ffc040d1",
    amount: 179_100_000n,
  },
  {
    domain: "44444444.gao",
    invoiceId: "0x80ffac08c8a1c33ec13d0e0a165dbdd9deff6de18b220556c0e40ab5578fc515",
    payer: "0xc072c0e4f790c00f75e26be6053b4d23ffc040d1",
    amount: 199_000_000n,
  },
  {
    domain: "66666666.gao",
    invoiceId: "0xf0961522e2276e577514fe15c33ac8a035af743e38173ef1e9504063ca76553b",
    payer: "0x64cc9f9107951f557709c3c0d3d3c92678461d55",
    amount: 179_100_000n,
  },
];

// Minimal ABI — only the selectors we read or call. We deliberately do
// NOT include `settle` so a typo or a future edit cannot accidentally
// invoke it.
const ESCROW_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function refund(bytes32 invoiceId) external",
  "function getDeposit(bytes32 invoiceId) view returns (address buyer, uint8 status, uint64 depositedAt, bool isReserved, address paymentToken, uint256 amount, bytes32 domainHash, bytes32 commitmentLeaf, address payer)",
];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

const Status = { NONE: 0, DEPOSITED: 1, SETTLED: 2, REFUNDED: 3 } as const;
const STATUS_NAME = ["NONE", "DEPOSITED", "SETTLED", "REFUNDED"];

function fmtUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

function lowerEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface Plan {
  target: InvoiceTarget;
  status: number;
  refund: boolean;
  reason: string;
}

async function main(): Promise<void> {
  if (network.config.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong network. Expected chainId ${EXPECTED_CHAIN_ID} (Base Sepolia), ` +
        `got ${network.config.chainId}. ` +
        `Run with: npx hardhat run scripts/refund-old-escrow.ts --network baseSepolia`,
    );
  }
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer available — set DEPLOYER_PRIVATE_KEY in contracts/.env");
  }
  const signerAddr = await signer.getAddress();

  const escrow = new ethers.Contract(OLD_ESCROW, ESCROW_ABI, signer);
  const usdc = new ethers.Contract(USDC, USDC_ABI, signer);

  console.log("─".repeat(72));
  console.log("Refund cleanup — DEPRECATED escrow (commit 42b6c2e revision)");
  console.log(`Network:   ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Escrow:    ${OLD_ESCROW}`);
  console.log(`USDC:      ${USDC}`);
  console.log(`Signer:    ${signerAddr}`);
  console.log("─".repeat(72));

  // 0. Identity + ownership gate.
  const owner: string = await escrow.owner();
  console.log(`Owner:     ${owner}`);
  if (!lowerEq(owner, EXPECTED_OWNER)) {
    throw new Error(
      `Owner mismatch: expected ${EXPECTED_OWNER}, got ${owner}. ` +
        `The deployed contract owner has changed since audit; abort.`,
    );
  }
  if (!lowerEq(owner, signerAddr)) {
    throw new Error(
      `Signer ${signerAddr} is not the contract owner ${owner}. ` +
        `Run this from the owning EOA / multisig instead.`,
    );
  }
  // Refund() does not have whenNotPaused, but surface paused state for the operator.
  const paused: boolean = await escrow.paused();
  console.log(`Paused:    ${paused} (refund() works regardless)`);

  // 1. Per-invoice on-chain validation. No tx is sent yet.
  console.log("");
  console.log("Validating each invoice against on-chain getDeposit()…");
  const plan: Plan[] = [];
  for (const t of TARGETS) {
    const res = await escrow.getDeposit(t.invoiceId);
    // ethers v6 returns a Result; index access works for both named and
    // positional destructuring.
    const status = Number(res[1]);
    const onToken: string = String(res[4]);
    const onAmount: bigint = BigInt(res[5]);
    const onPayer: string = String(res[8]);

    let refund = false;
    let reason: string;
    if (status === Status.REFUNDED) {
      reason = "already REFUNDED — skip";
    } else if (status === Status.SETTLED) {
      reason = "already SETTLED on-chain — refund impossible (will NOT settle)";
    } else if (status === Status.NONE) {
      reason = "status NONE — invoice does not exist on-chain (audit drift?)";
    } else if (status !== Status.DEPOSITED) {
      reason = `unexpected status ${status}`;
    } else if (!lowerEq(onToken, USDC)) {
      reason = `token mismatch: on-chain ${onToken}, expected USDC ${USDC}`;
    } else if (!lowerEq(onPayer, t.payer)) {
      reason = `payer mismatch: on-chain ${onPayer}, expected ${t.payer}`;
    } else if (onAmount !== t.amount) {
      reason = `amount mismatch: on-chain ${onAmount}, expected ${t.amount}`;
    } else {
      refund = true;
      reason = `OK — refund ${fmtUsdc(t.amount)} USDC to ${t.payer}`;
    }
    plan.push({ target: t, status, refund, reason });
  }

  // 2. Print plan.
  console.log("");
  console.log("Refund plan (in order):");
  for (const p of plan) {
    const tag = STATUS_NAME[p.status] ?? `?${p.status}`;
    const action = p.refund ? "REFUND" : "skip  ";
    console.log(
      `  ${p.target.domain.padEnd(18)} ${p.target.invoiceId.slice(0, 18)}…  ` +
        `status=${tag.padEnd(10)} amount=${fmtUsdc(p.target.amount).padStart(10)} USDC  ` +
        `→ ${action} (${p.reason})`,
    );
  }

  // 3. Halt on any unverified DEPOSITED row.
  const unverified = plan.filter(
    (p) => !p.refund && p.status === Status.DEPOSITED,
  );
  if (unverified.length > 0) {
    console.error("");
    console.error(
      "ABORT: one or more DEPOSITED invoices have on-chain values that do not match the audit table.",
    );
    for (const u of unverified) {
      console.error(`  ${u.target.domain}: ${u.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  // 4. Halt on any unexpected SETTLED row — that's an irreversible loss
  // and the operator should know about it before we touch anything else.
  const lockedSettled = plan.filter((p) => p.status === Status.SETTLED);
  if (lockedSettled.length > 0) {
    console.error("");
    console.error(
      "WARNING: one or more invoices are already SETTLED on-chain. Funds are locked in the deprecated escrow.",
    );
    for (const s of lockedSettled) console.error(`  ${s.target.domain}: ${s.reason}`);
    console.error(
      "Refund is not possible for these. Continuing to refund the remaining DEPOSITED rows; " +
        "review the SETTLED rows separately.",
    );
  }

  // 5. Dry-run summary.
  const eligible = plan.filter((p) => p.refund);
  const totalRefund = eligible.reduce((acc, p) => acc + p.target.amount, 0n);
  const balBefore: bigint = await usdc.balanceOf(OLD_ESCROW);
  console.log("");
  console.log(`Eligible to refund:     ${eligible.length} invoice(s)`);
  console.log(`Total refund amount:    ${fmtUsdc(totalRefund)} USDC`);
  console.log(`Escrow USDC balance:    ${fmtUsdc(balBefore)} USDC (before)`);
  console.log("");

  if (process.env.CONFIRM_REFUND_OLD_ESCROW !== "true") {
    console.log("DRY-RUN. No transactions sent.");
    console.log("To broadcast, re-run with: CONFIRM_REFUND_OLD_ESCROW=true");
    console.log("PASS (dry-run)");
    return;
  }

  if (eligible.length === 0) {
    console.log("Nothing to refund (all rows already in terminal state).");
    console.log("PASS");
    return;
  }

  // 6. Broadcast. One refund() per row, await receipt, sanity-read,
  //    then move on. Sequential (not parallel) so a partial failure
  //    leaves a clean, re-runnable state.
  console.log("CONFIRM_REFUND_OLD_ESCROW=true — broadcasting refunds.");
  const receipts: { domain: string; invoiceId: string; txHash: string; block: number }[] = [];
  for (const p of eligible) {
    console.log("");
    console.log(`Refunding ${p.target.domain}  (${p.target.invoiceId})`);
    const tx = await escrow.refund(p.target.invoiceId);
    console.log(`  tx hash:  ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`No receipt for ${p.target.domain}`);
    if (receipt.status !== 1) {
      throw new Error(`refund() reverted for ${p.target.domain} (tx ${tx.hash})`);
    }
    console.log(`  block:    ${receipt.blockNumber}`);
    console.log(`  gas used: ${receipt.gasUsed.toString()}`);

    // The public Base Sepolia RPC load-balances reads across nodes that
    // can lag the write node by a block. `tx.wait()` resolves as soon as
    // ONE node sees the receipt; the next eth_call may hit a different
    // node still on `latest - 1`. Retry a few times before declaring the
    // post-tx read inconsistent.
    let afterStatus = -1;
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await escrow.getDeposit(p.target.invoiceId);
      afterStatus = Number(after[1]);
      if (afterStatus === Status.REFUNDED) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (afterStatus !== Status.REFUNDED) {
      throw new Error(
        `Post-refund status for ${p.target.domain} is ${STATUS_NAME[afterStatus] ?? afterStatus}, expected REFUNDED (3) after retries.`,
      );
    }
    console.log(`  status:   REFUNDED (3) ✓`);
    receipts.push({
      domain: p.target.domain,
      invoiceId: p.target.invoiceId,
      txHash: tx.hash,
      block: receipt.blockNumber,
    });
  }

  // 7. Final balance + summary.
  const balAfter: bigint = await usdc.balanceOf(OLD_ESCROW);
  console.log("");
  console.log("─".repeat(72));
  console.log(`Refunds sent:           ${receipts.length}`);
  console.log(`Total refunded:         ${fmtUsdc(totalRefund)} USDC`);
  console.log(`Escrow balance before:  ${fmtUsdc(balBefore)} USDC`);
  console.log(`Escrow balance after:   ${fmtUsdc(balAfter)} USDC`);
  console.log(`Δ contract balance:     -${fmtUsdc(balBefore - balAfter)} USDC`);
  console.log("");
  console.log("Per-tx receipts:");
  for (const r of receipts) {
    console.log(`  ${r.domain.padEnd(18)} block=${r.block}  tx=${r.txHash}`);
  }
  console.log("");
  if (balAfter > 0n) {
    console.log(
      `Note: ${fmtUsdc(balAfter)} USDC remains in the contract. This is stray ` +
        "balance from transfers not bound to any Deposited event. The deployed " +
        "revision has no rescue/sweep selector; this balance is unrecoverable.",
    );
  }
  console.log("PASS");
}

main().catch((e) => {
  // Never log the signer's private key. Hardhat's ethers wrapper does not
  // include it in error objects, but stay defensive: print only the message.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
});
