// tests/factory-proof/development-scenario-pack.mjs
//
// Development workshop pack for the unified Saga conformance kernel —
// TRANCHE D-A (night 2026-08-22): topology inventory + the positive spine.
//
// The pack owns only deterministic cognition stimuli, independent oracles
// and coverage declarations. All Workplace/CandidateSet/Gate/review/effect/
// git-integration/verification/settlement authority remains in the
// production Factory (guides: WORKSHOP-CONFORMANCE-PACK-AUTHORING-GUIDE §9,
// WORKSHOP-CONFORMANCE-COVERAGE-AGENT-GUIDE §9).
//
// HONEST SCOPE: this tranche proves the positive spine end-to-end
// (Formalization --exact--> Development --verified--> runnable-local).
// The full D0–D10 universe (negatives, fan-out physics, effects, restarts,
// continuations) is DECLARED below but not yet authored — Development is
// NOT closed until every required item has PASS evidence (§13 closure rule).

import {
  W9_HAPPY_HANDLERS,
  makeDevelopmentImplementHandler,
  makeDevelopmentPlanHandler,
  makeOneContainerAcceptanceHandler,
} from '../factory-e2e/w9-happy-handlers.mjs';
import { coverageToken } from './coverage-kernel.mjs';

export const DEVELOPMENT_STAGE = 'solution-development';
export const FORMALIZATION_STAGE = 'solution-formalization';
export const DEV_MODULE = 'solution-development@1.4.4';

// --- Topology inventory (authoring guide §Step 1, read from the module) ---
export const DEVELOPMENT_TOPOLOGY = Object.freeze({
  moduleRef: DEV_MODULE,
  nodes: Object.freeze([
    Object.freeze({ id: 'plan-task-graph', kind: 'production-cell', cell: 'development-plan-task-graph', roles: ['author'] }),
    Object.freeze({ id: 'resolve-task-graph', kind: 'kernel', handler: 'development-task-graph-validation@2.0.0' }),
    Object.freeze({ id: 'implement-work-items', kind: 'production-cell', cell: 'development-implementation', fanOut: 'workItems', roles: ['author', 'reviewer'] }),
    Object.freeze({ id: 'freeze-integrated-candidate', kind: 'kernel' }),
    Object.freeze({ id: 'certify-product-readiness', kind: 'production-cell', cell: 'development-readiness-certification', roles: ['author'] }),
    Object.freeze({ id: 'bind-runnable-candidate', kind: 'kernel' }),
    Object.freeze({ id: 'verify-acceptance', kind: 'production-cell', cell: 'development-verification', fanOut: 'verificationItems', roles: ['author'] }),
    Object.freeze({ id: 'settle-development', kind: 'kernel', handler: 'development-settlement@1.0.0' }),
  ]),
  outcomes: Object.freeze(['verified', 'blocked', 'failed']),
  installedVariants: Object.freeze([
    'solution-development-managed@1.1.0',
    'solution-development-managed@1.2.0',
    'solution-development-verification-continuation@1.0.0',
  ]),
});

// --- Oracles (read ONLY real authority tables via the shared observer) ---

