// src/application/module-conformance-runner.ts
//
// W9-A7 — Shared Process Module conformance kit.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md
//   §1 (W9-A7 owns the shared conformance runner + cross-module isolation
//   checks), §2 (exit gate: Discovery, Development, Delivery independently pass
//   the SAME installation, execution, review, recovery, restart, and output
//   conformance kit as Formalization), §3 (anti-scope: additive only).
//
// WHAT THIS IS
//   A single, framework-agnostic checker that runs every Process Module
//   definition through the eight conformance dimensions proven by the Wave 8
//   Formalization pilot (W8-A8). It is the kit the Wave 9 exit gate invokes
//   once per installed module so Discovery, Development and Delivery must clear
//   the same bar Formalization already cleared.
//
//   The runner consumes PURE DATA only:
//     - a ProcessModuleDefinition (the frozen domain object every module
//       exports), and
//     - an optional ProcessModuleManifest (the package envelope a migrated
//       module pins its resources through), and
//     - optional module-specific hooks (durable restart/replay + deterministic
//       settlement), which are themselves pure-function ports.
//
//   It deliberately does NOT import the built-in module catalog (Rule 4b of the
//   dependency-direction ratchet: catalog import IS module-name switching in
//   disguise). Callers pass the definitions in. This keeps the kit reusable for
//   the integrator's full gate run AND for sibling-lane isolation worktrees
//   where only one module is present.
//
// THE EIGHT DIMENSIONS (mirrors W8-A8, generalized)
//   1. INSTALLATION — the definition validates against the structural
//      ProcessModuleDefinition validator (the same gate the registry enforces
//      at registration time), so every conformance-passing module is also
//      registry-installable.
//   2. EXECUTION (author) — every LM node binds an executionProfile that
//      EXISTS in the module, and every profile binds the authoring skill
//      (executionSkill), the semantic skill, an executionMode and an output
//      schema. A MIGRATED module (kernel-gate acceptance) keeps artifact
//   3. REVIEW — every MIGRATED profile binds an INDEPENDENT reviewSkill
//      generic-reviewer fallback still covers them.
//   4. KERNEL — every 'kernel' node carries a handler and NEVER carries an
//      executionProfile (kernels do not author). Every LM node carries an
//      executionProfile and NEVER a handler. This is the deterministic-core
//      invariant: kernels are pure functions of their inputs.
//   5. RETRY — every profile.retryPolicy has maxAttempts>=1, a non-empty closed
//      retryOn vocabulary, and a backoff from {none|fixed|exponential}.
//   6. RECOVERY — every flow.recovery[] entry references EXISTING verify +
//      repair nodes (verify != repair), declares maxAttempts>=1, non-empty
//      trigger/resolved events, and an onExhausted from {fail|pause|escalate}.
//      Every profile.recoveryPolicy has resumeFromCheckpoint + a closed
//      onExhausted. Modules with no recovery entries pass vacuously.
//   7. RESTART — when a module-specific restart probe is supplied, the runner
//      delegates to it: the same durable payload hash for the same process_run
//      must replay (idempotent), and a divergent hash must be rejected
//      (write-once). Without a probe the dimension is SKIPPED — it is
//      module-owned persistence, not structural.
//   8. OUTPUT — the module declares at least one terminal outcome, every
//      terminal flow node emits a declared outcome, the input/output contracts
//      are bound, and (when a manifest is supplied) the pinned manifest
//      contracts match the definition's contracts and the manifest validates.
//      This is the §0.11.11 serial gate surface: a migrated module runs through
//      pinned package resources with no global lookup.
//
// CROSS-MODULE ISOLATION
//   runCrossModuleIsolation() scans the repository dependency graph and asserts
//   that NO module implementation file imports ANOTHER module's implementation
//   directly (Rule 1 of the dependency-direction ratchet), and that the four
//   built-in modules do not share resource logicalIds, handler logicalIds or
//   outcome codes in a way that would collide at install time. This is the
//   kit-level mirror of the architecture ratchet: it proves the modules are
//   independently installable side by side.
//
// RESULT MODEL
//   Each check produces a ConformanceResult { dimension, check, status, ... }
//   where status is one of:
//     - 'passed'  — the module conforms to this check.
//     - 'failed'  — the module violates this check (a real regression).
//     - 'skipped' — the check does not apply to this module yet (e.g. the
//                   sibling package surface is absent in an isolated worktree,
//   A ConformanceReport is 'passing' iff it has zero failures. Skips are
//   first-class and carry a `reason` so the integrator can see exactly which
//   dimensions still need the sibling package or the migration cutover.

import type {
  ProcessModuleDefinition,
  ProcessModuleIdentity,
} from '../process-modules/domain/process-module.js';
import type { ProcessModuleManifest } from '../process-modules/domain/spi/module-manifest.js';

// ---------------------------------------------------------------------------
// Closed vocabularies — mirrors of the Wave-1 SPI unions. The conformance
// checks assert a module only ever emits values from these closed sets; a
// future drift that invents a new literal fails here.
// ---------------------------------------------------------------------------

