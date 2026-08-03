/**
 * W7-A5 — Scenario stage outputs: content-addressed public stage outputs,
 * lifecycle variables, and exact mapped handoffs.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md (W7-A5 lane).
 * Plan: §6.11 (store each public output once), §9.13 (LifecycleVariableStore),
 *       §13.21 (cumulative-frame smell being replaced), §14.9.9 (content-addressed
 *       public stage outputs + exact mapped handoffs).
 *
 * ── What this file replaces ───────────────────────────────────────────────
 *
 * The legacy lifecycle orchestrator (`lifecycle-orchestrator.ts`)
 * reconstructs and persists a CUMULATIVE frame at every stage transition:
 * each `withStageOutput(...)` call spreads the entire prior frame and ALL prior
 * stage outputs back into the new handoff frame (§13.21). That grows O(n²) in
 * stage count and, worse, exposes every prior stage's private data to every
 * downstream stage's input mapping — even stages that have nothing to do with
 * each other.
 *
 * This module defines the replacement contract:
 *
 *   1. Each PUBLIC stage output is stored ONCE, content-addressed by its
 *      canonical-JSON digest (§6.11, §14.9.9). A stage's output is never
 *      re-embedded in a later transition.
 *   2. A downstream handoff is its OWN immutable mapped value — the exact set
 *      of fields the receiving stage's inputMapping declared (§6.11). It is
 *      NOT a copy of the root input and all previous stage payloads.
 *   3. Mappings resolve ONLY declared stage output values against a
 *      `LifecycleVariableStore` (§9.13) — there is no cumulative frame to
 *      accidentally read a sibling stage's private fields from.
 *
 * ── Anti-scope ────────────────────────────────────────────────────────────
 *
 * Wave 7 only DEFINES the contract + a pure in-memory store and the pure
 * handoff/handoff-frame builders. It does NOT rewrite `lifecycle-orchestrator.ts`
 * (Wave 11 cutover, spec §3 anti-scope) and does NOT remove the cumulative-frame
 * (Wave 13). The durable persistence adapter (the SQL table behind the store
 * port) is owned by the installation lane (W7-A1); this file owns the
 * application-layer contract a ScenarioRunner (W7-A6) consumes.
 *
 * ── Purity / dependency direction ─────────────────────────────────────────
 *
 * This is an APPLICATION-layer module under `src/process-modules/application/`.
 * It may import the domain layer (`domain/lifecycle.ts`, `domain/spi/*`) and the
 * shared canonical-json helper, both of which are permitted edges under the
 * Wave 1 dependency-direction ratchet (Rule 5 constrains domain, not
 * application). It imports NO persistence adapter, no db.ts, no module
 * implementation — only pure types and the shared hashing primitive.
 */

import type { LifecycleMappingExpression } from '../domain/lifecycle.js';
import type {
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../domain/spi/production-envelope.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  mapLifecycleValues,
  type LifecycleMappingRuntime,
} from './lifecycle-mapper.js';

// ---------------------------------------------------------------------------
// LifecycleVariable (plan §9.13, §6.11).
//
// One immutable, content-addressed PUBLIC value produced by a stage. This is
// the unit the store keeps ONCE. A variable is identified by the (stageId,
// portName) pair that produced it; its body is content-addressed so two
// references to the same logical value share one digest.
//
// `portName` is the named output port from the stage's outputMapping (plan
// §6.9.7: "Output mappings reference fields exported by the module output
// contract"). A stage may export several ports; each becomes its own
// LifecycleVariable.
// ---------------------------------------------------------------------------

/**
 * Identifier for one public value a stage exported, in the durable store's
 * key space. The pair `(stageId, portName)` MUST be unique within one
 * LifecycleRun (a stage exports each named port at most once).
 */
export interface LifecycleVariableKey {
  readonly stageId: string;
  readonly portName: string;
}

/**
 * One immutable, content-addressed public value produced by a stage (plan
 * §9.13, §6.11). The `value` is the canonical-serializable body; `digest` is
 * `sha256Hex(value)` so the same logical value always carries the same digest
 * regardless of which stage produced it. `declaredAt` records which
 * StageRun authored it, for provenance, WITHOUT embedding that run's full
 * payload in every downstream handoff.
 */
