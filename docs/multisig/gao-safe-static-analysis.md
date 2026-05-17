# GaoSafe Genesis — Static Analysis (Slither)

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document records the static-analysis posture for the GaoSafe Genesis multisig contracts. It is the operator-facing reference for the advisory Slither workflow added in PR 7 and the receiving end of any future escalation to a required gate.

## 1. Scope

| Surface | Status |
|---|---|
| `contracts/multisig/GaoSafe.sol` | In scope. |
| `contracts/multisig/GaoSafeFactory.sol` | In scope. |
| `node_modules/@openzeppelin/**` (vendored deps) | Out of scope — `exclude_dependencies: true` in `slither.config.json`. OZ is reviewed independently. |
| `contracts/test/**` (Solidity-only mocks; `MockERC20`) | Out of scope — `filter_paths` excludes `contracts/test/`. |
| Non-multisig `contracts/**` (`GaoDomain*`, etc.) | Out of scope — `filter_paths` excludes everything outside `contracts/multisig/`. |

## 2. Workflow

The advisory CI workflow lives at `.github/workflows/contracts-slither.yml`.

| Property | Value |
|---|---|
| Filename | `.github/workflows/contracts-slither.yml` |
| Job name | `slither (advisory)` |
| Triggers | `pull_request` to `main`, `push` to `main`, `workflow_dispatch` |
| Permissions | `contents: read` only — no `checks: write`, no `pull-request: write` |
| Slither install | `pip install --user "slither-analyzer==0.10.4"` (version pinned) |
| Slither invocation | `slither . --config-file slither.config.json --json "$RUNNER_TEMP/slither-report.json"` |
| Output location | `$RUNNER_TEMP/slither-report.json` — **never** the repo working tree |
| Artifact upload | `actions/upload-artifact@v4`, name `slither-report`, retention 90 days |
| Continue-on-error | Yes — on Slither install, run, AND upload steps |

Concurrency: `contracts-slither-${{ github.ref }}` with `cancel-in-progress: true`.

## 3. Advisory mechanics — why this workflow cannot block production

Three independent layers ensure the Slither workflow is truly advisory:

1. **Step-level `continue-on-error: true`** on every Slither-related step. Slither can return any exit code; the workflow's overall status is `pass`.
2. **Separate workflow file.** The required compile + test gate is `.github/workflows/contracts-ci.yml`, unchanged by PR 7. The Slither workflow runs in parallel; its failure does not affect the required gate.
3. **No `permissions:` escalation.** `contents: read` is the only granted permission. The workflow cannot post status checks that gate other workflows.

## 4. Branch-protection guidance — operator-only

> The `contracts-slither / slither (advisory)` status check produced by this workflow **MUST NOT** be added to GitHub's "Require status checks to pass before merging" list during PR 7's rollout window. The check is intentionally advisory — Slither install / parse / detector failures are common during version-pin upgrades and **must not** block unrelated merges. Escalation to a required gate is a separate operator decision and will land in its own reviewable PR with a documented zero-finding baseline observed across at least three consecutive prior PRs.

## 5. Slither version pin