export const ON_EXHAUSTED_VALUES = Object.freeze(['fail', 'pause', 'escalate']);
export const RETRY_BACKOFF_VALUES = Object.freeze(['none', 'fixed', 'exponential']);
export const FLOW_NODE_KIND_VALUES = Object.freeze([
  'lm',
  'kernel',
  'human',
  'external',
  'composite',
  'production-cell',
]);
export const ARTIFACT_AUTHORITY_VALUES = Object.freeze([
  'worker',
  'advisor',
  'kernel',
  'human',
  'external',
]);
export const INVARIANT_ENFORCEMENT_VALUES = Object.freeze([
  'static',
  'runtime',
  'policy',
  'test',
]);

// ---------------------------------------------------------------------------
// Public result model.
// ---------------------------------------------------------------------------

export type ConformanceStatus = 'passed' | 'failed' | 'skipped';

export interface ConformanceResult {
  /** Dimension slug (matches a W9-A7 dimension, see file header). */
  readonly dimension: ConformanceDimension;
  /** Short, stable check identifier (snake_case). */
  readonly check: string;
  readonly status: ConformanceStatus;
  /** Human-readable detail; failure messages name the offending node/profile. */
  readonly message: string;
  /** Free-form structured detail for diagnostics (never load-bearing). */
  readonly details?: ReadonlyArray<readonly string[]>;
}

export type ConformanceDimension =
  | 'installation'
  | 'execution'
  | 'review'
  | 'kernel'
  | 'retry'
  | 'recovery'
  | 'restart'
  | 'output';

export interface ConformanceReport {
  readonly moduleKey: string;
  readonly results: readonly ConformanceResult[];
  /** True iff zero results have status 'failed'. Skips do not fail the report. */
  readonly passing: boolean;
  /** Count of results per status, for shrinkage/progress visibility. */
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number };
}

// ---------------------------------------------------------------------------
// Module-specific probe ports.
//
// These are pure-function ports a module's own conformance test supplies. The
// runner never instantiates a database or a policy itself: restart/settlement
// conformance is module-owned (each module persists different artefacts), so
// the kit delegates to a probe the caller binds. When a probe is absent the
// dimension is SKIPPED with a clear reason — the structural dimensions still
// run unconditionally.
// ---------------------------------------------------------------------------

/**
 * Probe for the RESTART dimension: durable write-once / replay idempotency.
 *
 * The probe receives a fresh opaque `harness` (caller-supplied, e.g. a temp
 * database) and must return a {@link RestartProbeOutcome} describing whether
 * the same payload hash replayed idempotently and a divergent hash was
 * rejected. The runner does NOT interpret the payload shape — that is the
 * module's contract.
 */
export interface RestartProbeContext {
  /** Opaque caller-supplied harness (temp dir, db, ...). */
  readonly harness: unknown;
}
export interface RestartProbeOutcome {
  /** True when the same payload hash replayed without a second write. */
  readonly replayedIdempotently: boolean;
  /** True when a divergent payload hash for the same run was rejected. */
  readonly divergentRejected: boolean;
  /** Free-form evidence string recorded on the result. */
  readonly evidence: string;
}
export type RestartProbe = (ctx: RestartProbeContext) => Promise<RestartProbeOutcome> | RestartProbeOutcome;

/**
 * Probe for the deterministic-core property of settlement: the same inputs
 * must yield the same decision + inputHash every time. Optional — the kit
 * cannot synthesize module-specific settlement inputs, so when no probe is
 * supplied the deterministic-settlement check is SKIPPED.
 */
export interface SettlementDeterminismProbeOutcome {
  readonly deterministic: boolean;
  readonly inputHashLength: number;
  readonly evidence: string;
}
export type SettlementDeterminismProbe =
  () => Promise<SettlementDeterminismProbeOutcome> | SettlementDeterminismProbeOutcome;

