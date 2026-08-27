# FRF-WP01 — Baseline Commands (the FRF blocking command list)

Exact commands, runnable as-is from the repo root of the FRF worktree
(`D:/Development/saga-mcp-FRF-WP01`, branch `frf/wp01-baseline`, base
`5c158608`). What each proves, and the recorded base result. The full
captured log: `acceptance-matrix-base.log` (same directory).

## 0. Build gate

```bash
npm run build
```

- Proves: clean tsc emit; `dist/` exists for every suite (the `.mjs`
  suites import from `dist/`, never from TS source).
- Base result: **GREEN** (exit 0).

## 1. Acceptance matrix (the blocking CI surface; 11 groups)

```bash
node tools/run-acceptance-matrix.mjs                # every group, blocking
node tools/run-acceptance-matrix.mjs --group workflow-kernel
node tools/run-acceptance-matrix.mjs --list-json    # structured registry
```

- Proves / base results (matrix runs sequentially; recorded at base):

| Group | Proves | Base result |
|---|---|---|
| `workflow-kernel` (88 files) | The EK kernel + ALL workshop suites incl. Formalization 68/68 and Development; FRF's primary regression fence | **737/737 GREEN** (one load-flaky failure observed in a first run — development scenario idempotency — did not recur on rerun; same flakiness class as the EK receipt's claude-shim T3) |
| `project-corpus` (4 files) | The 20-project scripted corpus + elite-kit replay through public ingress | **33/33 GREEN** |
| `architecture` (6 files) | ADR-053 cutover gates, dependency-direction ratchet, conveyor boundaries | **67/67 GREEN** |
| `kept-tooling` (4 files) | ADR registry, build receipt, opencode-shim transport guards | **27/27 GREEN** |
| `ek-manifest-guard` (1 file) | Deletion-manifest stop-gate | **5/7 RED — PRE-EXISTING at base** (see below) |
| `ek-admission` | EK-1 admission-spec validator | **1/1 GREEN** |
| `ek-removal-guard` | WP-13C removal guards | **10/10 GREEN** |
| `ek-mutation-coverage` | Declared kernel mutation demonstrations are real kills | **2/2 GREEN** |
| `ek-evidence-kit` | Elite-evidence-kit determinism | **3/3 GREEN** |
| `matrix-coverage` | Matrix completeness + no-hidden-failure | **19/19 GREEN** |
| `cc-proof-registry` | Proof-hosting registry | **26/26 GREEN** |

- **The pre-existing red (recorded, not caused by FRF-WP01):**
  `ek-manifest-guard` fails at CLEAN base `5c158608` (verified by
  stash-and-rerun) with exactly two findings from
  `docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs`:
  1. `DIAG COUNT-MISMATCH: §B.2 src/app/** says (19) but the tree has 18`
  2. `RED V2-UNCLASSIFIED: core-view-ek/README.md, tracker-view-ek/README.md
     … a new file must never join the tree unclassified`
  Both were introduced by the BASE COMMIT ITSELF (`5c158608`
  "feat(fronts): the new-kernel front clones enter the repo") — the fronts
  commit added unclassified files under the document manifest's scope. The
  EK closure line (`be0d5948`) recorded 932/0 green, so this red post-dates
  the closure. FRF-WP01 may not fix it (the manifest is EK-owned);
  **coordinator must classify the fronts files or FRF phases inherit a
  permanently red group.** FRF's own additions stay outside the manifest's
  scope (docs/refactoring/formalization-frf/** is not a manifest scope
  root).

## 2. Per-surface blocking commands (FRF phase fences)

```bash
# Formalization focused suite (68/68 at base; FRF-2..10 must keep green or land RED-then-green)
node --test "tests/workflow-kernel/workshops/formalization/*.test.mjs"

# Development focused suites (FRF-9's consumption gap turns RED here)
node --test "tests/workflow-kernel/workshops/development/*.test.mjs"
node --test "tests/workflow-kernel/development/*.test.mjs"

# Scenario engine + faults (FRF-10 extends; no second harness)
node --test "tests/workflow-kernel/engine/scenario.test.mjs" "tests/workflow-kernel/faults/scenario-faults.test.mjs"

# Workflow model + complexity budget (FRF-5 re-verifies the sixth Cell against it)
npm run test:workflow-model
npm run test:workflow-complexity

# Legacy-zero (FRF-10's static searches build on it)
npm run test:legacy-zero

# Admission specs (concept budget)
npm run validate:ek-admission-specs
```

- Base results: all GREEN at base (legacy-zero 5/5 laws, complexity 16/16
  dimensions — recorded in the EK FINAL-RECEIPT and re-verified green in
  the matrix groups above; the per-command runs are inside
  `workflow-kernel`/`ek-*` group results in `acceptance-matrix-base.log`).

## 3. FRF-WP01 reproduction/capture commands (this package's own artifacts)

```bash
# UC-FOREIGN counterexample (the REQUIRED FRF-09 fix target; honest {ok:true} at base)
node docs/refactoring/formalization-frf/baseline/uc-foreign-reproduction.mjs

# Installed graph capture (11 nodes / 18 edges / manifestDigest)
node docs/refactoring/formalization-frf/baseline/capture-installed-graph.mjs

# Post-EK inventory capture (digests, tests, matrix registry, CI hosts)
node tools/run-acceptance-matrix.mjs --list-json > docs/refactoring/formalization-frf/baseline/acceptance-matrix-registry.json
node docs/refactoring/formalization-frf/baseline/capture-post-ek-inventory.mjs
```

## 4. Full suite (used at phase exits)

```bash
npm test   # tsc + the acceptance matrix (the matrix IS the blocking surface; no blanket node --test)
```

## FRF phase → command mapping (which groups run, what they prove)

| Phase | Blocking commands | Prove |
|---|---|---|
| FRF-0 | 0 + 1 + 3 (this package) | Prerequisites verified; baseline frozen; graph captured; inventory machine-checkable |
| FRF-1 | 3 (graph capture diff vs authored forward/reverse graphs) | Independent graphs reconciled; eleven/eighteen frozen |
| FRF-2 | `workflow-kernel` + Formalization focused suite | RED graph/contract tests registered in the blocking matrix BEFORE production turns them green |
| FRF-3..6 | Formalization focused + `workflow-kernel` + `architecture` | Cell semantics land without regressing kernel/ADR-053 laws |
| FRF-7 | + `ek-manifest-guard` (after coordinator fixes the pre-existing red) + `project-corpus` | Baseline authority replacement; corpus still passes through public ingress |
| FRF-8..9 | + Development focused suites | SRS realization + handoff consumption; UC-FOREIGN killed |
| FRF-10 | 2 (all) + `npm run test:legacy-zero` | Cutover complete; legacy-zero stays 5/5; 18/18 transitions declared==demonstrated |
| FRF-11 | 1 (full matrix) + docs-current checks | Package integration, deletions, removal guards, hosting |
| FRF-12 | 1 (full matrix on the immutable kit SHA) + `npm run qualify:*` series | Three consecutive real-agent projects on one build |
