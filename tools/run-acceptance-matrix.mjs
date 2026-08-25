#!/usr/bin/env node
// CI-02 — deterministic Factory acceptance matrix runner.
//
// Replaces the blanket `npm test` (= `tsc && node --test`), which discovered and
// ran EVERY *.test.mjs under the tree — including FLAKY and pre-existing-RED
// files — so its exit code was never a trustworthy blocking signal. This runner
// is the opposite: it runs ONLY the deterministic Factory acceptance suites,
// each as its own isolated `node --test` process (group), and EXCLUDES every
// quarantined suite/file with a documented reason. Nothing is hidden: no
// `|| true`, no continue-on-error, no retries. A red group fails the matrix.
//
// Why isolated groups instead of one blanket invocation: running the whole tree
// in a single `node --test` process causes cross-suite state contention (shared
// SQLite temp DBs, served-process ports, orchestrate-cli replay capsules) that
// turns deterministically-green suites red. The integrator classified each suite
// in isolation; the matrix reproduces that isolation. See
// docs/factory/CI-02-ACCEPTANCE-MATRIX.md for the full classification evidence.
//
// Usage:
//   node tools/run-acceptance-matrix.mjs                 # run every group (blocking)
//   node tools/run-acceptance-matrix.mjs --group architecture
//   node tools/run-acceptance-matrix.mjs --list          # coverage proof, run nothing (human)
//   node tools/run-acceptance-matrix.mjs --list-json     # machine-readable export (ADR-092)
//
// Mirrors the directory-scan + --list style of run-process-module-tests.mjs.
// The quarantine table below is the single source of truth; the coverage test
// tests/infrastructure/acceptance-matrix-coverage.test.mjs asserts it.
//
// ADR-092 (CC-U1 proof registration): --list-json is the STRUCTURED group
// registry consumed by validation and tests (acceptance-matrix-coverage,
// cc-proof-hosting). Consumers MUST NOT regex-parse the human --list text:
// the JSON export is the only supported machine surface, so notes/prose can
// change without breaking a validator.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CI-03: the *.mjs suites import from dist/, so dist/ MUST exist. In CI it is
// built by the `npm run build` step; for standalone/local invocations the runner
// builds it on demand (once) so `node tools/run-acceptance-matrix.mjs` is
// self-contained on a clean checkout.
let distEnsured = false;
function ensureDist() {
  if (distEnsured || existsSync(path.join(root, 'dist'))) { distEnsured = true; return; }
  console.log('[acceptance-matrix] dist/ absent — running `npm run build` (tsc emit)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.error('[acceptance-matrix] build failed — cannot run matrix without dist/');
    process.exit(build.status ?? 1);
  }
  distEnsured = true;
}

