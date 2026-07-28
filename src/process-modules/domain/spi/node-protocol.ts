/**
 * W1-A4 — NodeProtocolDefinition + flow-condition ratchet (plan §8.2, §7.4.3,
 * §8.2.11 / C065).
 *
 * A NodeProtocol describes the ordered actions INSIDE a single LM-operated
 * Flow node (plan §8.1). It is pure canonical data; the Runtime owns the
 * ProtocolRun / ProtocolStepRun state machine (Wave 4 — not here).
 *
 * This file owns:
 *   - `RetrySemanticsKind` (plan §8.2.11): the kinds the Runtime may
 *     implement. `unsupported` is the reject target — validators MUST refuse
 *     it at install time (C065).
 *   - `EvidenceRequirement` / `ProtocolStep` / `ProtocolStepTransition` /
 *     `NodeProtocolDefinition`.
 *   - `validateNodeProtocolDefinition` — structural validator. Calls
 *     `assertCanonicalSerializable` first (plan §3.5) then enforces the
 *     structural invariants of a valid protocol graph.
 *   - `isSupportedFlowCondition` — C065 ratchet seed. Wave 1 is conservative:
 *     only `undefined` (no condition on the transition) is a supported
 *     deterministic predicate. Any opaque string is REJECTED. Declarative
 *     predicates arrive in Wave 7.
 *
 * Pure: only `import type` from sibling lanes; the runtime imports are
 * `shared/canonical-json.ts` (pure) and the W1-A1 validator. Type-only
 * sibling imports (`ContractRef` from W1-A5, assistance/guards from W1-A6)
 * resolve at Wave 1 integration and produce no runtime dependency.
 */

import type { ContractRef } from './contract-ref.js';
import type { AgentAssistanceDefinition, GuardBinding } from './tool-contribution.js';
import { assertCanonicalSerializable } from './canonical-serialization.js';

// ---------------------------------------------------------------------------
// Result shape (kept local; sibling lanes own their own equivalent).
// ---------------------------------------------------------------------------

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: readonly ValidationError[];
}

function okResult(): ValidationResult {
  return { ok: true, errors: [] };
}

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

// ---------------------------------------------------------------------------
// Retry semantics (plan §8.2.11).
// ---------------------------------------------------------------------------

/**
 * The retry semantics a NodeProtocol declares for its owning node.
 *
 * - `runtime-implemented-linear`   — Runtime retries the node a fixed number
 *   of times with no backoff.
 * - `runtime-implemented-backoff`  — Runtime retries with exponential (or
 *   otherwise Runtime-defined) backoff.
 * - `unsupported`                  — REJECTED at install (plan §8.2.11 / C065).
 *   The literal exists so a validator can name the rejection reason; a valid
 *   NodeProtocolDefinition never carries it.
 */
export type RetrySemanticsKind =
  | 'runtime-implemented-linear'
  | 'runtime-implemented-backoff'
  | 'unsupported';

const SUPPORTED_RETRY_SEMANTICS: ReadonlySet<RetrySemanticsKind> = new Set([
  'runtime-implemented-linear',
  'runtime-implemented-backoff',
]);

// ---------------------------------------------------------------------------
// Evidence (plan §8.4 / §8.5).
// ---------------------------------------------------------------------------

/**
 * Category of durable evidence a step (or node completion) requires.
 *
 * The Runtime understands the CATEGORY (it knows how to record/retrieve a
 * tool receipt) but never the domain meaning (it does not know what
 * "SRS-accepted" means). Module-specific evidence is checked by a versioned
 * verifier registered by the package (plan §8.5).
 */
export type EvidenceCategory =
  | 'tool-receipt'
  | 'artifact-reference'
  | 'trace-reference'
  | 'human-receipt'
  | 'external-receipt'
  | 'module-verifier-receipt';