export interface LifecycleVariable {
  readonly stageId: string;
  readonly portName: string;
  /** Schema id of the value (the named port's declared output schema). */
  readonly schemaId: string;
  /** sha256Hex over the canonical JSON of `value`. Content address. */
  readonly digest: string;
  /** The immutable value body (plain canonical-serializable data). */
  readonly value: unknown;
  /** Provenance pointer to the StageRun that authored this value. */
  readonly stageRunId: number;
  /** Provenance pointer to the ProcessRun that produced the source envelope. */
  readonly processRunId: number;
}

// ---------------------------------------------------------------------------
// ScenarioStageOutputEnvelope (plan §6.11, §14.9.9).
//
// The PUBLIC output of one completed stage. It carries:
//   - the stage's declared outcome code (so routing can proceed without
//     dereferencing the module envelope);
//   - the named output ports the stage exported (each a LifecycleVariable),
//     stored once and referenced here by digest;
//   - a content-addressed reference to the module's complete output envelope
//     (the ProcessModuleOutputEnvelope from W1-A6), so the full product is
//     recoverable for audit WITHOUT being copied into every handoff.
//
// Critically, this envelope is what gets PERSISTED ONCE per stage. Downstream
// stages never receive a copy of it; they receive a ScenarioHandoff built
// from their own inputMapping (below).
// ---------------------------------------------------------------------------

/**
 * Reference to the module output envelope a stage produced. Content-addressed:
 * `envelopeDigest` is `sha256Hex` of the canonical
 * `ProcessModuleOutputEnvelope`. The envelope itself lives in the durable
 * product store (W1-A6 / W2); this reference lets a handoff point at it
 * without embedding it.
 */
export interface ScenarioModuleOutputRef {
  readonly outcome: string;
  readonly envelopeDigest: string;
  readonly certificateRef?: ProductRef;
}

/**
 * The public output of one completed stage, stored once. `portDigests` maps
 * each exported port name to the digest of its `LifecycleVariable`; the
 * variable bodies live in the `LifecycleVariableStore`. `stageOutputDigest`
 * content-addresses THIS envelope (canonical JSON of its own fields).
 */
export interface ScenarioStageOutputEnvelope {
  readonly stageId: string;
  readonly stageRunId: number;
  readonly processRunId: number;
  readonly outcome: string;
  /** Port name → digest of the exported LifecycleVariable. */
  readonly portDigests: Readonly<Record<string, string>>;
  /** Content-addressed reference to the full module output envelope. */
  readonly moduleOutput: ScenarioModuleOutputRef;
  /** sha256Hex of this envelope's canonical form. Content address. */
  readonly stageOutputDigest: string;
}

// ---------------------------------------------------------------------------
// ScenarioHandoff (plan §6.11, §14.9.9).
//
// The exact mapped handoff a downstream stage receives. It is its OWN
// immutable value: the result of applying the receiving stage's inputMapping
// against a frame built ONLY from declared stage variables + immutable
// runtime fields + literals. There is NO cumulative spread of prior stages.
//
// A handoff is content-addressed (`handoffDigest`) so the transition receipt
// (plan §13.27) can pin the exact bytes that crossed the stage boundary
// without re-embedding the source frame.
// ---------------------------------------------------------------------------

/**
 * The exact, immutable mapped handoff for one downstream stage. `payload` is
 * the output of `mapLifecycleValues(stage.inputMapping, frame, runtime)` —
 * precisely the fields the receiving stage declared, nothing more.
 * `sourceVariableDigests` records which LifecycleVariables the mapping read,
 * so the transition receipt proves the handoff was built only from declared
 * public outputs (not from an incidental cumulative-frame read).
 */