// --- Factory acceptance matrix groups ---------------------------------------
// Each group is a deterministic-green Factory acceptance suite, run as ONE
// isolated `node --test` process (its own blocking CI step). Globs are expanded
// against the working tree; quarantined matches (see QUARANTINE) are removed
// before execution. `concurrency: 1` reproduces the proven process-modules
// runner sequencing where the suite needs strict ordering for determinism.
const GROUPS = {
  architecture: {
    globs: ['tests/architecture/*.test.mjs'],
    note: 'ADR-053 cutover gates, dependency-direction ratchet, conveyor boundaries',
  },
  'factory-model': {
    globs: ['tests/factory-model/*.test.mjs'],
    note: 'dual-cycle generated model',
  },
  'readiness-fencing': {
    globs: [
      'tests/infrastructure/transition-obligation-*.test.mjs',
      'tests/infrastructure/local-runnability-warrant-oracle.test.mjs',
    ],
    note: 'C7 monotonic lease fencing (deterministic). LR local-readiness real-execution is quarantined — see QUARANTINE.',
  },
  'factory-contract': {
    globs: ['tests/factory-contract/*.test.mjs'],
    note: 'C5 carry-forward adversarial matrix + production-cell transitions',
  },
  'process-modules': {
    globs: [
      'tests/process-modules/*.test.mjs',
      // CC-GAP-8: the criterion-key verification-accounting ledger suite
      // (terminal-route facts, no-poison, blocking mutations) is a BLOCKING
      // development-module acceptance proof — not blanket-`npm test` material.
      'tests/modules/development/verification-ledger.test.mjs',
      // CC-GAP-8 proof hosting: the terminal-exit accounting structural
      // oracle (every reachable Development terminal exit is settlement-
      // accounted or provably pre-ledger; RED/GREEN on the rejected
      // df7359fa edges) was committed but orphaned — no group ran it, so CI
      // never executed it. Exact file on purpose: no directory glob, so the
      // hosted CC-GAP-8 proof surface cannot silently widen. The coverage
      // test (G2g) fails if this entry is removed.
      'tests/modules/development/development-terminal-exit-accounting.test.mjs',
      // ELITE-8 seam (same orphan class): the worker prompt-assembly suite
      // (buildPrompt/projectTaskForPrompt contracts, incl. the G1.9
      // recovery_feedback prompt-snowball bound) lived at tests/ root —
      // matched by NO group glob, so CI never executed it. Exact file on
      // purpose: no directory glob, the surface cannot silently widen.
      'tests/worker-prompt-assembly.test.mjs',
      // The 2026-08-23 desk-coverage audit found SIX more orphans of the
      // same class (committed by the closure program, hosted by nobody):
      // the planner-desk GAP-6 suites and the readiness-desk substrate
      // suites. Exact files, same GAP-8 hosting pattern.
      'tests/modules/development/task-graph-register-conditional-coverage.test.mjs',
      'tests/modules/development/task-graph-gate-srs-manifest.test.mjs',
      // BM-5/MM-4 repair proof (Elite-8 counterexample, 2026-08-24): §2.2 ×
      // §D2/§D1 file-identity satisfiability (RED/GREEN pinned) + the policy
      // no-invented-fallback oracle. Exact file on purpose: same GAP-8
      // hosting pattern — the hosted surface cannot silently widen.
      'tests/modules/development/srs-file-identity-satisfiability.test.mjs',
      // Same hosting pattern for the derivation half the repair touched: the
      // scopes suite (shared §D2/§D1 surface + EMPTY-when-underivable policy)
      // was previously unhosted (TEST_COVERAGE TC-5 guard gap).
      'tests/modules/development/srs-derived-change-scopes.test.mjs',
      'tests/infrastructure/local-runnability-substrate-retry.test.mjs',
      'tests/infrastructure/local-runnability-toctou-reprobe.test.mjs',
      'tests/infrastructure/environment-identity.test.mjs',
      'tests/infrastructure/local-runnability-seam-compose.test.mjs',
      // ADR-095 Phase-2A (blocker (b) resolution): the migration-conformance
      // suite was unhosted AND hard-pins legacy Discovery surfaces — the
      // dist imports of the dead discovery-settlement-repository.js /
      // discovery-outcome-certificate-projection.js plus the fresh-DB
      // factory_proposals INSERT seed. It does NOT assert the six-handler
      // count/IDs (its package-isolation lane validates the manifest
      // structurally only; handler shape is owned by the
      // handler-digest-runtime-consistency suite + the Phase-4 hard
      // ratchet). It is GREEN on the current legacy baseline (35/35,
      // 2026-08-24) and hosted here WITHOUT repinning — the production
      // surface has not changed yet. The mandatory SAME-COMMIT Phase-4
      // migration is recorded in
      // tests/infrastructure/adr-095-removal-inventory.mjs
      // (mandatoryPhase4Repins) and pinned by coverage guard G2j. Exact file
      // on purpose: no directory glob, the surface cannot silently widen.
      'tests/execution/migration-conformance.test.mjs',
      // ADR-095 Phase-3.1 canonical integration (Red Team LOW-1): the
      // conveyor v4.3 focused-invariants suite (11 live conveyor
      // invariants, including the Phase-3.1-migrated projection-free
      // product_submit invariant 5 with its negative proofs) was committed
      // but hosted in NO group — the same orphan class CC-GAP-8 closed.
      // Deterministic standalone (10/10 green, temp DB via DB_PATH, env
      // restored in finally; node --test isolates each file in its own
      // process). Exact file on purpose: no directory glob, so the hosted
      // surface cannot silently widen. The removal/de-hosting guard is G2l
      // in tests/infrastructure/acceptance-matrix-coverage.test.mjs; its
      // Phase-5 same-commit repin obligation (the factory_proposals
      // negative assertion) is recorded machine-readably in
      // tests/infrastructure/adr-095-removal-inventory.mjs
      // (mandatoryPhase5Repins).
      'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
    ],
    concurrency: 1,
    note: 'module composition + LR-07 development-local-readiness binding + CC-GAP-8 verification-accounting ledger + terminal-exit accounting oracle + worker prompt-assembly contracts + ADR-095 migration-conformance (green on legacy baseline, Phase-4 repin owed) + ADR-095 conveyor v4.3 focused-invariants (Phase-3.1 migrated live oracle, Phase-5 repin owed)',
  },
  // ADR-095 Phase-2A (blocker (a) resolution): the four proven LIVE Discovery
  // v2 oracles were CI orphans — no blocking run-set and no quarantine hosted
  // them, so ratchet 6 ("live v2 behavior") had no hosted executor. Narrowly
  // justified EXACT-FILE group (no directory globs — the hosted live-v2
  // surface cannot silently widen). Per-file removal guards G2i in
  // tests/infrastructure/acceptance-matrix-coverage.test.mjs make deletion or
  // de-hosting fail the coverage suite. ADR-095 Decision 5 preserves these
  // suites untouched through the whole removal.
  //
  // ADR-095 Phase-2B (audit correction C3): FOUR MORE proven-live orphans
  // were found unhosted by the same test — d1-1-authority, d1-1-binding
  // (D1 authority/binding over live db/schema/dispatcher infra),
  // d3-readiness-domain (live readiness-assessment domain), and
  // d4-settlement-policy (live settlement-policy/input/readiness domains).
  // All four import ZERO dead Discovery surfaces (verified by dist-import
  // scan 2026-08-24) and are green (62/62 combined in isolation). Hosted
  // here BLOCKING; exact files, same no-widening rule.
  'discovery-live-v2': {
    globs: [
      'tests/discovery/d7-settlement-lifecycle-classification.test.mjs',
      'tests/discovery/order-constraint-register.test.mjs',
      'tests/matrix/e-constraint-loss.test.mjs',
      'tests/modules/discovery/discovery-check-providers.test.mjs',
      'tests/discovery/d1-1-authority.test.mjs',
      'tests/discovery/d1-1-binding.test.mjs',
      'tests/discovery/d3-readiness-domain.test.mjs',
      'tests/discovery/d4-settlement-policy.test.mjs',
    ],
    note: 'ADR-095 Phase-2A/2B live-v2 hosting — settlement lifecycle classification (m1-m6), order-constraint register round-trip, E constraint-loss boundary matrix, live check providers, D1 authority + binding, D3 readiness domain, D4 settlement-policy domain. Ratchet-6 executor surface; never weakened, never quarantined.',
  },
  // STAGE-23 desk-coverage audit (2026-08-24, operator directive): walk every
  // desk of every workshop and host its orphaned suites. 33 desk-zone files
  // were committed by the closure program but matched by NO group glob (the
  // CC-GAP-8 orphan class; R1 in the red-team audit) — CI never executed
  // them. All verified deterministic-green in isolation on 2026-08-24.
  // Exact files on purpose (no directory glob): the hosted desk surface
  // cannot silently widen; the completeness ratchet G2k in
  // tests/infrastructure/acceptance-matrix-coverage.test.mjs fails when a
  // desk-zone file is neither hosted nor quarantined.
  'desk-coverage': {
    globs: [
      // workshop 1 — Discovery desks (d1 authority/binding, d2 normalization,
      // d3 readiness, d4 settlement, d5 certificate bundle)
      'tests/discovery/d1-1-authority.test.mjs',
      'tests/discovery/d1-1-binding.test.mjs',
      'tests/discovery/d3-architecture-boundary.test.mjs',
      'tests/discovery/d3-readiness-domain.test.mjs',
      'tests/discovery/d4-architecture-boundary.test.mjs',
      'tests/discovery/d4-settlement-policy.test.mjs',
      'tests/discovery/d4-settlement-recovery.test.mjs',
      // workshop 2 — Formalization desks
      'tests/modules/formalization/acceptance-heading-resolution.test.mjs',
      'tests/modules/formalization/artifact-ref-bridge.test.mjs',
      // workshop 3 — Development desks (implementation scope consumption,
      // readiness surface, settlement verdicts, SRS scopes/manifests)
      'tests/modules/development/development-verification-check-provider.test.mjs',
      'tests/modules/development/factory-managed-repository-paths.test.mjs',
      'tests/modules/development/implementation-scope-ancestry.test.mjs',
      'tests/modules/development/implementation-scope-workitemkey.test.mjs',
      'tests/modules/development/implementation-workset-item-key.test.mjs',
      'tests/modules/development/readiness-test-surface.test.mjs',
      'tests/modules/development/settlement-placeholder-verdict.test.mjs',
      'tests/modules/development/srs-derived-change-scopes.test.mjs',
      'tests/modules/development/srs-module-manifest.test.mjs',
      'tests/modules/development/text-set-manifest.test.mjs',
      // workshop 4 — Delivery desks
      'tests/modules/delivery/delivery-effect-contracts.test.mjs',
      // conveyor seams of the desks, born from the 2026-08-24 incident
      // investigation: the redevelop parent guard (every terminal shape,
      // synthetic — the live-shaped suite skips without the stage-15 sandbox)
      // and the replay-adoption seam (SW6: adoption is a byte-stable no-op —
      // the exact mechanism the development-only entry used on 2026-08-24).
      'tests/app/factory-redevelopment-guard.test.mjs',
      'tests/infrastructure/replay-certification-sweep.test.mjs',
      // Desk-suspect sweep (same audit, second pass — files OUTSIDE the desk
      // zones whose subject is still a desk): the SRS-004 AC-9 planner
      // (impact cascade, topology switch, theme-brief pipeline — 25 tests)
      // and two implementation-desk behavior suites (effective desk base;
      // repair-code preservation — the reviewer sees the rejected attempt's
      // code, the author must stay blind to it). All deterministic-green in
      // isolation. NOT hosted: development-verification-continuation-live
      // (skips everywhere without the live sandbox — the declared-precondition
      // class of factory-redevelopment.test.mjs; hosting adds no CI signal).
      'tests/planner-ac9/cascade.test.mjs',
      'tests/planner-ac9/theme-brief-pipeline.test.mjs',
      'tests/planner-ac9/topology.test.mjs',
      'tests/infrastructure/effective-desk-base.test.mjs',
      'tests/infrastructure/previous-attempt-desk.test.mjs',
    ],
    concurrency: 1,
    note: 'STAGE-23 desk-coverage audit — every workshop desk suite hosted (33 ex-orphans + the redevelop guard + the replay-adoption sweep); G2k ratchets the desk zones closed',
  },
  // R1 omnibus closure (2026-08-24 orphan research, operator-approved): the W9 scripted E2E harness — built as the DETERMINISTIC successor of the flaky orchestrate-cli suites per CI-02 — was committed but never hosted. All 5 drives deterministic-green in isolation (192s total).
  'e2e-deterministic': {
    globs: [
      'tests/factory-e2e/perturbation-tapes.test.mjs',
      'tests/factory-e2e/w9-02-happy-path.test.mjs',
      'tests/factory-e2e/w9-03-adversarial.test.mjs',
      'tests/factory-e2e/w9-04-outcome-edges.test.mjs',
      'tests/factory-e2e/w9-05-disobedience.test.mjs',
      'tests/factory-e2e/w9-06-scope-widening.test.mjs',
    ],
    concurrency: 1,
    note: 'R1 omnibus closure (2026-08-24 orphan research, operator-approved): the W9 scripted E2E harness — built as the DETERMINISTIC successor of the flaky orchestrate-cli suites per CI-02 — was committed but never hosted. G2l keeps the whole repo orphan-free.',
  },
  // R1 omnibus closure: app/lifecycle/checkpoint/runtime/factory-cycle suites — 48 ex-orphans, all deterministic-green in isolation (app-command surfaces incl. soft-stop/adoption/rerun, lifecycle continuation, checkpoint service).
  'conveyor-app': {
    globs: [
      'tests/app/engine-supervisor.test.mjs',
      'tests/app/engine-watchdog-migration.test.mjs',
      'tests/app/factory-engine-spawn.test.mjs',
      'tests/app/git-bootstrap.test.mjs',
      'tests/app/graceful-drain-pause.test.mjs',
      'tests/app/launch-terminal-settlement.test.mjs',
      'tests/app/operator-soft-stop-engine-brake-launch-pids.test.mjs',
      'tests/app/operator-soft-stop-migration.test.mjs',
      'tests/app/operator-soft-stop-process.test.mjs',
      'tests/app/operator-soft-stop.test.mjs',
      'tests/app/operator-unpark-workplace.test.mjs',
      'tests/app/product-lifecycle-start-receipt.test.mjs',
      'tests/app/wait-poll-bound.test.mjs',
      'tests/characterization/lifecycle-routing-mapping-lock.test.mjs',
      'tests/characterization/mcp-catalog-authority-errors.test.mjs',
      'tests/checkpoints/capture-child.test.mjs',
      'tests/checkpoints/engine-auto-resume.test.mjs',
      'tests/checkpoints/factory-checkpoint.test.mjs',
      'tests/checkpoints/factory-failed-gate-recovery.test.mjs',
      'tests/checkpoints/factory-paused-recovery.test.mjs',
      'tests/checkpoints/factory-start-gateway.test.mjs',
      'tests/checkpoints/lifecycle-definition-compatibility.test.mjs',
      'tests/checkpoints/resume-directive.test.mjs',
      'tests/factory-cardinality/factory-run-cardinality.test.mjs',
      'tests/factory-cycle/01-factory-start.test.mjs',
      'tests/factory-cycle/02-first-cell.test.mjs',
      'tests/factory/factory-recovery-fixes.test.mjs',
      'tests/factory/managed-production-node-scoped-reader.test.mjs',
      'tests/factory/trace-delete-managed-ledger-mirror.test.mjs',
      'tests/lifecycle/application-service.test.mjs',
      'tests/lifecycle/architecture.test.mjs',
      'tests/lifecycle/artifact-presentation.test.mjs',
      'tests/lifecycle/ask-protocol.test.mjs',
      'tests/lifecycle/atomic-release.test.mjs',
      'tests/lifecycle/claim-dependency.test.mjs',
      // STAGE-23 feedback-loop fix: the gate-rejection source of the episodic
      // task memory (third durable source — repair_required gate decisions
      // for the task's workplace+role with decoded finding text).
      'tests/lifecycle/task-recovery-memory-gate-source.test.mjs',
      'tests/lifecycle/model-selector.test.mjs',
      'tests/lifecycle/pipeline-worker-activity-label.test.mjs',
      'tests/lifecycle/project-delete.test.mjs',
      'tests/lifecycle/repository-lock.test.mjs',
      'tests/lifecycle/reviewer-completion-routing.test.mjs',
      'tests/lifecycle/stuck-policy.test.mjs',
      'tests/lifecycle/task-history-readers.test.mjs',
      'tests/lifecycle/task-recovery-memory.test.mjs',
      'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
      'tests/replay/replay-capsule-boundary.test.mjs',
      'tests/runtime/busy-retry.test.mjs',
      'tests/runtime/durable-state-probe.test.mjs',
      'tests/runtime/engine-file-logger.test.mjs',
    ],
    concurrency: 1,
    note: 'R1 omnibus closure: app/lifecycle/checkpoint/runtime/factory-cycle suites — 48 ex-orphans, all deterministic-green in isolation (app-command surfaces incl. G2l keeps the whole repo orphan-free.',
  },
  // R1 omnibus closure: infrastructure/installation/spi/application zones — 77 ex-orphans (46 infrastructure: replay seams, gate/material repos, watchman, projections; package installer; SPI contracts). Excluded deliberately: local-runnability-check-provider (FLAKY quarantine), development-verification-continuation-live (skip-only without the live sandbox — the declared-precondition allowlist).
  'conveyor-infra': {
    globs: [
      'tests/agent-proxy/claude-shim-cwd.test.mjs',
      'tests/agent-proxy/sandbox-agents-marker.test.mjs',
      'tests/application/actionable-tool-error.test.mjs',
      'tests/application/concurrent-launch-budget.test.mjs',
      'tests/application/conveyor-runtime-park-reason.test.mjs',
      'tests/application/module-conformance-runner.test.mjs',
      'tests/application/package-describe.test.mjs',
      'tests/application/tool-contribution-installer.test.mjs',
      'tests/infrastructure/abandon-lifecycle-run.test.mjs',
      'tests/infrastructure/accepted-authority-head.test.mjs',
      'tests/infrastructure/accepted-candidate-authority.test.mjs',
      'tests/infrastructure/accessible-counter-check-provider.test.mjs',
      'tests/infrastructure/artifact-code-null-replay-debris.test.mjs',
      'tests/infrastructure/author-carry-forward-sibling-merge.test.mjs',
      'tests/infrastructure/candidate-set-revision-authority.test.mjs',
      'tests/infrastructure/capsule-invalidation-evidence.test.mjs',
      'tests/infrastructure/capsule-replay-restore-on-failure.test.mjs',
      'tests/infrastructure/dispatch-typed-outcomes.test.mjs',
      'tests/infrastructure/engine-start-adoption.test.mjs',
      'tests/infrastructure/engine-start-lifecycle-burial.test.mjs',
      'tests/infrastructure/environment-derivation.test.mjs',
      'tests/infrastructure/environment-image-observation.test.mjs',
      'tests/infrastructure/factory-boot-revision.test.mjs',
      'tests/infrastructure/frozen-limit-admission.test.mjs',
      'tests/infrastructure/invalidation-crash-convergence.test.mjs',
      'tests/infrastructure/local-runnability-coverage-report.test.mjs',
      'tests/infrastructure/local-runnability-derived-canonical.test.mjs',
      'tests/infrastructure/local-runnability-receipt-candidate-binding.test.mjs',
      'tests/infrastructure/local-runnability-trust-history.test.mjs',
      'tests/infrastructure/managed-source-change-candidate.test.mjs',
      'tests/infrastructure/newest-wins-hardening.test.mjs',
      'tests/infrastructure/package-changed-invalidation-bridge.test.mjs',
      'tests/infrastructure/product-repository.test.mjs',
      'tests/infrastructure/production-cell-integration-candidate-binding.test.mjs',
      'tests/infrastructure/production-cell-integration-merged-ancestry.test.mjs',
      'tests/infrastructure/production-cell-integration-transient-git.test.mjs',
      'tests/infrastructure/production-cell-projection-title.test.mjs',
      'tests/infrastructure/reconciliation-ledger.test.mjs',
      'tests/infrastructure/replay-artifact-bytes-resolution.test.mjs',
      'tests/infrastructure/replay-capsule-selection.test.mjs',
      'tests/infrastructure/replay-capture-trace-revision.test.mjs',
      'tests/infrastructure/replay-carry-forward-presentation.test.mjs',
      'tests/infrastructure/replay-foreign-submission-cell.test.mjs',
      'tests/infrastructure/replay-semantic-key-theorem.test.mjs',
      'tests/infrastructure/served-process-runner.test.mjs',
      'tests/infrastructure/sqlite-concurrency-admission.test.mjs',
      'tests/infrastructure/sqlite-workplace-graph.test.mjs',
      'tests/infrastructure/transition-handoff-postconditions.test.mjs',
      'tests/infrastructure/work-item-projector.test.mjs',
      'tests/infrastructure/worker-launcher.test.mjs',
      'tests/infrastructure/workplace-conformance-e2e-extended.test.mjs',
      'tests/infrastructure/workplace-conformance-harness.test.mjs',
      'tests/infrastructure/workplace-production-revision.test.mjs',
      'tests/infrastructure/workplace-repositories.test.mjs',
      'tests/installation/contract-boundary-decoder.test.mjs',
      'tests/installation/describe.test.mjs',
      'tests/installation/filesystem-package-store.test.mjs',
      'tests/installation/handler-digest-rejection.test.mjs',
      'tests/installation/installation-repository.test.mjs',
      'tests/installation/installer.test.mjs',
      'tests/installation/package-registry.test.mjs',
      'tests/installation/process-product-repository-v2.test.mjs',
      'tests/installation/registries.test.mjs',
      'tests/installation/runtime-package-fingerprint.test.mjs',
      'tests/installation/scenario-installation-repository.test.mjs',
      'tests/spi/agent-assistance.test.mjs',
      'tests/spi/canonical-serialization.test.mjs',
      'tests/spi/contract-schema-registry.test.mjs',
      'tests/spi/execution-envelope.test.mjs',
      'tests/spi/module-completion.test.mjs',
      'tests/spi/module-manifest.test.mjs',
      'tests/spi/node-protocol.test.mjs',
      'tests/spi/production-envelope.test.mjs',
      'tests/spi/round-trip-conformance.test.mjs',
      'tests/spi/scenario-manifest.test.mjs',
      'tests/spi/synthetic-fixture-conformance.test.mjs',
      'tests/spi/tool-contribution.test.mjs',
    ],
    concurrency: 1,
    note: 'R1 omnibus closure: infrastructure/installation/spi/application zones — 77 ex-orphans (46 infrastructure: replay seams, gate/material repos, watchman, projections; package installer; SPI contracts). G2l keeps the whole repo orphan-free.',
  },
  // R1 omnibus closure: execution hooks, carry-forward adversarial matrix, dispatcher-race test files, routing, tracker-view, docs-graph, restore-from-checkpoint, module-authoring/scenario kits, ADR registry, modules-ext, root singles. 54 ex-orphans, all deterministic-green in isolation.
  'conveyor-periphery': {
    globs: [
      'modules-ext/human-director-approval/test/human-director-approval.test.mjs',
      'modules-ext/lm-marketing/lm-marketing.test.mjs',
      'tests/claude-runner.test.mjs',
      'tests/completeness/completeness.test.mjs',
      'tests/dispatcher-race/dispatch-loop-overlap.test.mjs',
      'tests/dispatcher-race/orchestrate-global-budget.test.mjs',
      'tests/docs-graph-merge.test.mjs',
      'tests/docs-graph-scanner.test.mjs',
      'tests/docs-graph-snapshot.test.mjs',
      'tests/execution/call-correlation.test.mjs',
      'tests/execution/crash-resume-exact-receipt.test.mjs',
      'tests/execution/exact-product-query.test.mjs',
      'tests/execution/execution-tool-catalog.test.mjs',
      'tests/execution/hardening-campaign-e2e.test.mjs',
      'tests/execution/hardening-execution-crash.test.mjs',
      'tests/execution/hardening-package-integrity.test.mjs',
      'tests/execution/hardening-protocol-crash.test.mjs',
      'tests/execution/hardening-scenario-fault.test.mjs',
      'tests/execution/hardening-security.test.mjs',
      'tests/execution/hardening-weak-model.test.mjs',
      'tests/execution/mcp-conformance.test.mjs',
      'tests/execution/no-fallback-reconstruction.test.mjs',
      'tests/execution/protocol-transitions.test.mjs',
      'tests/execution/recovery-conformance.test.mjs',
      'tests/execution/scenario-compiler.test.mjs',
      'tests/execution/scenario-tests.test.mjs',
      'tests/execution/structured-context-hook.test.mjs',
      'tests/execution/workspace-tracker-hook-tests.test.mjs',
      'tests/extensibility/w10-a4-campaign-scenario.test.mjs',
      'tests/fast-track/fast-track.test.mjs',
      'tests/fixtures/synthetic-modules/index.test.mjs',
      'tests/matrix/a-progress-space.test.mjs',
      'tests/matrix/b-material-reidentification.test.mjs',
      'tests/matrix/c-declaration-narrowing.test.mjs',
      'tests/matrix/d-authority-contradiction.test.mjs',
      'tests/matrix/f-authority-delivery.test.mjs',
      'tests/matrix/widening-worker-visibility.test.mjs',
      'tests/restore-from-checkpoint-reset-hygiene.test.mjs',
      'tests/restore-from-checkpoint-reset-stage.test.mjs',
      'tests/role-projection-rendering.test.mjs',
      'tests/routing/claude-runner-frozen-endpoint.test.mjs',
      'tests/routing/execution-route-boundary.test.mjs',
      'tests/routing/frozen-endpoint-freeze.test.mjs',
      'tests/scenario/scenario-module-lock.test.mjs',
      'tests/semantic-identity/semantic-production-identity.test.mjs',
      'tests/tracker-view/engine-status-launch-projection.test.mjs',
      'tests/tracker-view/model-management-guard.test.mjs',
      'tests/worker-names-display.test.mjs',
      'tools/adr-closure-registry.test.mjs',
      'tools/build-receipt.test.mjs',
      'tools/module-authoring-kit/conform.test.mjs',
      'tools/module-authoring-kit/scaffold.test.mjs',
      'tools/module-authoring-kit/validator.test.mjs',
      'tools/scenario-authoring-kit/scenario-authoring-kit.contract.test.mjs',
      'tools/scenario-authoring-kit/scenario-validator.test.mjs',
    ],
    concurrency: 1,
    note: 'R1 omnibus closure: execution hooks, carry-forward adversarial matrix, dispatcher-race test files, routing, tracker-view, docs-graph, restore-from-checkpoint, module-authoring/scenario kits, ADR registry, modules-ext, root singles. G2l keeps the whole repo orphan-free.',
  },
  // EK-1 stop-gate (2026-08-25): the deletion-manifest guard and the admission-spec validator are BLOCKING.
  'ek-manifest-guard': {
    globs: ['tests/infrastructure/deletion-manifest-guard.test.mjs'],
    note: 'EK-1/WP-04b deletion-manifest stop-gate — V1 existence, V2 no-new-unclassified, V3 consistency, V4 CREATE TABLE coverage; 3 killed mutations',
  },
  'ek-admission': {
    globs: ['tests/infrastructure/ek-admission-validator.test.mjs'],
    note: 'EK-1 admission-spec validator wrapper — validate:ek-admission-specs blocking in the matrix',
  },
  // ADR-096 gate item 2 (W3, 2026-08-25): the K4 crash/fault edges are
  // BLOCKING. The four ADR-048 worker-boundary crash suites (exit before
  // product submission / exit after submission before worker_done / accepted
  // receipt is authoritative / terminal execution with a stale host) were
  // quarantined WHOLE-DIRECTORY as FLAKY by CI-02 ("whole suite churns
  // run-to-run"); re-validated 2026-08-25 on this baseline they are
  // deterministic-green — each in isolation (75-83s) AND in the exact hosted
  // form below (one node --test process, concurrency 1, 4/4 in 294s). The
  // STAGE-23 precedent (development-task-graph-diagnostics de-quarantine):
  // quarantine entries must be revalidated when their subject moves. The
  // REMAINING factory-temporal L3 composition suites stay quarantined (see
  // QUARANTINE) — only the crash-edge files split out. Exact files on
  // purpose: the hosted fault-edge surface cannot silently widen. Per-file
  // removal guard G2t in tests/infrastructure/acceptance-matrix-coverage.test.mjs.
  'k4-fault-edges': {
    globs: [
      'tests/factory-temporal/worker-boundary-1-exit-pre-submit.test.mjs',
      'tests/factory-temporal/worker-boundary-2-exit-post-submit.test.mjs',
      'tests/factory-temporal/worker-boundary-3-receipt-authoritative.test.mjs',
      'tests/factory-temporal/worker-boundary-4-stale-host.test.mjs',
    ],
    concurrency: 1,
    note: 'ADR-096 gate item 2 — the ADR-048 worker-boundary crash edges BLOCKING (exit pre-submit / exit post-submit / authoritative receipt / stale host): every crash converges to progress, typed wait or terminal incident (CONVEYOR §23 L4). De-quarantined 2026-08-25 after per-file revalidation (green in isolation AND hosted form).',
  },
  'matrix-coverage': {
    globs: ['tests/infrastructure/acceptance-matrix-coverage.test.mjs'],
    note: 'CI-02 self-check — matrix completeness + no-hidden-failure guard',
  },
  // ADR-092 / CC-U1: the CC closure proof-hosting registry. EXACT FILE on
  // purpose (no directory glob): the run-set of this group must equal the
  // manifest's blocking rows pinned to it (tools/cc-proof-hosting-registry.mjs
  // proves the bijection), so the hosted CC proof-registry surface cannot
  // silently widen or shrink.
  'cc-proof-registry': {
    globs: ['tests/infrastructure/cc-proof-hosting.test.mjs'],
    note: 'CC-U1/ADR-092 proof-hosting registry — bidirectional closure between the CC critical proof manifest and the CI-invoked blocking matrix groups',
  },
  'factory-proof': {
    globs: [
      'tests/factory-proof/canonical-composition.test.mjs',
      'tests/factory-proof/import-ratchet.test.mjs',
      'tests/factory-proof/obligation-compiler.test.mjs',
      'tests/factory-proof/scenario-actor-observer.test.mjs',
      'tests/factory-proof/kernel-self-mutations.test.mjs',
      'tests/factory-proof/w1-1-fabricated-hash.test.mjs',
      'tests/factory-proof/w1-4-two-lifecycles.test.mjs',
      'tests/factory-proof/k2-spawned-actor.test.mjs',
      'tests/factory-proof/k2-strict-formalization.test.mjs',
      'tests/factory-proof/proof-claims.test.mjs',
      'tests/factory-proof/k0-baseline.test.mjs',
      // CC-10A provisional 23-file floor: the Conformance Engine v1 measuring
      // surface. All Contract-level closure checks (packs validated as data,
      // evidence/universe algebra, registry honesty) — the drives with the
      // multi-phase 61s proofs stay in the manual harvest path, NOT here.
      'tests/factory-proof/conformance-engine.test.mjs',
      'tests/factory-proof/coverage-kernel.test.mjs',
      // ADR-096 gate item 2 (W3, 2026-08-25): the MEASURED, NON-ZERO,
      // deterministic mutation-kill floor — 21 declared architectural-ban
      // mutants (execution-scoped lookup, latest-wins selection, scope-fence
      // bypass, authority digest skip) killed by real dist/ boundaries
      // through the shared mutation algebra. Exact file on purpose; removal
      // guard G2u in tests/infrastructure/acceptance-matrix-coverage.test.mjs.
      'tests/factory-proof/mutation-kill-floor.test.mjs',
      'tests/factory-proof/delivery-kernel-unification.test.mjs',
      'tests/factory-proof/development-scenario-pack.test.mjs',
      'tests/factory-proof/discovery-resilience-pack.test.mjs',
      'tests/factory-proof/discovery-scenario-pack.test.mjs',
      'tests/factory-proof/factory-coverage-universe.test.mjs',
      'tests/factory-proof/formalization-resilience-pack.test.mjs',
      'tests/factory-proof/scenario-evidence.test.mjs',
      'tests/factory-proof/scenario-runner.test.mjs',
      'tests/factory-proof/workshop-descriptor.test.mjs',
      'tests/factory-proof/workshop-inventory.test.mjs',
    ],
    note: 'W0 proof kernel + W1-1 reference causal vertical (ADR-084) + W1-4 two-lifecycle composition (ADR-078) + the Conformance Engine v1 measuring surface (CC-10A provisional ratchet; final K5 lands at CC-10B) — canonical composition, obligation contracts, mutation algebra/kill matrix, scenario DSL/actor/observer, self-mutations, fabricated-derived-evidence causal proof, pack/evidence/universe closure. BLOCKING: no quarantine, no continue-on-error.',
  },
};