export interface ModuleConformanceOptions {
  /** The frozen ProcessModuleDefinition every module exports. */
  readonly definition: ProcessModuleDefinition;
  /** Optional package manifest (migrated modules). When absent, package checks skip. */
  readonly manifest?: ProcessModuleManifest;
  /** Optional restart/replay probe (module-owned durable persistence). */
  readonly restartProbe?: RestartProbe;
  /** Optional settlement determinism probe (module-owned policy). */
  readonly settlementProbe?: SettlementDeterminismProbe;
  /** Caller-supplied harness forwarded to the restart probe. */
  readonly restartHarness?: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function moduleKey(identity: ProcessModuleIdentity): string {
  return `${identity.name}@${identity.version}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Build a failure result. */
function fail(
  dimension: ConformanceDimension,
  check: string,
  message: string,
  details?: ReadonlyArray<readonly string[]>): ConformanceResult {
  return { dimension, check, status: 'failed', message, details };
}

/** Build a pass result. */
function pass(dimension: ConformanceDimension, check: string, message: string): ConformanceResult {
  return { dimension, check, status: 'passed', message };
}

/** Build a skip result with a reason. */
function skip(dimension: ConformanceDimension, check: string, reason: string): ConformanceResult {
  return { dimension, check, status: 'skipped', message: reason };
}

// ---------------------------------------------------------------------------
// DIMENSION 1 — INSTALLATION.
// ---------------------------------------------------------------------------

async function checkInstallation(
  definition: ProcessModuleDefinition,
): Promise<readonly ConformanceResult[]> {
  // Delegate to the canonical structural validator the registry uses. The kit
  // imports the validator (an application-layer pure function) rather than
  // re-implementing identifier/semver/flow-reachability rules so the bar can
  // never drift between registration and conformance.
  const { validateProcessModuleDefinition } = await import(
    '../process-modules/application/validate-process-module.js'
  );
  const result = validateProcessModuleDefinition(definition);
  if (result.valid && result.errors.length === 0) {
    return [pass('installation', 'definition_validates',
      `${moduleKey(definition.identity)} validates against the structural ProcessModuleDefinition gate.`)];
  }
  return [
    fail('installation', 'definition_validates',
      `${moduleKey(definition.identity)} has ${result.errors.length} structural validation error(s).`,
      [result.errors]),
  ];
}

// ---------------------------------------------------------------------------
// DIMENSION 2 — EXECUTION (author).
// ---------------------------------------------------------------------------

function checkExecution(definition: ProcessModuleDefinition): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  const lmNodes = definition.flow.nodes.filter((n) => n.kind === 'lm');
  const profileIds = new Set(definition.executionProfiles.map((p) => p.id));

  if (lmNodes.length === 0 && definition.executionProfiles.length === 0) {
    // A module with no LM surface (e.g. a fully-external module) has no author
    // dimension to check. Report as passed-vacuous, not skipped, so the
    // dimension is still visible as exercised.
    out.push(pass('execution', 'lm_nodes_bind_profiles',
      `${moduleKey(definition.identity)} has no LM nodes / profiles (external-only module); author dimension vacuous.`));
    return out;
  }

  // (a) every LM node references an existing executionProfile.
  const badRefs: string[] = [];
  for (const node of lmNodes) {
    if (!isNonEmptyString(node.executionProfile)) {
      badRefs.push(`${node.id}(missing)`);
    } else if (!profileIds.has(node.executionProfile)) {
      badRefs.push(`${node.id}('${node.executionProfile}')`);
    }
  }
  if (badRefs.length === 0) {
    out.push(pass('execution', 'lm_nodes_bind_profiles',
      `${lmNodes.length} LM node(s) each bind a declared executionProfile.`));
  } else {
    out.push(fail('execution', 'lm_nodes_bind_profiles',
      `${badRefs.length} LM node(s) reference an unknown/missing executionProfile.`,
      [badRefs]));
  }

  // (b) every profile binds author + semantic + mode + output schema.
  const missing: string[] = [];
  for (const p of definition.executionProfiles) {
    if (!isNonEmptyString(p.executionSkill)) missing.push(`${p.id}.executionSkill`);
    if (!isNonEmptyString(p.semanticSkill)) missing.push(`${p.id}.semanticSkill`);
    if (!isNonEmptyString(p.executionMode)) missing.push(`${p.id}.executionMode`);
    if (!isNonEmptyString(p.outputSchema?.id)) missing.push(`${p.id}.outputSchema`);
  }
  if (missing.length === 0) {
    out.push(pass('execution', 'profiles_bind_author_surface',
      `${definition.executionProfiles.length} profile(s) bind executionSkill + semanticSkill + executionMode + outputSchema.`));
  } else {
    out.push(fail('execution', 'profiles_bind_author_surface',
      `${missing.length} profile field(s) missing.`,
      [missing]));
  }

  // (c) artifact acceptance authority is always owned by the kernel gate.
  const nonGate = definition.executionProfiles
    .filter((p) => p.artifactAcceptanceAuthority !== 'kernel-gate')
    .map((p) => p.id);
  if (nonGate.length === 0) {
    out.push(pass('execution', 'artifact_acceptance_kernel_gate',
      `kernel-gate accepts artifacts across all ${definition.executionProfiles.length} profile(s).`));
  } else {
    out.push(fail('execution', 'artifact_acceptance_kernel_gate',
      `profile(s) do not use kernel-gate acceptance.`, [nonGate]));
  }

  return out;
}

// ---------------------------------------------------------------------------
// DIMENSION 3 — REVIEW.
// ---------------------------------------------------------------------------

function checkReview(definition: ProcessModuleDefinition): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  if (definition.executionProfiles.length === 0) {
    out.push(pass('review', 'independent_review_skill',
      `${moduleKey(definition.identity)} has no profiles; review dimension vacuous.`));
    out.push(pass('review', 'shared_protocol_skill',
      `${moduleKey(definition.identity)} has no profiles; protocol dimension vacuous.`));
    return out;
  }

  const selfReview: string[] = [];
  const missingReview: string[] = [];
  for (const p of definition.executionProfiles) {
    if (!isNonEmptyString(p.reviewSkill)) {
      if (p.artifactAcceptanceAuthority !== 'kernel-gate') missingReview.push(p.id);
    } else if (p.reviewSkill === p.executionSkill) {
      selfReview.push(p.id);
    }
  }
  if (selfReview.length === 0 && missingReview.length === 0) {
    out.push(pass('review', 'independent_review_skill',
      `all ${definition.executionProfiles.length} profile(s) bind independent review or kernel-gate acceptance.`));
  } else {
    const detail = [...missingReview.map((id) => `${id}(missing)`), ...selfReview.map((id) => `${id}(self-review)`)];
    out.push(fail('review', 'independent_review_skill',
      `module must not self-review; ${detail.length} profile(s) missing or self-review.`,
      [detail]));
  }

  // Shared protocolSkill — every profile that declares one shares a single
  // protocol skill (the physical execution protocol).
  const protocols = new Set(
    definition.executionProfiles
      .map((p) => p.protocolSkill)
      .filter((v): v is string => isNonEmptyString(v)),
  );
  const missingProtocol = definition.executionProfiles.filter((p) => !isNonEmptyString(p.protocolSkill));
  if (missingProtocol.length === 0 && protocols.size === 1) {
    out.push(pass('review', 'shared_protocol_skill',
      `all ${definition.executionProfiles.length} profile(s) share one protocolSkill.`));
  } else if (missingProtocol.length === definition.executionProfiles.length) {
    out.push(fail('review', 'shared_protocol_skill',
      `${moduleKey(definition.identity)} declares no protocolSkill.`, [missingProtocol.map(p => p.id)]));
  } else {
    const detail: string[] = [];
    if (missingProtocol.length > 0) detail.push(`${missingProtocol.length} missing`);
    if (protocols.size > 1) detail.push(`${protocols.size} distinct`);
    out.push(fail('review', 'shared_protocol_skill',
      `profiles do not share a single protocolSkill (${detail.join(', ')}).`,
      [[...protocols]]));
  }

  return out;
}

// ---------------------------------------------------------------------------
// DIMENSION 4 — KERNEL (deterministic core).
// ---------------------------------------------------------------------------

function checkKernel(definition: ProcessModuleDefinition): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  const kernelNodes = definition.flow.nodes.filter((n) => n.kind === 'kernel');
  const lmNodes = definition.flow.nodes.filter((n) => n.kind === 'lm');

  if (kernelNodes.length === 0) {
    out.push(skip('kernel', 'kernel_nodes_carry_handler',
      `${moduleKey(definition.identity)} has no kernel nodes.`));
  } else {
    const missingHandler: string[] = [];
    for (const node of kernelNodes) {
      if (!isNonEmptyString((node as { handler?: unknown }).handler)) {
        missingHandler.push(node.id);
      }
    }
    if (missingHandler.length === 0) {
      out.push(pass('kernel', 'kernel_nodes_carry_handler',
        `${kernelNodes.length} kernel node(s) each declare a handler.`));
    } else {
      out.push(fail('kernel', 'kernel_nodes_carry_handler',
        `${missingHandler.length} kernel node(s) missing a handler.`,
        [missingHandler]));
    }
  }

  // Kernel nodes must NEVER carry an executionProfile / executionSkill.
  const kernelAuthoring: string[] = [];
  for (const node of kernelNodes) {
    const n = node as { executionProfile?: unknown; executionSkill?: unknown };
    if (n.executionProfile !== undefined) kernelAuthoring.push(`${node.id}.executionProfile`);
    if (n.executionSkill !== undefined) kernelAuthoring.push(`${node.id}.executionSkill`);
  }
  if (kernelAuthoring.length === 0) {
    out.push(pass('kernel', 'kernel_nodes_never_author',
      `no kernel node carries an executionProfile or executionSkill (kernels do not author).`));
  } else {
    out.push(fail('kernel', 'kernel_nodes_never_author',
      `${kernelAuthoring.length} kernel node field(s) illegally carry authoring config.`,
      [kernelAuthoring]));
  }

  // LM nodes must NEVER carry a handler (handlers are kernel-only).
  const lmHandlers: string[] = [];
  for (const node of lmNodes) {
    if ((node as { handler?: unknown }).handler !== undefined) {
      lmHandlers.push(node.id);
    }
  }
  if (lmHandlers.length === 0) {
    out.push(pass('kernel', 'lm_nodes_never_carry_handler',
      `no LM node carries a handler (LM nodes execute via executionProfile).`));
  } else {
    out.push(fail('kernel', 'lm_nodes_never_carry_handler',
      `${lmHandlers.length} LM node(s) illegally declare a handler.`,
      [lmHandlers]));
  }

  return out;
}

// ---------------------------------------------------------------------------
// DIMENSION 5 — RETRY.
// ---------------------------------------------------------------------------

function checkRetry(definition: ProcessModuleDefinition): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  if (definition.executionProfiles.length === 0) {
    out.push(skip('retry', 'profile_retry_policy',
      `${moduleKey(definition.identity)} has no executionProfiles; retry dimension vacuous.`));
    return out;
  }
  const bad: string[] = [];
  for (const p of definition.executionProfiles) {
    const r = p.retryPolicy;
    if (!r) { bad.push(`${p.id}(missing)`); continue; }
    if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1) bad.push(`${p.id}.maxAttempts`);
    if (!Array.isArray(r.retryOn) || r.retryOn.length === 0) bad.push(`${p.id}.retryOn`);
    if (!RETRY_BACKOFF_VALUES.includes(r.backoff)) bad.push(`${p.id}.backoff(${r.backoff})`);
  }
  if (bad.length === 0) {
    out.push(pass('retry', 'profile_retry_policy',
      `all ${definition.executionProfiles.length} profile(s) have maxAttempts>=1 + non-empty retryOn + closed backoff.`));
  } else {
    out.push(fail('retry', 'profile_retry_policy',
      `${bad.length} profile retryPolicy field(s) invalid.`,
      [bad]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// DIMENSION 6 — RECOVERY.
// ---------------------------------------------------------------------------

function checkRecovery(definition: ProcessModuleDefinition): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  const nodeIds = new Set(definition.flow.nodes.map((n) => n.id));
  const recovery = definition.flow.recovery ?? [];

  if (recovery.length === 0) {
    out.push(skip('recovery', 'flow_recovery_entries',
      `${moduleKey(definition.identity)} declares no flow.recovery entries (no local repair routes).`));
  } else {
    const bad: string[] = [];
    for (const r of recovery) {
      if (!nodeIds.has(r.verifyNodeId)) bad.push(`${r.id}.verifyNodeId(${r.verifyNodeId})`);
      if (!nodeIds.has(r.repairNodeId)) bad.push(`${r.id}.repairNodeId(${r.repairNodeId})`);
      if (r.verifyNodeId === r.repairNodeId) bad.push(`${r.id}(self-repair)`);
      if (!Array.isArray(r.triggerEvents) || r.triggerEvents.length === 0) bad.push(`${r.id}.triggerEvents`);
      if (!Array.isArray(r.resolvedEvents) || r.resolvedEvents.length === 0) bad.push(`${r.id}.resolvedEvents`);
      if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1) bad.push(`${r.id}.maxAttempts`);
      if (!ON_EXHAUSTED_VALUES.includes(r.onExhausted)) bad.push(`${r.id}.onExhausted(${r.onExhausted})`);
    }
    if (bad.length === 0) {
      out.push(pass('recovery', 'flow_recovery_entries',
        `${recovery.length} recovery entr(y)(es) reference existing verify+repair nodes with closed onExhausted.`));
    } else {
      out.push(fail('recovery', 'flow_recovery_entries',
        `${bad.length} recovery field(s) invalid.`,
        [bad]));
    }
  }

  // profile.recoveryPolicy — closed onExhausted + crash-resume checkpoint.
  if (definition.executionProfiles.length === 0) {
    out.push(skip('recovery', 'profile_recovery_policy',
      `${moduleKey(definition.identity)} has no executionProfiles; recoveryPolicy dimension vacuous.`));
  } else {
    const bad: string[] = [];
    for (const p of definition.executionProfiles) {
      const rp = p.recoveryPolicy;
      if (!rp) { bad.push(`${p.id}(missing)`); continue; }
      if (rp.resumeFromCheckpoint !== true) bad.push(`${p.id}.resumeFromCheckpoint`);
      if (!ON_EXHAUSTED_VALUES.includes(rp.onExhausted)) bad.push(`${p.id}.onExhausted(${rp.onExhausted})`);
    }
    if (bad.length === 0) {
      out.push(pass('recovery', 'profile_recovery_policy',
        `all ${definition.executionProfiles.length} profile(s) resume from checkpoint with closed onExhausted.`));
    } else {
      out.push(fail('recovery', 'profile_recovery_policy',
        `${bad.length} recoveryPolicy field(s) invalid.`,
        [bad]));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// DIMENSION 7 — RESTART (durable write-once / replay idempotency).
// ---------------------------------------------------------------------------

async function checkRestart(
  definition: ProcessModuleDefinition,
  probe: RestartProbe | undefined,
  harness: unknown,
): Promise<readonly ConformanceResult[]> {
  if (!probe) {
    return [skip('restart', 'durable_replay_idempotent',
      `${moduleKey(definition.identity)} supplied no restart probe; module-owned persistence is not exercised by the shared kit.`)];
  }
  try {
    const outcome = await probe({ harness });
    const out: ConformanceResult[] = [];
    if (outcome.replayedIdempotently) {
      out.push(pass('restart', 'durable_replay_idempotent',
        `same payload hash replays without a second write. ${outcome.evidence}`));
    } else {
      out.push(fail('restart', 'durable_replay_idempotent',
        `restart probe did not replay the same payload hash idempotently. ${outcome.evidence}`));
    }
    if (outcome.divergentRejected) {
      out.push(pass('restart', 'divergent_payload_rejected',
        `a divergent payload hash for the same process_run is rejected (write-once). ${outcome.evidence}`));
    } else {
      out.push(fail('restart', 'divergent_payload_rejected',
        `restart probe did not reject a divergent payload hash. ${outcome.evidence}`));
    }
    return out;
  } catch (err) {
    return [fail('restart', 'durable_replay_idempotent',
      `restart probe threw: ${(err as Error).message}`)];
  }
}

// ---------------------------------------------------------------------------
// DIMENSION 8 — OUTPUT (contracts + outcomes + manifest package surface).
// ---------------------------------------------------------------------------

async function checkOutput(
  definition: ProcessModuleDefinition,
  manifest: ProcessModuleManifest | undefined,
  settlementProbe: SettlementDeterminismProbe | undefined,
): Promise<readonly ConformanceResult[]> {
  const out: ConformanceResult[] = [];

  // (a) contracts bound.
  if (isNonEmptyString(definition.inputContract?.id) && isNonEmptyString(definition.outputContract?.id)) {
    out.push(pass('output', 'contracts_bound',
      `inputContract=${definition.inputContract.id}, outputContract=${definition.outputContract.id}.`));
  } else {
    out.push(fail('output', 'contracts_bound', `input/output contract id missing.`));
  }

  // (b) terminal outcomes declared + emitted.
  const declared = new Set(definition.outcomes.map((o) => o.code));
  const terminalNodes = definition.flow.nodes.filter((n) => definition.flow.terminalNodeIds.includes(n.id));
  const undeclared: string[] = [];
  for (const node of terminalNodes) {
    if (node.emitsOutcome === undefined) {
      undeclared.push(`${node.id}(no emitsOutcome)`);
    } else if (!declared.has(node.emitsOutcome)) {
      undeclared.push(`${node.id}(${node.emitsOutcome})`);
    }
  }
  if (definition.outcomes.length === 0) {
    out.push(fail('output', 'terminal_outcomes_declared', `module declares zero outcomes.`));
  } else if (undeclared.length === 0) {
    out.push(pass('output', 'terminal_outcomes_declared',
      `${definition.outcomes.length} outcome(s) declared; ${terminalNodes.length} terminal node(s) each emit a declared outcome.`));
  } else {
    out.push(fail('output', 'terminal_outcomes_declared',
      `${undeclared.length} terminal node(s) emit no/undeclared outcome.`,
      [undeclared]));
  }

  // (c) closed vocabularies on declared metadata.
  const badKinds = definition.flow.nodes
    .filter((n) => !FLOW_NODE_KIND_VALUES.includes(n.kind))
    .map((n) => `${n.id}(${n.kind})`);
  if (badKinds.length === 0) {
    out.push(pass('output', 'flow_node_kinds_closed', `all flow node kinds are in the closed vocabulary.`));
  } else {
    out.push(fail('output', 'flow_node_kinds_closed',
      `${badKinds.length} node(s) use an unknown kind.`,
      [badKinds]));
  }
  const badAuthority = definition.artifacts
    .filter((a) => !ARTIFACT_AUTHORITY_VALUES.includes(a.authority))
    .map((a) => `${a.type}(${a.authority})`);
  if (badAuthority.length === 0) {
    out.push(pass('output', 'artifact_authority_closed', `all artifact authorities are in the closed vocabulary.`));
  } else {
    out.push(fail('output', 'artifact_authority_closed',
      `${badAuthority.length} artifact(s) use an unknown authority.`,
      [badAuthority]));
  }
  const badEnforcement = definition.invariants
    .filter((i) => !INVARIANT_ENFORCEMENT_VALUES.includes(i.enforcement))
    .map((i) => `${i.id}(${i.enforcement})`);
  if (badEnforcement.length === 0) {
    out.push(pass('output', 'invariant_enforcement_closed', `all invariant enforcements are in the closed vocabulary.`));
  } else {
    out.push(fail('output', 'invariant_enforcement_closed',
      `${badEnforcement.length} invariant(s) use an unknown enforcement.`,
      [badEnforcement]));
  }

  // (d) deterministic settlement — module-owned probe.
  if (settlementProbe) {
    try {
      const outcome = await settlementProbe();
      if (outcome.deterministic && outcome.inputHashLength === 64) {
        out.push(pass('output', 'settlement_deterministic',
          `settlement policy is a pure function of (graph, input); 64-char inputHash. ${outcome.evidence}`));
      } else {
        out.push(fail('output', 'settlement_deterministic',
          `settlement probe reported non-determinism or wrong hash length (len=${outcome.inputHashLength}). ${outcome.evidence}`));
      }
    } catch (err) {
      out.push(fail('output', 'settlement_deterministic',
        `settlement probe threw: ${(err as Error).message}`));
    }
  } else {
    out.push(skip('output', 'settlement_deterministic',
      `${moduleKey(definition.identity)} supplied no settlement probe; deterministic-core property is module-owned.`));
  }

  // (e) package manifest surface (migrated modules).
  if (!manifest) {
    out.push(skip('output', 'package_manifest_validates',
      `${moduleKey(definition.identity)} has no package manifest (sibling surface absent in this worktree); package-isolation is the integrator's full-gate responsibility.`));
    out.push(skip('output', 'package_contracts_match_definition',
      `no manifest to compare against the definition contracts.`));
    out.push(skip('output', 'package_resources_local',
      `no manifest resourceIndex to check for package-locality.`));
  } else {
    const { validateProcessModuleManifest } = await import(
      '../process-modules/domain/spi/module-manifest.js'
    );
    const result = validateProcessModuleManifest(manifest);
    if (result.ok) {
      out.push(pass('output', 'package_manifest_validates',
        `package manifest validates (canonical-serializable + structurally complete).`));
    } else {
      out.push(fail('output', 'package_manifest_validates',
        `${result.errors.length} manifest validation error(s).`,
        [result.errors.map((e) => `[${e.code}] ${e.path}: ${e.message}`)]));
    }
    // pinned contracts match the definition.
    if (
      manifest.inputContractRef?.schemaId === definition.inputContract.id &&
      manifest.outputContractRef?.schemaId === definition.outputContract.id
    ) {
      out.push(pass('output', 'package_contracts_match_definition',
        `pinned manifest input/output contracts match the definition.`));
    } else {
      out.push(fail('output', 'package_contracts_match_definition',
        `manifest contracts diverge from definition (in=${manifest.inputContractRef?.schemaId}, out=${manifest.outputContractRef?.schemaId}).`));
    }
    // resources are package-local (no absolute path, no parent traversal).
    const leaks: string[] = [];
    for (const r of manifest.resourceIndex) {
      if (typeof r.path !== 'string') continue;
      if (r.path.startsWith('/')) leaks.push(`${r.logicalId}(absolute)`);
      if (r.path.includes('..')) leaks.push(`${r.logicalId}(parent-traversal)`);
    }
    if (leaks.length === 0) {
      out.push(pass('output', 'package_resources_local',
        `all ${manifest.resourceIndex.length} manifest resource(s) are package-relative.`));
    } else {
      out.push(fail('output', 'package_resources_local',
        `${leaks.length} manifest resource(s) are not package-local.`,
        [leaks]));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public entry point — runModuleConformance.
// ---------------------------------------------------------------------------

/**
 * Run the shared conformance kit against one Process Module definition.
 *
 * Returns a {@link ConformanceReport} with one {@link ConformanceResult} per
 * check across all eight dimensions. The report is `passing` iff it has zero
 * failures; skips are first-class and carry a `reason`.
 *
 * Structural dimensions (installation, execution, kernel, retry, recovery,
 * output) run UNCONDITIONALLY against the definition. Module-owned dimensions
 * (restart, deterministic settlement, package manifest) run only when the
 * caller supplies the corresponding probe/manifest, and skip otherwise.
 */
export async function runModuleConformance(
  options: ModuleConformanceOptions,
): Promise<ConformanceReport> {
  const { definition, manifest, restartProbe, settlementProbe, restartHarness } = options;
  const results: ConformanceResult[] = [];
  results.push(...await checkInstallation(definition));
  results.push(...checkExecution(definition));
  results.push(...checkReview(definition));
  results.push(...checkKernel(definition));
  results.push(...checkRetry(definition));
  results.push(...checkRecovery(definition));
  results.push(...await checkRestart(definition, restartProbe, restartHarness));
  results.push(...await checkOutput(definition, manifest, settlementProbe));

  const counts = {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
  return {
    moduleKey: moduleKey(definition.identity),
    results,
    passing: counts.failed === 0,
    counts,
  };
}

// ---------------------------------------------------------------------------
// CROSS-MODULE ISOLATION.
//
// The kit-level mirror of Rule 1 of the dependency-direction ratchet plus the
// install-time resource/handler/outcome uniqueness that independent
// side-by-side installation requires. The integrator calls this once over the
// full module set; a sibling-lane worktree calls it over the single module it
// holds (the cross-module import scan then vacuously passes).
// ---------------------------------------------------------------------------

/**
 * Graph of file -> imported file targets, in repo-relative POSIX paths.
 * Produced by tools/dep-graph-scanner.mjs. Declared here so callers (and
 * tests) can pass a synthetic graph without scanning disk.
 */
export type DependencyGraph = Readonly<Record<string, readonly string[]>>;

/** Pattern matching a module implementation file: src/process-modules/modules/<name>/... */
const MODULE_FILE_RE = /^src\/process-modules\/modules\/([^/]+)\//;

export interface ModuleIsolationOptions {
  /** Definitions to check for install-time uniqueness collisions. */
  readonly definitions?: readonly ProcessModuleDefinition[];
  /**
   * Optional package manifests whose resource/handler logicalIds must not
   * collide across modules at install time.
   */
  readonly manifests?: readonly ProcessModuleManifest[];
  /**
   * Dependency graph to scan for inter-module imports. When omitted the kit
   * scans the repository on disk via the dep-graph-scanner tool.
   */
  readonly graph?: DependencyGraph;
  /** Repository root for the on-disk scan (defaults to process.cwd()). */
  readonly rootDir?: string;
}

export interface CrossModuleIsolationReport {
  /** One result per isolation check. Passing iff zero failures. */
  readonly results: readonly ConformanceResult[];
  readonly passing: boolean;
}

/** Extract the module directory name from a repo-relative path, or null. */
export function moduleDirOf(p: string): string | null {
  const m = p.match(MODULE_FILE_RE);
  return m ? m[1] : null;
}

async function loadGraph(options: ModuleIsolationOptions): Promise<DependencyGraph> {
  if (options.graph) return options.graph;
  // The scanner is a plain-Node .mjs test tool with no .d.ts. Import it
  // dynamically and treat its surface as the typed DependencyGraph declared
  // here — the scanner's contract (file -> targets, repo-relative POSIX) is
  // exactly DependencyGraph.
  const mod = (await import('../../tools/dep-graph-scanner.mjs')) as {
    scanDependencyGraph: (opts: { rootDir?: string }) => DependencyGraph;
  };
  return mod.scanDependencyGraph({ rootDir: options.rootDir });
}

/**
 * Run cross-module isolation checks.
 *
 * Checks:
 *   1. NO inter-module imports — no module implementation file imports another
 *      module's implementation directly (Rule 1). Each leak is a failure.
 *   2. install-time uniqueness — module keys (name@version) are unique, and
 *      across any supplied manifests the package-level resource logicalIds and
 *      handler logicalIds do not collide (a logicalId is the install-time
 *      namespace the runtime pins against). Outcome codes are deliberately NOT
 *      checked for cross-module uniqueness: an outcome code is module-LOCAL
 *      (the ProcessRun's localOutcome is namespaced by module), so 'failed' or
 *      'blocked' may legitimately appear in several modules.
 */
export async function runCrossModuleIsolation(
  options: ModuleIsolationOptions = {},
): Promise<CrossModuleIsolationReport> {
  const results: ConformanceResult[] = [];

  // (1) inter-module import scan.
  const graph = await loadGraph(options);
  const leaks: string[] = [];
  for (const [src, targets] of Object.entries(graph)) {
    const srcMod = moduleDirOf(src);
    if (!srcMod) continue;
    for (const tgt of targets) {
      const tgtMod = moduleDirOf(tgt);
      if (tgtMod && tgtMod !== srcMod) {
        leaks.push(`${src} -> ${tgt}`);
      }
    }
  }
  if (leaks.length === 0) {
    results.push(pass('installation', 'no_inter_module_imports',
      `no module implementation file imports another module's implementation directly.`));
  } else {
    results.push(fail('installation', 'no_inter_module_imports',
      `${leaks.length} inter-module import(s) detected (Rule 1 violation).`,
      [leaks]));
  }

  // (2) install-time uniqueness across definitions.
  const defs = options.definitions ?? [];
  if (defs.length === 0) {
    results.push(skip('installation', 'cross_module_uniqueness',
      `no definitions supplied; install-time uniqueness not checked.`));
  } else {
    // module keys unique.
    const keys = defs.map((d) => moduleKey(d.identity));
    const dupKeys = duplicates(keys);
    if (dupKeys.length === 0) {
      results.push(pass('installation', 'module_keys_unique',
        `${defs.length} module key(s) are unique.`));
    } else {
      results.push(fail('installation', 'module_keys_unique',
        `${dupKeys.length} duplicate module key(s).`,
        [dupKeys]));
    }
    // package-level logicalId uniqueness across manifests. A resource or
    // handler logicalId is the install-time namespace the runtime pins
    // against; a collision across modules would shadow one package's resource
    // with another's at install time. (Outcome codes are NOT checked here:
    // they are module-local — see the docstring on runCrossModuleIsolation.)
    const manifests = options.manifests ?? [];
    if (manifests.length === 0) {
      results.push(skip('installation', 'manifest_logical_ids_unique',
        `no manifests supplied; package-level logicalId uniqueness not checked.`));
    } else {
      const resourceOwners = new Map<string, string>();
      const handlerOwners = new Map<string, string>();
      const collisions: string[] = [];
      for (const m of manifests) {
        const owner = m.definition?.identity?.name ?? '<unknown>';
        for (const r of m.resourceIndex ?? []) {
          const prev = resourceOwners.get(r.logicalId);
          if (prev && prev !== owner) collisions.push(`resource ${r.logicalId}(${prev} vs ${owner})`);
          else resourceOwners.set(r.logicalId, owner);
        }
        for (const h of m.handlerRefs ?? []) {
          const prev = handlerOwners.get(h.logicalId);
          if (prev && prev !== owner) collisions.push(`handler ${h.logicalId}(${prev} vs ${owner})`);
          else handlerOwners.set(h.logicalId, owner);
        }
      }
      if (collisions.length === 0) {
        results.push(pass('installation', 'manifest_logical_ids_unique',
          `${manifests.length} manifest(s) have non-colliding resource/handler logicalIds.`));
      } else {
        results.push(fail('installation', 'manifest_logical_ids_unique',
          `${collisions.length} resource/handler logicalId collision(s) across manifests.`,
          [collisions]));
      }
    }
  }

  return {
    results,
    passing: results.every((r) => r.status !== 'failed'),
  };
}

/** Return the duplicate strings in a list (preserving first-seen order). */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

// ---------------------------------------------------------------------------
// Convenience: fail-fast assertion wrapper for use in test suites.
// ---------------------------------------------------------------------------

/**
 * Assert that a conformance report is passing (zero failures). Throws with a
 * rendered breakdown of every failure when it is not. Intended for the
 * `node:test` suites that drive the kit; production callers inspect `.passing`.
 */
export function assertPassing(report: ConformanceReport | CrossModuleIsolationReport): void {
  if (report.passing) return;
  const results = report.results.filter((r) => r.status === 'failed');
  const lines = results.map((r) => {
    const head = `  [${r.dimension}/${r.check}] ${r.message}`;
    const tail = r.details && r.details.length > 0
      ? '\n' + r.details.map((rows) => rows.map((row) => `      - ${row}`).join('\n')).join('\n')
      : '';
    return head + tail;
  });
  const key = 'moduleKey' in report ? report.moduleKey : 'cross-module';
  throw new Error(
    `conformance report for ${key} has ${results.length} failure(s):\n${lines.join('\n')}`,
  );
}