export interface ScenarioHandoff {
  readonly targetStageId: string;
  /** The mapped payload the receiving stage's inputMapping produced. */
  readonly payload: Record<string, unknown>;
  /** sha256Hex over the canonical JSON of `payload`. Content address. */
  readonly handoffDigest: string;
  /**
   * Digests of the LifecycleVariables the mapping resolved from the frame.
   * Proves the handoff is derived only from declared public outputs.
   */
  readonly sourceVariableDigests: readonly string[];
}

// ---------------------------------------------------------------------------
// LifecycleVariableStore (plan §9.13).
//
// A content-addressed public output store. Mappings resolve ONLY declared
// stage values against it instead of rebuilding a cumulative lifecycle frame.
//
// The port shape: `record(variable)` stores each public output ONCE (rejects a
// duplicate `(stageId, portName)` for the SAME run); `resolve(key)` returns
// the variable by identity; `digestOf(digest)` resolves by content address.
// An in-memory implementation is provided for tests and for the Wave 7
// ScenarioRunner (W7-A6); the durable SQL-backed adapter is the installation
// lane (W7-A1).
// ---------------------------------------------------------------------------

/**
 * Port for the content-addressed public output store (plan §9.13). A durable
 * adapter persists variables once; an in-memory adapter is provided for the
 * Wave 7 runner and for tests.
 */
export interface LifecycleVariableStore {
  /**
   * Store one public output ONCE. Throws `LIFECYCLE_VARIABLE_ALREADY_RECORDED`
   * if `(stageId, portName)` is already recorded — a stage exports each port
   * at most once. Idempotent only on identical digest.
   */
  record(variable: LifecycleVariable): void;
  /** Resolve a variable by its `(stageId, portName)` identity. */
  resolve(key: LifecycleVariableKey): LifecycleVariable | undefined;
  /** Resolve a variable by its content digest. */
  resolveByDigest(digest: string): LifecycleVariable | undefined;
  /** All variables produced by one stage, in port-name order. */
  listForStage(stageId: string): readonly LifecycleVariable[];
}

/**
 * Error thrown when `record()` is asked to store a second value for a
 * `(stageId, portName)` pair whose existing digest differs. A stage exports
 * each named port at most once (plan §6.11 — store each public output once).
 */
export class LifecycleVariableAlreadyRecordedError extends Error {
  readonly stageId: string;
  readonly portName: string;
  readonly existingDigest: string;
  readonly attemptedDigest: string;
  constructor(
    stageId: string,
    portName: string,
    existingDigest: string,
    attemptedDigest: string,
  ) {
    super(
      `LIFECYCLE_VARIABLE_ALREADY_RECORDED: stage "${stageId}" port "${portName}" ` +
        `already recorded with digest ${existingDigest} (attempted ${attemptedDigest})`,
    );
    this.name = 'LifecycleVariableAlreadyRecordedError';
    this.stageId = stageId;
    this.portName = portName;
    this.existingDigest = existingDigest;
    this.attemptedDigest = attemptedDigest;
  }
}

/**
 * Pure in-memory `LifecycleVariableStore`. Suitable for the Wave 7
 * ScenarioRunner (W7-A6) and for unit tests; the durable adapter (W7-A1)
 * wraps the same contract around a SQL table.
 */
export class InMemoryLifecycleVariableStore implements LifecycleVariableStore {
  private readonly byKey = new Map<string, LifecycleVariable>();
  private readonly byDigest = new Map<string, LifecycleVariable>();

  private keyOf(stageId: string, portName: string): string {
    return `${stageId}::${portName}`;
  }