**`slither-analyzer==0.10.4`** (pinned in the workflow's `pip install` step).

Rationale:
- A pinned version makes the advisory baseline reproducible. Future Slither upgrades (0.10.5, 0.11.x, etc.) land in their own reviewable PRs, where any new-detector findings can be triaged in isolation.
- A floating install would allow new detectors to land silently on a PR that touched nothing relevant — exactly the kind of unstable advisory signal that erodes trust in the workflow.

Upgrade protocol:
1. Open a dedicated PR titled `chore(ci): bump slither-analyzer to <new version>`.
2. PR body lists the new version's release-note changes that are relevant to GaoSafe.
3. PR body documents the new observed baseline (re-run results).
4. Reviewer confirms findings disposition before merge.

## 6. Configuration (`slither.config.json`)

| Field | Value | Reason |
|---|---|---|
| `filter_paths` | `node_modules\|contracts/(?!multisig/)\|contracts/test/` | Scope analysis to multisig sources; exclude vendored deps and Solidity-only mocks. |
| `exclude_dependencies` | `true` | Skip OpenZeppelin vendored code; OZ has its own audit track. |
| `detectors_to_exclude` | `naming-convention,solc-version` | Naming follows project convention (see `CLAUDE.md` + `gao-safe-design.md`); Solidity 0.8.24 is intentionally pinned by `hardhat.config.ts`. |

## 7. Baseline (pending first advisory run)

The baseline is recorded after the first advisory CI run on the PR 7 branch. Until then, **no zero-finding claim is made**. The Stage-2 baseline update lands in a second commit on the same branch after the workflow's first execution produces a `slither-report.json` artifact.

When that artifact lands, this section is replaced with one of:

### Stage 2a — Zero findings (if observed)

```
## Baseline (observed YYYY-MM-DD on commit <sha>)
Slither @ 0.10.4 reports zero findings above the advisory thresholds
configured in slither.config.json on the multisig surface
(contracts/multisig/GaoSafe.sol + contracts/multisig/GaoSafeFactory.sol).

Workflow run: <GitHub Actions URL>
Artifact:     slither-report (90-day retention)

This baseline is advisory only. The workflow remains
`continue-on-error: true` per §3. Escalation to a required gate is a
separate operator decision and will land in its own reviewable PR.
```

### Stage 2b — Non-zero findings (if observed)

```
## Baseline (observed YYYY-MM-DD on commit <sha>)
Slither @ 0.10.4 reports the following findings on the multisig
surface. Each is recorded with a one-line disposition.

| detector | severity | file:line | disposition |
| --- | --- | --- | --- |
| <detector> | <Critical/High/Medium/Low/Informational> | <path>:<line> | waiver: <one-line rationale> OR fix-plan: <one-line plan> in follow-up PR <ref TBD> |
| ... | ... | ... | ... |

Workflow run: <GitHub Actions URL>
Artifact:     slither-report (90-day retention)

Per the PR 7 plan, NO production Solidity source is modified in PR 7
to fix findings. Fix-plan dispositions land in separately-reviewed
follow-up PRs.
```

If any finding's severity is high enough that documenting it as a waiver would be inappropriate (e.g. a real critical correctness bug), the agent **STOPS and reports** before either the doc edit or any source change. The operator decides whether to fix in PR 7 (which would change PR 7's scope and require explicit re-approval) or to fix in a follow-up PR while PR 7 documents the finding as `fix-plan`.

## 8. How to read the JSON artifact

Each CI run uploads `slither-report.json` as a GitHub Actions artifact named `slither-report`. Reviewers retrieve it from the Actions UI:

1. Navigate to **Actions → contracts-slither → \<run\> → Artifacts**.
2. Download `slither-report` (a zip containing `slither-report.json`).
3. The JSON conforms to Slither's standard schema. The relevant top-level field is `.results.detectors`, an array of detector findings.
4. Each finding has at least: `check` (detector name), `impact` (severity), `confidence`, `description`, `elements` (source-location refs).

A `jq` one-liner that pretty-prints the high-and-medium findings:

```bash
jq '.results.detectors[] | select(.impact == "High" or .impact == "Medium")' slither-report.json
```

(Out-of-scope for PR 7: a programmatic baseline-diff tool. A future PR may add a small `scripts/check-slither-baseline.ts` that compares an artifact against a checked-in fingerprint of the documented baseline.)

## 9. Local invocation (developer convenience, not part of PR 7)

PR 7 does NOT ship a `scripts/run-slither.sh` wrapper and does NOT modify `package.json` to add an `npm run slither` shortcut. Developers who want to run Slither locally can copy the workflow's invocation:

```bash
pip install --user "slither-analyzer==0.10.4"
slither . --config-file slither.config.json --json /tmp/slither-report.json
```

The `--json` target is the developer's choice; the repo working tree is never written to by the workflow. Developers who write Slither output into the repo working tree are responsible for not committing it. A future PR may add a `.gitignore` entry for a canonical local output path.

## 10. Cross-references

- `slither.config.json` — configuration consumed by the workflow.
- `.github/workflows/contracts-slither.yml` — workflow definition.
- `docs/multisig/gao-safe-invariants.md` — invariant matrix and property-test seeding methodology that complements static analysis.
- `gaokey-mobile/docs/multisig/static-analysis-fuzz-plan.md` at `gaokey-mobile@6354d99` — companion mobile-side plan covering parity tests and the contracts-side roadmap (PR 7 implements §3.1 / §3.4 / §3.5 of that plan).
- `docs/multisig/gao-safe-test-plan.md` — existing 56-case multisig test matrix (point cases that the property tests complement, not replace).
- `gaokey-mobile/docs/multisig/production-readiness-gate.md` §1 (audit) — the upstream gate that benefits from this advisory coverage.

## 11. The bottom line

GaoSafe Genesis remains pre-audit. The advisory Slither workflow added in PR 7 is an additional reviewer signal, not a production-readiness claim. The hard gate is in the consuming-app repo at `gaokey-mobile/docs/multisig/production-readiness-gate.md`. Until that gate is satisfied, the feature flag stays off, the factory map stays empty, no mainnet deployment exists, and no real funds are at risk.