export interface EvidenceRequirement {
  category: EvidenceCategory;
  /** Pinned schema contract for this evidence value (W1-A5 ContractRef). */
  contractRef: ContractRef;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Protocol steps + transitions (plan §8.2.3 – §8.2.8).
// ---------------------------------------------------------------------------

export interface ProtocolStep {
  id: string;
  instructions: string;
  resources: readonly string[];
  allowedTools: readonly string[];
  evidenceRequirements: readonly EvidenceRequirement[];
  /** Optional per-step assistance configuration (W1-A6 — type-only). */
  assistance?: AgentAssistanceDefinition;
  /** Optional per-step guard bindings (W1-A6 — type-only). */
  guards?: readonly GuardBinding[];
}

export interface ProtocolStepTransition {
  from: string;
  to: string;
  kind: 'linear' | 'branch' | 'repeat';
  /**
   * Module-authored condition predicate reference. Wave 1's
   * `isSupportedFlowCondition` rejects any opaque string; only `undefined`
   * (unconditional) is currently supported (plan §7.4.3 / C065 ratchet seed).
   */
  condition?: string;
}

// ---------------------------------------------------------------------------
// NodeProtocolDefinition (plan §8.2).
// ---------------------------------------------------------------------------

export interface NodeProtocolDefinition {
  id: string;
  version: string;
  owningFlowNodeId: string;
  entryStep: string;
  steps: readonly ProtocolStep[];
  transitions: readonly ProtocolStepTransition[];
  nodeCompletionEvidence: readonly EvidenceRequirement[];
  recoveryEntrySteps: readonly string[];
  retrySemantics: RetrySemanticsKind;
}

// ---------------------------------------------------------------------------
// C065 flow-condition ratchet seed (plan §7.4.3).
// ---------------------------------------------------------------------------

/**
 * Wave 1's conservative rule for `FlowTransitionDefinition.condition` and
 * `ProtocolStepTransition.condition`: only `undefined` (no condition) is a
 * supported deterministic predicate. Any opaque string is REJECTED at install
 * time (plan §7.4.3 / C065).
 *
 * This is the SEED of the ratchet. Wave 7 introduces declarative, named
 * predicates (registered with the ContractSchemaRegistry); at that point this
 * function widens to accept registered predicate ContractRefs and the ratchet
 * tightens from "any string → false" to "any unregistered string → false".
 *
 * Returns `true` only for `undefined`. Returns `false` for any string
 * (including the empty string) and for any other value.
 */
export function isSupportedFlowCondition(condition: string | undefined): boolean {
  return condition === undefined;
}

// ---------------------------------------------------------------------------
// Validator (plan §8.2.11 / §3.5 / C065).
// ---------------------------------------------------------------------------

/**
 * Validate a `NodeProtocolDefinition` for installation.
 *
 * Order of checks:
 *   1. `assertCanonicalSerializable` — reject any function/Map/Set/Symbol/
 *      non-finite-number/class-instance/`undefined`-in-array (plan §3.5).
 *   2. retrySemantics is in the supported enum (NOT `unsupported`) — plan
 *      §8.2.11 / C065.
 *   3. structural: entry step exists; step ids are unique; every transition
 *      targets an existing step; every transition `from` references an
 *      existing step.
 */
export function validateNodeProtocolDefinition(
  def: NodeProtocolDefinition,
): ValidationResult {
  const errors: ValidationError[] = [];

  // (1) Canonical-serializability gate.
  try {
    assertCanonicalSerializable(def);
  } catch (e) {
    errors.push(
      err(
        'NODE_PROTOCOL_NOT_CANONICAL',
        '',
        `NodeProtocolDefinition is not canonical-serializable: ${(e as Error).message}`,
      ),
    );
    // Structural checks below would still run, but most pathologies collapse
    // to "not serializable"; bail so the error list stays focused.
    return { ok: false, errors };
  }

  // (2) retrySemantics must be a SUPPORTED kind. `unsupported` is the
  // explicit reject target (plan §8.2.11 / C065).
  if (!SUPPORTED_RETRY_SEMANTICS.has(def.retrySemantics)) {
    errors.push(
      err(
        'NODE_PROTOCOL_UNSUPPORTED_RETRY_SEMANTICS',
        'retrySemantics',
        `retrySemantics must be one of ${[...SUPPORTED_RETRY_SEMANTICS].join(' | ')}; got "${def.retrySemantics}". The literal 'unsupported' exists only as the reject target (plan §8.2.11 / C065).`,
      ),
    );
  }

  // (3) Structural invariants.

  // entryStep must resolve.
  const stepIds = new Set<string>();
  for (const s of def.steps) stepIds.add(s.id);

  if (!stepIds.has(def.entryStep)) {
    errors.push(
      err(
        'NODE_PROTOCOL_ENTRY_STEP_MISSING',
        'entryStep',
        `entryStep "${def.entryStep}" does not match any step id in steps[]`,
      ),
    );
  }

  // Duplicate step ids?
  const seen = new Set<string>();
  for (const s of def.steps) {
    if (seen.has(s.id)) {
      errors.push(
        err(
          'NODE_PROTOCOL_DUPLICATE_STEP_ID',
          'steps',
          `duplicate step id "${s.id}"`,
        ),
      );
    } else {
      seen.add(s.id);
    }
  }

  // Every transition must reference existing steps.
  for (let i = 0; i < def.transitions.length; i++) {
    const t = def.transitions[i];
    const path = `transitions[${i}]`;
    if (!stepIds.has(t.from)) {
      errors.push(
        err(
          'NODE_PROTOCOL_TRANSITION_FROM_UNKNOWN',
          `${path}.from`,
          `transition.from "${t.from}" does not match any step id`,
        ),
      );
    }
    if (!stepIds.has(t.to)) {
      errors.push(
        err(
          'NODE_PROTOCOL_TRANSITION_TO_UNKNOWN',
          `${path}.to`,
          `transition.to "${t.to}" does not match any step id`,
        ),
      );
    }
  }

  // recoveryEntrySteps must reference existing steps (a missing recovery
  // entry is a structural defect — the recovery route would be unreachable).
  for (let i = 0; i < def.recoveryEntrySteps.length; i++) {
    const id = def.recoveryEntrySteps[i];
    if (!stepIds.has(id)) {
      errors.push(
        err(
          'NODE_PROTOCOL_RECOVERY_ENTRY_UNKNOWN',
          `recoveryEntrySteps[${i}]`,
          `recoveryEntrySteps entry "${id}" does not match any step id`,
        ),
      );
    }
  }

  return errors.length === 0 ? okResult() : { ok: false, errors };
}