  record(variable: LifecycleVariable): void {
    const key = this.keyOf(variable.stageId, variable.portName);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      if (existing.digest !== variable.digest) {
        throw new LifecycleVariableAlreadyRecordedError(
          variable.stageId,
          variable.portName,
          existing.digest,
          variable.digest,
        );
      }
      // Idempotent re-record of the identical digest: no-op.
      return;
    }
    this.byKey.set(key, variable);
    this.byDigest.set(variable.digest, variable);
  }

  resolve(key: LifecycleVariableKey): LifecycleVariable | undefined {
    return this.byKey.get(this.keyOf(key.stageId, key.portName));
  }

  resolveByDigest(digest: string): LifecycleVariable | undefined {
    return this.byDigest.get(digest);
  }

  listForStage(stageId: string): readonly LifecycleVariable[] {
    const out: LifecycleVariable[] = [];
    for (const v of this.byKey.values()) {
      if (v.stageId === stageId) out.push(v);
    }
    out.sort((a, b) => a.portName.localeCompare(b.portName));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pure builders.
// ---------------------------------------------------------------------------

/**
 * Build the set of `LifecycleVariable`s for one completed stage from its
 * mapped output. Each entry of `mappedOutput` becomes one content-addressed
 * variable keyed by `(stageId, portName)`. Each variable is stored ONCE.
 *
 * `mappedOutput` is the result of `mapLifecycleValues(stage.outputMapping,
 * ...)`: only the ports the stage DECLARED to export (plan §6.9.7). Private
 * fields the module produced but did not map into a named port never enter
 * the store and so can never leak into a downstream handoff.
 *
 * Returns the variables (not yet recorded) plus the `portDigests` map for the
 * `ScenarioStageOutputEnvelope`. The caller records them in the store and
 * persists the envelope.
 */
export function buildStageVariables(params: {
  stageId: string;
  stageRunId: number;
  processRunId: number;
  /**
   * Per-port schema id. Each port name maps to the schema id of the value it
   * carries. Falls back to a generic placeholder when a port has no declared
   * schema (legacy stages). Optional: callers without per-port schemas get the
   * generic placeholder for every port.
   */
  portSchemaIds?: Readonly<Record<string, string>>;
  /** The mapped output the stage exported (outputMapping result). */
  mappedOutput: Readonly<Record<string, unknown>>;
}): {
  variables: readonly LifecycleVariable[];
  portDigests: Readonly<Record<string, string>>;
} {
  const { stageId, stageRunId, processRunId, mappedOutput } = params;
  const portSchemaIds = params.portSchemaIds ?? {};
  const variables: LifecycleVariable[] = [];
  const portDigests: Record<string, string> = {};
  for (const [portName, value] of Object.entries(mappedOutput)) {
    const digest = sha256Hex(value);
    const schemaId = portSchemaIds[portName] ?? LIFECYCLE_VARIABLE_GENERIC_SCHEMA;
    variables.push({
      stageId,
      portName,
      schemaId,
      digest,
      value,
      stageRunId,
      processRunId,
    });
    portDigests[portName] = digest;
  }
  // Stable ordering by port name for deterministic canonical serialization.
  variables.sort((a, b) => a.portName.localeCompare(b.portName));
  return { variables, portDigests };
}

/**
 * Schema id placeholder for a lifecycle variable whose port carries no
 * declared schema. Real scenarios declare a schema per port (plan §6.9.6);
 * this keeps legacy single-schema stages working.
 */
export const LIFECYCLE_VARIABLE_GENERIC_SCHEMA =
  'saga3.lifecycle-variable.generic.v1';

/**
 * Build the `ScenarioStageOutputEnvelope` for one completed stage. This is
 * the artifact persisted ONCE per stage. The module output envelope is
 * referenced by digest (NOT embedded), so the full product is recoverable for
 * audit without being copied into any handoff.
 */
export function buildStageOutputEnvelope(params: {
  stageId: string;
  stageRunId: number;
  processRunId: number;
  outcome: string;
  portDigests: Readonly<Record<string, string>>;
  moduleOutput: ScenarioModuleOutputRef;
}): ScenarioStageOutputEnvelope {
  const {
    stageId,
    stageRunId,
    processRunId,
    outcome,
    portDigests,
    moduleOutput,
  } = params;
  // The envelope's own digest excludes the digest field itself (self-hash).
  const body = {
    stageId,
    stageRunId,
    processRunId,
    outcome,
    portDigests,
    moduleOutput,
  };
  return {
    ...body,
    stageOutputDigest: sha256Hex(body),
  };
}

/**
 * Compute the content digest of a `ProcessModuleOutputEnvelope` for use as
 * `ScenarioModuleOutputRef.envelopeDigest`. Delegates to the platform
 * canonical-hash primitive so stage-output digests are byte-compatible with
 * every other content-addressed artifact.
 */
export function moduleOutputEnvelopeDigest(envelope: ProcessModuleOutputEnvelope): string {
  return sha256Hex(envelope);
}

// ---------------------------------------------------------------------------
// Exact handoff frame (plan §6.11, §13.21 replacement).
//
// The legacy orchestrator builds a cumulative frame: `{ ...rootInput,
// lifecycleInput, stages: { ...allPriorStages } }` and spreads it at every
// transition. That is what §13.21 calls out.
//
// The replacement builds a MINIMAL frame containing ONLY:
//   - the scenario root input (one reference, not re-embedded per stage);
//   - the declared output ports of each completed stage, read ON DEMAND from
//     the LifecycleVariableStore and exposed under `stages.<id>.ports`;
//   - immutable runtime fields.
//
// A receiving stage's inputMapping reads from this frame via the existing
// `mapLifecycleValues`. Because the frame exposes only declared ports (not
// raw module payloads), a mapping CANNOT reach a sibling stage's private
// fields even if it tried — they are not in the frame.
// ---------------------------------------------------------------------------

/**
 * The immutable fields available to every mapping expression's `{ runtime }`
 * variant. Mirrors `LifecycleMappingRuntime` from `lifecycle-mapper.ts` but
 * expressed here so the handoff frame is self-describing.
 */
export interface ScenarioHandoffRuntime extends LifecycleMappingRuntime {
  // LifecycleMappingRuntime already carries projectId/epicId/lifecycleRunId/
  // stageId/initiatedBy. No additional fields: the runtime must stay immutable
  // and scenario-author-visible (plan §6.3.3).
}

/**
 * Build the minimal, non-cumulative mapping frame for a target stage. This is
 * the EXACT surface a downstream stage's `inputMapping` reads from.
 *
 * Unlike the legacy cumulative frame, this frame:
 *   - exposes each completed stage ONLY through its declared output ports
 *     (resolved from the store by digest), never through raw module payloads;
 *   - references the root input ONCE (`lifecycleInput`), it is not spread
 *     into the top level;
 *   - carries no `processOutcome` blob from sibling stages.
 *
 * `completedStages` selects which stages are visible. A ScenarioRunner passes
 * the stage ids that completed before the target; the store resolves their
 * ports lazily.
 */
export function buildHandoffFrame(params: {
  rootInput: unknown;
  runtime: ScenarioHandoffRuntime;
  store: LifecycleVariableStore;
  /** Stage ids whose declared ports should be visible to the target's mapping. */
  completedStageIds: readonly string[];
}): Record<string, unknown> {
  const { rootInput, runtime, store, completedStageIds } = params;
  const stages: Record<string, { ports: Record<string, unknown> }> = {};
  for (const stageId of completedStageIds) {
    const ports: Record<string, unknown> = {};
    for (const v of store.listForStage(stageId)) {
      ports[v.portName] = v.value;
    }
    stages[stageId] = { ports };
  }
  return {
    // Root input is referenced ONCE, not spread into the top level — a mapping
    // must read it via `$.lifecycleInput.<field>`, which makes root-input
    // reads explicit and auditable instead of implicit.
    lifecycleInput: rootInput,
    stages,
    runtime,
  };
}

/**
 * Build the exact `ScenarioHandoff` for one downstream stage. Applies the
 * stage's `inputMapping` against the minimal non-cumulative frame and records
 * which declared variables the mapping actually read.
 *
 * This is the §13.21 replacement: instead of persisting
 * `{ ...entirePriorFrame, [stageId]: {...} }`, we persist ONLY the mapped
 * payload + a content digest + the source-variable digests that prove the
 * payload was derived from declared public outputs.
 *
 * `sourceVariableDigests` is computed by tracking which `(stageId, portName)`
 * pairs the mapping dereferenced. Because `mapLifecycleValues` resolves
 * string paths against the frame, and the frame only contains declared
 * ports, every resolved path corresponds to a recorded variable.
 */
export function buildScenarioHandoff(params: {
  targetStageId: string;
  inputMapping: Readonly<Record<string, LifecycleMappingExpression>>;
  rootInput: unknown;
  runtime: ScenarioHandoffRuntime;
  store: LifecycleVariableStore;
  completedStageIds: readonly string[];
}): ScenarioHandoff {
  const {
    targetStageId,
    inputMapping,
    rootInput,
    runtime,
    store,
    completedStageIds,
  } = params;
  const frame = buildHandoffFrame({
    rootInput,
    runtime,
    store,
    completedStageIds,
  });
  const payload = mapLifecycleValues(inputMapping, frame, runtime);
  const sourceVariableDigests = collectSourceDigests(
    inputMapping,
    frame,
    store,
    completedStageIds,
  );
  return {
    targetStageId,
    payload,
    handoffDigest: sha256Hex(payload),
    sourceVariableDigests,
  };
}

/**
 * Walk the inputMapping's string-typed (path) expressions against the frame
 * and record the digests of the declared variables each resolved path landed
 * on. Literal and `{ runtime }` expressions contribute no source digest.
 *
 * This proves the handoff is built only from declared public outputs: every
 * `stages.<id>.ports.<port>` read maps to exactly one recorded
 * LifecycleVariable, and any path that does NOT land on a declared variable
 * (e.g. an attempt to read `stages.<id>.processOutcome` — a legacy cumulative
 * field that does not exist in the minimal frame) is rejected by the mapper
 * before reaching here.
 */
function collectSourceDigests(
  inputMapping: Readonly<Record<string, LifecycleMappingExpression>>,
  frame: Record<string, unknown>,
  store: LifecycleVariableStore,
  completedStageIds: readonly string[],
): string[] {
  const digests = new Set<string>();
  const completedSet = new Set(completedStageIds);
  for (const expression of Object.values(inputMapping)) {
    if (typeof expression !== 'string') continue; // literal / runtime: no source
    const resolved = resolveVariableKeyFromPath(expression, frame, completedSet);
    if (resolved === null) continue;
    const variable = store.resolve(resolved);
    if (variable !== undefined) {
      digests.add(variable.digest);
    }
  }
  return [...digests].sort();
}

/**
 * Resolve a `stages.<stageId>.ports.<port...>` mapping path to the
 * `(stageId, portName)` of the declared variable it reads. Returns null for
 * non-stage paths (root input reads, runtime reads) and for paths that do not
 * match the declared-port shape.
 *
 * `portName` is the FIRST segment after `ports`: a mapping that reads
 * `$.stages.draft.ports.campaignDraft.title` reads the `campaignDraft` port
 * (the variable), and its `.title` sub-field is part of that one variable's
 * value. We attribute the whole read to the port-level variable.
 */
function resolveVariableKeyFromPath(
  path: string,
  frame: Record<string, unknown>,
  completedStageIds: Set<string>,
): LifecycleVariableKey | null {
  // mapLifecycleValues accepts paths starting with `$.`. The frame's stages
  // live under `stages.<id>.ports.<port>`.
  if (!path.startsWith('$.stages.')) return null;
  const rest = path.slice('$.stages.'.length); // <stageId>.ports.<port...>
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) return null;
  const stageId = rest.slice(0, firstDot);
  if (!completedStageIds.has(stageId)) return null;
  const afterStage = rest.slice(firstDot + 1); // ports.<port...>
  if (!afterStage.startsWith('ports.')) return null;
  const portRest = afterStage.slice('ports.'.length); // <port...>
  if (portRest.length === 0) return null;
  const portEnd = portRest.indexOf('.');
  const portName = portEnd === -1 ? portRest : portRest.slice(0, portEnd);
  if (portName.length === 0) return null;
  // Confirm the frame actually exposes this port (defense in depth; the mapper
  // already dereferenced successfully if we got here, but guard anyway).
  const stages = frame.stages;
  if (
    stages !== null
    && typeof stages === 'object'
    && !Array.isArray(stages)
    && Object.hasOwn(stages as Record<string, unknown>, stageId)
  ) {
    return { stageId, portName };
  }
  return null;
}