// --- Quarantine -------------------------------------------------------------
// Every entry is EXCLUDED from the blocking matrix. Two kinds:
//   FLAKY            — non-deterministic (orchestrate-cli replay / temporal).
//   PRE-EXISTING-RED — deterministically red on the baseline; fails identically
//                      on a clean checkout (stale ref, deleted module, C5 cutover).
// Replacement for the flaky orchestrate-cli/replay-driven suites: the fresh W9
// scripted E2E harness (cards W9-01..W9-04) is their deterministic successor.
//
// NOTE: tests/dispatcher-race/worktree-isolation.mjs is ALSO quarantined but is
// a plain .mjs script (not a *.test.mjs), so it is excluded from the
// dispatcher-race CI step directly in ci.yml, not here. See the coverage test.
const QUARANTINE = [
  { glob: 'tests/factory-contract/golden-path.test.mjs',
    kind: 'FLAKY',
    reason: 'drives orchestrate-cli; REPLAY_CAPSULE_CONTEXT_INVALID (passes ~1/3). W9 scripted E2E replaces it.' },
  { glob: 'tests/factory-contract/parallel-git-desk.test.mjs',
    kind: 'FLAKY',
    reason: 'drives orchestrate-cli (concurrency=2 worktree isolation); REPLAY_CAPSULE_CONTEXT_INVALID. W9 scripted E2E replaces it.' },
  // factory-temporal — the four ADR-048 worker-boundary CRASH suites were
  // DE-QUARANTINED 2026-08-25 (ADR-096 gate item 2): re-validated green in
  // isolation AND in the hosted k4-fault-edges group form; they now run
  // BLOCKING (per-file guard G2t). The directory glob is replaced by the
  // explicit remaining L3 composition files so the de-quarantine cannot
  // accidentally re-admit a churny file (STAGE-23 precedent: quarantine
  // entries must be revalidated when their subject moves).
  { glob: 'tests/factory-temporal/candidate-gate.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  { glob: 'tests/factory-temporal/dispatch-concurrency.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  { glob: 'tests/factory-temporal/external-effects.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  { glob: 'tests/factory-temporal/foundation.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  { glob: 'tests/factory-temporal/lifecycle-routing.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  { glob: 'tests/factory-temporal/package-replay-drift.test.mjs',
    kind: 'FLAKY',
    reason: 'L3 temporal composition churns run-to-run (orchestrate-cli driven). W9 scripted E2E replaces its lane; the worker-boundary crash edges were split out into the blocking k4-fault-edges group 2026-08-25.' },
  // STAGE-23 (2026-08-24): tests/process-modules/development-task-graph-diagnostics.test.mjs
  // was de-quarantined — re-validated GREEN (2/2, exit 0) on the current
  // baseline; the 'stale producerExecutionRef mock' rotted away upstream but
  // the quarantine was never re-checked (the R2 defect in the red-team
  // audit). Quarantine entries must be revalidated when their subject moves.
  { glob: 'tests/architecture/submission-validator-diagnostics.test.mjs',
    kind: 'PRE-EXISTING-RED',
    reason: 'assertion mismatch (outcome expected "failed", got undefined) on a clean checkout.' },
  { glob: 'tests/infrastructure/local-runnability-check-provider.test.mjs',
    kind: 'FLAKY',
    reason: 'real command/process execution (npm/node on a fixture); cold-start timing produces outcome=undefined ~1/4 runs (e.g. LR-06 "error receipt not replayed" re-run path). LR-01..06 semantics are validated in isolation; the file is non-deterministic at the matrix level. served-process-runner.test.mjs is also real-process and kept out of the blocking matrix for the same reason. Stabilize the cold-start race (or split the deterministic replay tests out) to re-admit.' },
];

// --- glob expansion (single-level '*', no deps) -----------------------------
function expandGlob(pattern) {
  const parts = pattern.split('/');
  let current = [root];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    const re = seg.includes('*')
      ? new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      : null;
    const next = [];
    for (const dir of current) {
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (re ? re.test(entry) : entry === seg) {
          const p = path.join(dir, entry);
          try {
            const st = statSync(p);
            if (isLast ? st.isFile() : st.isDirectory()) next.push(p);
          } catch { /* skip */ }
        }
      }
    }
    current = next;
  }
  return current.sort();
}