function stageOutcomeOracle(stageId, expectedOutcome) {
  return {
    id: `development.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === stageId && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { stageId, expectedOutcome, count: rows.length },
      };
    },
  };
}

function cellAcceptedOracle(cellFragment) {
  return {
    id: `development.${cellFragment}.accepted`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? []).filter(row =>
        String(row.workplace_ref).includes(cellFragment)
        && row.gate_phase === 'final' && row.verdict === 'accepted');
      const workplaces = new Set(rows.map(row => String(row.workplace_ref)));
      // Fan-out cells accept per work item: every materialized workplace of
      // the cell must have its own final acceptance.
      const materialized = (durableTrace.workplaces ?? [])
        .filter(row => String(row.workplace_ref).includes(cellFragment));
      return {
        passed: rows.length > 0 && workplaces.size === materialized.length,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: {
          acceptedWorkplaces: workplaces.size,
          materializedWorkplaces: materialized.length,
        },
      };
    },
  };
}

/**
 * D0 — the exact Formalization → Development handoff (authoring guide §9.3):
 * upstream mapped_output_snapshot == downstream input_snapshot on the
 * authority-bearing fields (certificate schema/ref/hash, solution contract,
 * baseline hash, SRS projection, acceptance criteria).
 */
function exactFormalizationHandoffOracle() {
  return {
    id: 'development.handoff-exact.formalization',
    evaluate({ durableTrace }) {
      const formalization = (durableTrace.stageRuns ?? [])
        .find(row => row.stage_id === FORMALIZATION_STAGE && row.local_outcome === 'formalized');
      if (!formalization) return { passed: false, details: { reason: 'formalization stage missing' } };
      const transition = (durableTrace.processTransitions ?? [])
        .find(row => row.from_stage_run_id === formalization.id
          && row.outcome === 'formalized'
          && row.target_type === 'stage'
          && row.target_stage_id === DEVELOPMENT_STAGE);
      if (!transition) {
        return { passed: false, details: { reason: 'formalization->development transition missing' } };
      }
      const development = (durableTrace.stageRuns ?? [])
        .find(row => row.id === transition.to_stage_run_id && row.stage_id === DEVELOPMENT_STAGE);
      if (!development) return { passed: false, details: { reason: 'development stage missing' } };
      const parse = value => {
        if (typeof value !== 'string' || value.length === 0) return null;
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch { return null; }
      };
      const mapped = parse(formalization.mapped_output_snapshot);
      const input = parse(development.input_snapshot);
      if (!mapped || !input) return { passed: false, details: { reason: 'unparseable snapshots' } };
      const payload = mapped.solutionContractPayload;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const checks = {
        decision: mapped.decision === 'formalized'
          && input.formalizationCertificate?.decision === 'formalized',
        certificateRef: mapped.certificate?.ref === input.formalizationCertificate?.ref,
        certificateHash: mapped.certificate?.hash === input.formalizationCertificate?.hash,
        solutionRef: mapped.solutionContract?.ref === input.solutionContract?.ref,
        solutionHash: mapped.solutionContract?.hash === input.solutionContract?.hash,
        baselineHash: payload?.bundle?.acceptanceBaselineHash === input.acceptanceBaselineHash,
        srs: same(payload?.srs, input.srs),
        acceptanceCriteria: same(payload?.acceptanceCriteria, input.acceptanceCriteria),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        passed: failed.length === 0,
        evidenceRefs: [`stage-run:${formalization.id}`, `lifecycle-transition:${transition.id}`, `stage-run:${development.id}`],
        details: { failed, transitionKey: transition.transition_key, handoffHash: transition.handoff_hash },
      };
    },
  };
}

function certificateOracle() {
  return {
    id: 'development.certificate.verified',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.processOutcomeCertificates ?? [])
        .filter(row => String(row.module_ref_key).includes('development')
          && row.decision === 'verified');
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `process-certificate:${row.id}`),
        details: { count: rows.length },
      };
    },
  };
}

function noStrandedExecutionOracle() {
  return {
    id: 'factory.no-stranded-worker-executions',
    evaluate({ result }) {
      return {
        passed: result.strandedActiveExecutions === 0,
        details: { strandedActiveExecutions: result.strandedActiveExecutions },
      };
    },
  };
}

// --- Scenarios ---

function positiveSpineCoverage() {
  return [
    coverageToken.obligation('dev.task-graph'),
    coverageToken.obligation('dev.impl-scope'),
    coverageToken.obligation('dev.readiness-monotonicity'),
    coverageToken.obligation('factory.local-runnability'),
    coverageToken.transition('plan-task-graph', 'resolve-task-graph'),
    coverageToken.transition('implement-work-items', 'freeze-integrated-candidate'),
    coverageToken.transition('certify-product-readiness', 'bind-runnable-candidate'),
    coverageToken.transition('verify-acceptance', 'settle-development'),
    coverageToken.transition('settle-development', 'complete-verified'),
    'handoff:solution-formalization->solution-development:formalized',
    'fanout:development-implementation:per-work-item-workplace',
    'fanin:development-settlement:all-required-accepted',
    'effect:git-integration:after-final-acceptance',
  ];
}

export const DEVELOPMENT_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/happy-verified',
    kind: 'positive',
    proves: [
      'dev.task-graph',
      'dev.impl-scope',
      'dev.readiness-monotonicity',
      'factory.local-runnability',
    ],
    coverageItems: positiveSpineCoverage(),
  }),
  // D2 fan-out scheduling, ORDER half (split from the cap): the W9 graph
  // chains every implementation item (impl-N depends on impl-N-1). The
  // scheduler must start each dependent execution only after its dependency's
  // final acceptance. (The chain's peak is structurally 1 — the concurrency
  // CAP is proven by the parallel-burst scenario, not here.)
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/fanout-scheduling-order-capped',
    kind: 'positive',
    proves: ['dev.task-graph'],
    coverageItems: ['D2:fanout-scheduling:dependency-order-respected'],
  }),
  // D2 fan-out scheduling, CAP half: A → {B, C, D} with three simultaneously
  // runnable siblings and the factory cap at 2 — the observed peak MUST be
  // exactly 2. Removing the concurrency limiter would yield peak 3 and kill
  // this oracle (the chain graph could never detect that mutation).
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/fanout-concurrency-cap-limits-parallel-runnable',
    kind: 'positive',
    proves: ['dev.task-graph'],
    coverageItems: ['D2:fanout-scheduling:concurrency-cap-never-exceeded'],
  }),
  // D2 fan-in discipline: settlement is ALL-required — the development run
  // may not settle (its final product may not exist) before EVERY required
  // work-item workplace (implementation AND verification) holds a final
  // acceptance. Early fan-in is blocked.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/fanin-all-required-before-settlement',
    kind: 'positive',
    proves: ['dev.task-graph'],
    coverageItems: ['D2:fanin:completion-policy-all-blocks-early-fanin'],
  }),
  // D3 implementation-scope fence: the first implementation writes a file
  // OUTSIDE every declared changeScope (truthfully declared in changedFiles —
  // the mismatch check passes, the OFFENSE is purely scope). The gate must
  // reject on the scope check, the repair must land in-scope, and the
  // workplace must still reach final acceptance.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/impl-scope-outside-rejected-repaired',
    kind: 'positive',
    proves: ['dev.impl-scope'],
    coverageItems: ['D3:impl-scope:file-outside-effective-scope-rejected'],
  }),
  // U_contract_partitions: the SAME atomic AC set packaged as ONE container
  // document (the lawful formalization shape that killed Elite-4) must
  // preserve criterion cardinality downstream — TWO atomic criteria, TWO
  // verification workplaces, TWO distinct identities — and the lifecycle
  // still reaches verified.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/acceptance-packaging-one-container',
    kind: 'positive',
    proves: ['dev.task-graph'],
    coverageItems: ['contract-partition:acceptance-criteria:packaging-invariant'],
  }),
]);

// EXHAUSTIVE by construction (operator completion order 2026-08-22): the
// required universe is the union of EVERY declared scenario's coverageItems.
// A landed obligation can never silently fall out of the denominator — new
// scenarios extend U automatically, and the demonstrated layer decides
// coverage from PASS bundles only.
export const DEVELOPMENT_REQUIRED_UNIVERSE = Object.freeze([
  ...[...new Set(DEVELOPMENT_SCENARIOS.flatMap(
    scenario => scenario.coverageItems ?? [],
  ))].sort(),
  // U_contract_partitions: lawful producer data-shape equivalence classes
  // across the handoff (the Elite-4 defect class).
]);

// --- Planned (not yet demonstrated) universe — honest tranche boundary ---

// DEMONSTRATED (landed) Development obligations — MOVED here from the
// pending universe as their scenarios passed through the unified kernel.
// The universe is monotonic: a landed token never leaves U (operator
// review 2026-08-22 — the denominator must not shrink as coverage grows).


export const DEVELOPMENT_PENDING_UNIVERSE = Object.freeze([
  // STRONG cap invariant stays pending (operator review 2026-08-22): the
  // demonstrated proof is peak<=cap over a 3-runnable graph; exact peak==cap
  // emergence is timing-dependent in this harness, so 'limits-parallel-
  // runnable' is NOT claimed proven. The weak 'never-exceeded' form is
  // demonstrated above.
  'D2:fanout-scheduling:concurrency-cap-limits-parallel-runnable',
  // Found live by the delivery restart proof (2026-08-22): a replayed
  // git-change work item carries the capsule's original commitSha, but the
  // fresh execution's desk froze a NEW effective base — the implementation-
  // scope check's merge-base discipline then rejects the replay. Cross-
  // lifecycle replay semantics for desk-bound git-change cells is an open
  // Development-universe item, NOT a delivery concern.
  'restart:development:git-change-desk-replay',
  'D2:sibling-isolation:accepted-sibling-conserved-during-repair',
  'D3:claim-monotonicity:silent-narrowing-rejected',
  'D4:review:changes-returns-to-same-workplace-author',
  'D4:git-effect:integration-only-after-final-acceptance',
  'D4:git-effect:redrive-idempotent',
  'D5:freeze:frozen-candidate-content-addressed-and-immutable',
  'D6:readiness:declared-source-mismatch-rejected',
  'D7:bind:stale-readiness-hash-failed',
  'D8:verification:evidence-pins-exact-candidate-hash',
  'D8:verification:upstream-defect-routes-to-settlement',
  'D9:settlement:blocked-and-failed-outcomes',
  'D10:continuation:managed-source-author-no-git-authority',
  'D10:replan:superseded-tasks-not-claimable',
  'restart:development:idempotent-redrive',
  'feedback:development:exact-repairs-and-absent-does-not',
]);

export const DEVELOPMENT_PLATFORM_FAULT_EDGES = Object.freeze([
  'K4:git-effect:crash-after-external-mutation-before-receipt',
  'K4:settlement:internal-exception-complete-failed',
]);

// Normalize the trace's mixed timestamp formats (SQLite UTC
// 'YYYY-MM-DD HH:MM:SS' vs ISO-8601 '...Z') to epoch ms so ordering
// oracles compare real instants, not string shapes.
function traceTimeToMs(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  const sqlite = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (sqlite) {
    return Date.UTC(
      Number(sqlite[1]), Number(sqlite[2]) - 1, Number(sqlite[3]),
      Number(sqlite[4]), Number(sqlite[5]), Number(sqlite[6]),
    );
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

// One-container packaging map: W9 happy everywhere EXCEPT the formalization
// acceptance cell, which writes ONE AC document carrying BOTH atomic
// criteria (the lawful container shape of the Elite-4 incident).
function buildOneContainerHandlers() {
  const handlers = { ...W9_HAPPY_HANDLERS };
  const acceptanceKey = Object.keys(handlers)
    .find(key => key.includes('define-acceptance-contract/author'));
  handlers[acceptanceKey] = makeOneContainerAcceptanceHandler();
  return handlers;
}

// Cap-proof handler map: W9 happy everywhere EXCEPT the planner, which
// emits the parallel-burst topology (root A with mandated shared scopes;
// N extra single-file siblings all depending on A only).
function buildParallelBurstHandlers(burstSize) {
  const handlers = { ...W9_HAPPY_HANDLERS };
  const planKey = Object.keys(handlers)
    .find(key => key.includes('plan-task-graph/author'));
  handlers[planKey] = makeDevelopmentPlanHandler({ parallelBurst: burstSize });
  return handlers;
}

// D3 fault map: the FIRST implementation-author invocation writes outside
// every declared scope; the REPAIR invocation returns to the in-scope path
// WITH the lawful droppedFiles disposition (claim-monotonicity's documented
// exit — a drop is legal only with an explicit reason); every later chain
// item uses the normal W9 path.
function buildScopeFaultHandlers() {
  const handlers = { ...W9_HAPPY_HANDLERS };
  const authorKey = Object.keys(handlers)
    .find(key => key.includes('implement-work-items/author'));
  const inScope = handlers[authorKey];
  let phase = 0;
  let roguePath = null;
  let inScopePath = null;
  handlers[authorKey] = ctx => {
    phase += 1;
    const item = ctx.meta?.cell_input_item
      ?? (Array.isArray(ctx.meta?.process_node_input)
        ? ctx.meta.process_node_input.find(x => x?.kind === 'implementation')
        : undefined);
    const safe = String(item?.key ?? '').replace(/[^a-zA-Z0-9._-]/g, '-');
    if (phase === 1) {
      roguePath = `rogue/outside/${safe}.ts`;
      return makeDevelopmentImplementHandler(() => roguePath)(ctx);
    }
    if (phase === 2) {
      inScopePath = `src/w9/${safe}.ts`;
      return makeDevelopmentImplementHandler(
        () => inScopePath,
        () => [{
          path: roguePath,
          reason: 'repaired: the rejected attempt wrote outside the frozen authority; '
            + 'the lawful in-scope implementation replaces it',
        }],
      )(ctx);
    }
    return inScope(ctx);
  };
  return handlers;
}

const byId = new Map(DEVELOPMENT_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildDevelopmentRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(`DEVELOPMENT_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`);
  }
  switch (id) {
    case 'development/happy-verified':
      return {
        scenario,
        // The W9 happy map covers the whole product-build lifecycle through
        // Development (planner, implement fan-out, review, readiness,
        // verification fan-out) — the spine drives the REAL production
        // handlers to the lifecycle's natural terminal (runnable-local).
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          exactFormalizationHandoffOracle(),
          cellAcceptedOracle('development-plan-task-graph'),
          cellAcceptedOracle('development-implementation'),
          cellAcceptedOracle('development-readiness-certification'),
          cellAcceptedOracle('development-verification'),
          certificateOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    case 'development/fanout-scheduling-order-capped':
      return {
        scenario,
        // Same W9 chain graph as the spine: impl-N depends on impl-N-1.
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          {
            // Dependency order (ORDER half of the D2 split): each
            // implementation execution starts only after the PREVIOUS chain
            // item's final acceptance. All comparisons run through
            // traceTimeToMs — the trace mixes ISO-Z and SQLite timestamps.
            id: 'development.fanout.dependency-order',
            evaluate({ durableTrace }) {
              const tasks = durableTrace.workIntents ?? [];
              const implTasks = tasks
                .filter(t => t.task_kind === 'development.code')
                .sort((a, b) => (traceTimeToMs(a.created_at) ?? 0)
                  - (traceTimeToMs(b.created_at) ?? 0));
              const executions = durableTrace.workerExecutions ?? [];
              const acceptances = new Map(
                (durableTrace.finalAcceptances ?? [])
                  .map(row => [row.workplace_ref, traceTimeToMs(row.accepted_at)]));
              const byTask = new Map(executions.map(e => [e.task_id, e]));
              const violations = [];
              for (let i = 1; i < implTasks.length; i += 1) {
                const prev = implTasks[i - 1];
                const next = implTasks[i];
                const prevAccepted = acceptances.get(prev.workplace_ref);
                const nextStart = traceTimeToMs(byTask.get(next.id)?.started_at);
                if (prevAccepted === undefined || nextStart === null) {
                  violations.push({ pair: [prev.id, next.id], missing: true });
                } else if (nextStart < prevAccepted) {
                  violations.push({
                    pair: [prev.id, next.id],
                    startedAt: nextStart,
                    prevAccepted,
                  });
                }
              }
              return {
                passed: violations.length === 0,
                evidenceRefs: implTasks.map(t => `task:${t.id}`),
                details: { chainLength: implTasks.length, violations },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'development/fanout-concurrency-cap-limits-parallel-runnable':
      return {
        scenario,
        // Cap-proof topology: A → {B, C, D} (one mandated-scope root, three
        // disjoint single-file siblings). After A is accepted, THREE
        // implementations are simultaneously runnable while the factory cap
        // is 2 — the limiter is the only possible bound on the peak.
        handlers: Object.freeze(buildParallelBurstHandlers(2)),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          {
            // The cap's INVARIANT: with 3 simultaneously runnable siblings
            // the observed peak may never exceed the cap. (Exact-peak
            // pinning is NOT asserted: whether concurrency materializes at
            // all is timing-dependent in this harness — siblings may
            // legitimately serialize. The sweep is start-sorted with
            // truncation-clamped ends; inverted or unsorted intervals
            // produce phantom overlaps and false violations.)
            id: 'development.fanout.cap-limits-parallel-runnable',
            evaluate({ durableTrace, result }) {
              const implExecs = (durableTrace.workerExecutions ?? [])
                .filter(e => {
                  const task = (durableTrace.workIntents ?? [])
                    .find(t => t.id === e.task_id);
                  return task?.task_kind === 'development.code';
                })
                .map(e => {
                  const start = traceTimeToMs(e.started_at);
                  const rawEnd = traceTimeToMs(e.finished_at);
                  // created_at-style columns truncate to seconds — an end
                  // before its own start is truncation, clamp to start.
                  const end = rawEnd === null || rawEnd < start ? start : rawEnd;
                  return { start, end };
                })
                .filter(e => e.start !== null)
                .sort((a, b) => a.start - b.start);
              const cap = result?.effectiveConcurrency ?? null;
              let peak = 0;
              const open = [];
              for (const e of implExecs) {
                while (open.length > 0 && open[0] <= e.start) open.shift();
                open.push(e.end);
                open.sort((a, b) => a - b);
                peak = Math.max(peak, open.length);
              }
              const siblingsRunnable = implExecs.length >= 3;
              return {
                passed: cap !== null && siblingsRunnable && peak <= cap,
                evidenceRefs: implExecs.map((_, i) => `impl-execution:${i}`),
                details: {
                  implementationExecutions: implExecs.length,
                  threeSiblingsRunnable: siblingsRunnable,
                  peakConcurrentImplementations: peak,
                  cap,
                  exactPeakEmergence: peak === cap,
                  note: 'peak==cap is timing-dependent and deliberately NOT '
                    + 'asserted; the invariant is peak<=cap over a graph '
                    + 'where 3 siblings are runnable',
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'development/fanin-all-required-before-settlement':
      return {
        scenario,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          {
            // Fan-in is ALL-required, pinned through the FROZEN candidate
            // chain (certificate timestamps are second-truncated; sub-second
            // ordering vs the last acceptances is not observable): the
            // integrated-candidate product (the freeze) may only exist after
            // every implementation workplace is accepted, and the settlement
            // certificate must bind EXACTLY that frozen candidate hash.
            id: 'development.fanin.settlement-binds-all-accepted-candidate',
            evaluate({ durableTrace }) {
              const devWorkplaces = new Set(
                (durableTrace.workplaces ?? [])
                  .filter(w => String(w.workplace_ref).includes('solution-development'))
                  .map(w => w.workplace_ref));
              const acceptances = new Map(
                (durableTrace.finalAcceptances ?? [])
                  .filter(row => devWorkplaces.has(row.workplace_ref))
                  .map(row => [row.workplace_ref, traceTimeToMs(row.accepted_at)]));
              const implAcc = [...acceptances.entries()]
                .filter(([ref]) => ref.includes('development-implementation'));
              const freeze = (durableTrace.processProducts ?? [])
                .find(p => p.product_kind === 'development.integrated-candidate');
              // +999ms: created_at truncates to seconds, accepted_at keeps ms.
              const freezeAtMs = freeze ? traceTimeToMs(freeze.created_at) : null;
              const implsBeforeFreeze = freezeAtMs !== null
                && implAcc.length > 0
                && implAcc.every(([, at]) => at !== null && at <= freezeAtMs + 999);
              const cert = (durableTrace.processOutcomeCertificates ?? [])
                .find(row => String(row.module_name).includes('development'));
              let bindsFrozenCandidate = false;
              try {
                const payload = cert ? JSON.parse(String(cert.certificate_payload)) : null;
                bindsFrozenCandidate = payload !== null
                  && payload?.payload?.candidateHash === freeze?.product_hash
                  && payload?.decision === 'verified';
              } catch {
                bindsFrozenCandidate = false;
              }
              const notAccepted = [...devWorkplaces]
                .filter(ref => !acceptances.has(ref));
              return {
                passed: notAccepted.length === 0
                  && implsBeforeFreeze
                  && bindsFrozenCandidate,
                evidenceRefs: [
                  ...implAcc.map(([ref]) => `workplace:${ref}`),
                  ...(freeze ? [`process-product:${freeze.id}`] : []),
                  ...(cert ? [`outcome-certificate:${cert.id}`] : []),
                ],
                details: {
                  developmentWorkplaces: devWorkplaces.size,
                  accepted: acceptances.size,
                  notAccepted,
                  implementationsAcceptedBeforeFreeze: implsBeforeFreeze,
                  settlementBindsFrozenCandidate: bindsFrozenCandidate,
                  frozenCandidateHash: freeze?.product_hash ?? null,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'development/impl-scope-outside-rejected-repaired':
      return {
        scenario,
        // First implementation invocation writes rogue/outside/<item>.ts —
        // outside every declared changeScope. The scope check rejects; the
        // repair invocation returns to the in-scope path and the flow
        // completes normally.
        handlers: Object.freeze(buildScopeFaultHandlers()),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          {
            // The fence fired: an implementation workplace holds a
            // repair_required gate decision and failed check receipts (the
            // implementation-scope and claim-monotonicity providers) against
            // its sealed candidate — the rogue attempt was judged, not waved
            // through.
            id: 'development.impl-scope.rogue-rejected',
            evaluate({ durableTrace }) {
              const implWorkplaces = new Set(
                (durableTrace.workplaces ?? [])
                  .filter(w => String(w.workplace_ref).includes('development-implementation'))
                  .map(w => w.workplace_ref));
              const repairGates = (durableTrace.gateDecisions ?? [])
                .filter(g => g.verdict === 'repair_required'
                  && implWorkplaces.has(g.workplace_ref));
              const failedReceipts = (durableTrace.checkReceipts ?? [])
                .filter(r => r.outcome !== 'passed'
                  && String(r.subject_candidate_set_ref).includes('development-implementation')
                  && /implementation-(scope|claim-monotonicity)\.v1$/.test(String(r.provider_id)));
              return {
                passed: repairGates.length > 0 && failedReceipts.length > 0,
                evidenceRefs: [
                  ...repairGates.map(g => `gate:${g.decision_key}`),
                  ...failedReceipts.map(r => `check:${r.check_receipt_ref}`),
                ],
                details: {
                  repairRequiredGateDecisions: repairGates.length,
                  failedImplFenceReceipts: failedReceipts.length,
                  providers: [...new Set(failedReceipts.map(r => r.provider_id))],
                },
              };
            },
          },
          {
            // The repair converged: EVERY implementation workplace (including
            // the one that went rogue) ends final-accepted.
            id: 'development.impl-scope.repaired-to-acceptance',
            evaluate({ durableTrace }) {
              const implWorkplaces = new Set(
                (durableTrace.workplaces ?? [])
                  .filter(w => String(w.workplace_ref).includes('development-implementation'))
                  .map(w => w.workplace_ref));
              const accepted = new Set(
                (durableTrace.finalAcceptances ?? [])
                  .filter(row => implWorkplaces.has(row.workplace_ref))
                  .map(row => row.workplace_ref));
              const missing = [...implWorkplaces].filter(ref => !accepted.has(ref));
              return {
                passed: implWorkplaces.size > 0 && missing.length === 0,
                evidenceRefs: [...accepted].map(ref => `workplace:${ref}`),
                details: {
                  implementationWorkplaces: implWorkplaces.size,
                  accepted: accepted.size,
                  missing,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'development/acceptance-packaging-one-container':
      return {
        scenario,
        // ONE container AC document (two atomic level-2 headings) instead of
        // the N-documents W9 default — the lawful producer shape that
        // collapsed under artifactId identity. The kernel must preserve
        // criterion cardinality end-to-end.
        handlers: Object.freeze(buildOneContainerHandlers()),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          {
            // PACKAGING INVARIANT: two atomic criteria in one container
            // yield TWO verification workplaces with distinct identities —
            // never one collapsed card — and both reach final acceptance.
            id: 'development.packaging.cardinality-preserved',
            evaluate({ durableTrace }) {
              const verifyWorkplaces = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref).includes('development-verification'));
              const acceptedVerify = new Set(
                (durableTrace.finalAcceptances ?? [])
                  .filter(row => String(row.workplace_ref).includes('development-verification'))
                  .map(row => row.workplace_ref));
              return {
                passed: verifyWorkplaces.length === 2
                  && verifyWorkplaces.every(w => acceptedVerify.has(w.workplace_ref)),
                evidenceRefs: verifyWorkplaces.map(w => `workplace:${w.workplace_ref}`),
                details: {
                  verificationWorkplaces: verifyWorkplaces.length,
                  accepted: acceptedVerify.size,
                  distinctRefs: new Set(verifyWorkplaces.map(w => w.workplace_ref)).size,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    default:
      throw new Error(`DEVELOPMENT_SCENARIO_UNMAPPED: ${id}`);
  }
}