const toPosix = p => path.relative(root, p).split(path.sep).join('/');

// Quarantined absolute paths (single source of truth).
const quarantinedAbs = new Map();
for (const q of QUARANTINE) {
  for (const p of expandGlob(q.glob)) quarantinedAbs.set(p, q);
}

function groupFiles(name) {
  const def = GROUPS[name];
  const seen = new Set();
  const files = [];
  for (const g of def.globs) {
    for (const p of expandGlob(g)) {
      if (quarantinedAbs.has(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      files.push(p);
    }
  }
  return files;
}

// --- --list: coverage proof (consumed by the coverage test) -----------------
function printList() {
  const groupNames = Object.keys(GROUPS);
  let totalRun = 0;
  for (const name of groupNames) {
    const files = groupFiles(name);
    totalRun += files.length;
    console.log(`[group] ${name} — ${GROUPS[name].note}`);
    for (const f of files) console.log(`  [run] ${toPosix(f)}`);
  }
  // Quarantined files that exist on disk (prove each is a real, deliberate skip).
  const qExisting = [];
  for (const [abs, q] of quarantinedAbs) {
    if (existsSync(abs)) qExisting.push({ abs, q });
  }
  for (const { abs, q } of qExisting) {
    console.log(`[quarantine] ${toPosix(abs)} :: ${q.kind} :: ${q.reason}`);
  }
  // Also list quarantine globs that matched nothing yet (e.g. factory-temporal
  // when run from a checkout that lacks them) so nothing is silently dropped.
  for (const q of QUARANTINE) {
    const matched = expandGlob(q.glob);
    if (matched.length === 0) {
      console.log(`[quarantine-empty-glob] ${q.glob} :: ${q.kind} :: ${q.reason}`);
    }
  }
  console.log(`[summary] groups=${groupNames.length} run-files=${totalRun} quarantined-files=${qExisting.length}`);
}

// --- --list-json: machine-readable matrix export (ADR-092) ------------------
// The structured group registry consumed by validation/tests. Same truth as
// --list (identical expansion, identical quarantine), stable shape:
//   { schemaVersion, groups: { <name>: { files[], concurrency, note } },
//     quarantine: [{ path, kind, reason }], quarantineEmptyGlobs: [...] }
// Globs stay INTERNAL: only the expanded run-set is exported, so a consumer
// can never mistake a declared glob for a proof that CI actually runs.
function buildMatrixExport() {
  const groups = {};
  for (const name of Object.keys(GROUPS)) {
    groups[name] = {
      files: groupFiles(name).map(toPosix),
      concurrency: GROUPS[name].concurrency ?? null,
      note: GROUPS[name].note,
    };
  }
  const quarantine = [];
  for (const [abs, q] of quarantinedAbs) {
    if (existsSync(abs)) {
      quarantine.push({ path: toPosix(abs), kind: q.kind, reason: q.reason });
    }
  }
  const quarantineEmptyGlobs = QUARANTINE
    .filter((q) => expandGlob(q.glob).length === 0)
    .map((q) => ({ glob: q.glob, kind: q.kind, reason: q.reason }));
  return {
    schemaVersion: 1,
    groups,
    quarantine,
    quarantineEmptyGlobs,
  };
}

// --- run --------------------------------------------------------------------
function runGroup(name) {
  const files = groupFiles(name);
  if (files.length === 0) {
    console.error(`[acceptance-matrix:${name}] no files matched (glob drifted?) — BLOCKING`);
    process.exit(1);
  }
  const concurrency = GROUPS[name].concurrency;
  const args = ['--test'];
  if (concurrency) args.push(`--test-concurrency=${concurrency}`);
  args.push(...files);
  console.log(`\n[acceptance-matrix:${name}] ${files.length} file(s)${concurrency ? ' (concurrency=1)' : ''}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[acceptance-matrix:${name}] FAILED (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  printList();
  process.exit(0);
}
if (args.includes('--list-json')) {
  console.log(JSON.stringify(buildMatrixExport(), null, 2));
  process.exit(0);
}

const groupIdx = args.indexOf('--group');
const requested = groupIdx >= 0 ? args[groupIdx + 1] : null;
if (requested !== null) {
  if (!Object.hasOwn(GROUPS, requested)) {
    console.error(`Unknown group '${requested}'. Known: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  ensureDist();
  runGroup(requested);
  process.exit(0);
}

ensureDist();
for (const name of Object.keys(GROUPS)) runGroup(name);
console.log('\n[acceptance-matrix] all groups green');
