/**
 * W1-A2 — ProcessModuleManifest: the pure envelope that wraps a
 * `ProcessModuleDefinition` plus the new pure manifest fields.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §1 row 5.
 * Task: `docs/refactor-management/05-subagent-tasks/W01-A2-module-manifest.md`.
 *
 * The manifest is the canonical, persisted description of a Process Module
 * package. It deliberately contains NO executor, NO factories, NO functions —
 * only serializable data. The Wave 2 installer persists it verbatim; the Wave
 * 3+ executors consume it read-only.
 *
 * This module is PURE DATA ONLY (plan §3.5). Every field is canonically
 * serializable; `validateProcessModuleManifest` enforces that invariant before
 * a manifest is accepted.
 *
 * Cross-lane imports (resolve at Wave 1 integration / cherry-pick time):
 *   - `ContractRef`                       from `./contract-ref.js`         (W1-A5)
 *   - `assertCanonicalSerializable`       from `./canonical-serialization.js` (W1-A1)
 *   - `ModuleToolContribution`            from `./tool-contribution.js`    (W1-A6)
 *   - `AgentAssistanceDefinition`         from `./agent-assistance.js`     (W1-A6)
 *   - `GuardBinding`, `CapabilityRequirement` from `./tool-contribution.js` (W1-A6)
 *
 * The W1-A6 imports are type-only: the manifest references their shape but
 * never instantiates them, so they impose no runtime dependency. The W1-A5
 * `ContractRef` is also imported type-only for the same reason.
 *
 * Anti-scope: do NOT import the existing `validateProcessModuleDefinition`
 * from `application/validate-process-module.ts` — Rule 5 of the
 * dependency-direction ratchet forbids `domain/` from importing `application/`.
 * The structural check below verifies shape + canonical serializability; full
 * semantic validation of the wrapped definition remains the application
 * layer's responsibility at install time.
 */

// Existing pure domain type — the manifest WRAPS it, does not replace it.
import type { ProcessModuleDefinition } from '../process-module.js';

// W1-A2 sibling (same lane) — the resource-index types this manifest carries.
// Imported for local use AND re-exported below so consumers have a single
// import surface.
import { RESOURCE_KINDS } from './resource-index.js';
import type { ResourceIndexEntry, ResourceKind } from './resource-index.js';

// W1-A5 — pure ContractRef { schemaId; version; digest }. Type-only: the
// manifest references the shape; it never constructs one at module load.
import type { ContractRef } from './contract-ref.js';

// W1-A1 — canonical-serialization assertion. VALUE import: the validator calls
// it at runtime. This is the one runtime cross-lane dependency, and it is to a
// pure module that itself only imports `shared/canonical-json.ts`.
import { assertCanonicalSerializable } from './canonical-serialization.js';

// W1-A6 — pure definition types referenced by the optional manifest fields.
// Type-only: the manifest carries these as opaque readonly data.
import type { ModuleToolContribution, GuardBinding, CapabilityRequirement } from './tool-contribution.js';
import type { AgentAssistanceDefinition } from './agent-assistance.js';

// Re-export the resource-index types so consumers can import the full manifest
// surface from one module. The owning file remains `./resource-index.js`. The
// bindings are imported above for local use; here we surface them publicly.
export { RESOURCE_KINDS };
export type { ResourceIndexEntry, ResourceKind };

/**
 * A reference to a handler (kernel node handler, external adapter, or any
 * callable the module declares by name). Handlers are NOT shipped in the
 * manifest — only stable, content-addressed references to them.
 *
 * @property logicalId  Module-namespaced handler identifier.
 * @property version    Handler implementation version (semver-ish).
 * @property digest     `sha256` of the handler implementation's bytes. A
 *                      placeholder is NOT accepted for handlers (K3): the
 *                      runtime workshop manifests stamp the real digest of
 *                      the installation module that registers the handlers.
 */
export interface HandlerRef {
  readonly logicalId: string;
  readonly version: string;
  readonly digest: string;
}

/**
 * The canonical manifest envelope. A pure, serializable description of a
 * Process Module package.
 *
 * Field semantics (spec §1 row 5):
 * @property manifestFormatVersion     Format version of THIS manifest envelope
 *                                     (independent of the module's own version).
 *                                     Non-empty. Wave 1 uses `'0.1.0'`.
 * @property definition                The wrapped {@link ProcessModuleDefinition}
 *                                     redefined).
 * @property resourceIndex             Module-relative resources (skills,
 *                                     templates, schemas, ...). Entries have
 *                                     unique `logicalId`.
 * @property handlerRefs               Stable references to the module's handlers.
 *                                     Entries have unique `logicalId`.
 * @property inputContractRef         Rich input contract reference
 *                                     ({@link ContractRef}).
 * @property outputContractRef        Rich output contract reference.
 * @property runtimeCompatibilityRange Semver range of the runtime API the module
 *                                     requires (e.g. `'^3.0.0'`).
 * @property toolContributions         Optional MCP/tool contributions (W1-A6).
 * @property assistance                Optional agent-assistance definitions.
 * @property guards                    Optional guard bindings.
 * @property capabilityRequirements    Optional capability requirements.
 */
export interface ProcessModuleManifest {
  readonly manifestFormatVersion: string;
  readonly definition: ProcessModuleDefinition;
  readonly resourceIndex: readonly ResourceIndexEntry[];
  readonly handlerRefs: readonly HandlerRef[];
  readonly inputContractRef: ContractRef;
  readonly outputContractRef: ContractRef;
  readonly runtimeCompatibilityRange: string;
  readonly toolContributions?: readonly ModuleToolContribution[];
  readonly assistance?: readonly AgentAssistanceDefinition[];
  readonly guards?: readonly GuardBinding[];
  readonly capabilityRequirements?: readonly CapabilityRequirement[];
}

/**
 * A single validation failure. Pure data.
 */
export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Result of validating a manifest. `ok` is true iff `errors` is empty.
 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

// ---------------------------------------------------------------------------
// Validator helpers.
// ---------------------------------------------------------------------------

const RESOURCE_KIND_SET: ReadonlySet<string> = new Set(RESOURCE_KINDS);

/** Placeholder digest Wave 1 callers use when they have no real bytes yet. */
export const PENDING_DIGEST = 'pending@wave-2';

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && value.constructor === Object
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Collect duplicate keys among entries' `logicalId`. */
function duplicateLogicalIds(
  entries: readonly { logicalId: unknown }[],
): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.logicalId !== 'string') continue;
    if (seen.has(entry.logicalId)) dupes.add(entry.logicalId);
    seen.add(entry.logicalId);
  }
  return [...dupes];
}

// ---------------------------------------------------------------------------
// Validator.
// ---------------------------------------------------------------------------

/**
 * Validate a `ProcessModuleManifest` for persistence readiness.
 *
 * Two-phase check (spec §2):
 *   1. `assertCanonicalSerializable` first — rejects any function/Map/Set/
 *      undefined-in-array/class-instance/Symbol/non-finite-number anywhere in
 *      the manifest (plan §3.5). Throws on the first offending value.
 *   2. Structural completeness — required fields present, `logicalId`s unique,
 *      `manifestFormatVersion` non-empty, `resourceIndex` kinds known, the
 *      wrapped `definition` is a plain object of the right shape.
 *
 * Returns `{ ok, errors }`. Does NOT throw for ordinary validation failures;
 * only `assertCanonicalSerializable` throws (a structural-purity violation is a
 * programmer error, not a data error).
 *
 * NOTE: full semantic validation of the wrapped `definition` (identifier
 * format, flow reachability, outcome emission, ...) is the application layer's
 * job — Rule 5 of the dependency-direction ratchet forbids `domain/` from
 * importing `application/validate-process-module.ts`. Here we verify only that
 * the definition is present and structurally a `ProcessModuleDefinition`.
 */
export function validateProcessModuleManifest(
  manifest: unknown,
): ValidationResult {
  // Phase 1 — canonical serializability (throws on impurity).
  assertCanonicalSerializable(manifest);

  const errors: ValidationError[] = [];

  if (!isPlainObject(manifest)) {
    errors.push(
      err(
        'MANIFEST_NOT_OBJECT',
        '$',
        'manifest must be a plain object',
      ),
    );
    return { ok: false, errors };
  }

  const m = manifest as Record<string, unknown>;

  // manifestFormatVersion — non-empty string.
  if (!isNonEmptyString(m.manifestFormatVersion)) {
    errors.push(
      err(
        'MANIFEST_FORMAT_VERSION_EMPTY',
        '$.manifestFormatVersion',
        'manifestFormatVersion must be a non-empty string',
      ),
    );
  }

  // definition — present and a plain object (ProcessModuleDefinition shape).
  if (!isPlainObject(m.definition)) {
    errors.push(
      err(
        'MANIFEST_DEFINITION_MISSING',
        '$.definition',
        'definition must be a plain ProcessModuleDefinition object',
      ),
    );
  } else {
    // Structural shape check of the wrapped definition. We do NOT call the
    // application-layer validator (Rule 5). Verify the required top-level
    // fields of ProcessModuleDefinition are present and themselves objects.
    const def = m.definition as Record<string, unknown>;
    const requiredDefFields: ReadonlyArray<[string, string]> = [
      ['identity', 'object'],
      ['inputContract', 'object'],
      ['outputContract', 'object'],
      ['flow', 'object'],
    ];
    const requiredArrays: readonly string[] = [
      'outcomes',
      'artifacts',
      'policies',
      'invariants',
      'executionProfiles',
    ];
    for (const [field, kind] of requiredDefFields) {
      const v = def[field];
      if (kind === 'object' && !isPlainObject(v)) {
        errors.push(
          err(
            'MANIFEST_DEFINITION_FIELD_INVALID',
            `$.definition.${field}`,
            `definition.${field} must be a plain object`,
          ),
        );
      }
    }
    for (const field of requiredArrays) {
      if (!Array.isArray(def[field])) {
        errors.push(
          err(
            'MANIFEST_DEFINITION_FIELD_INVALID',
            `$.definition.${field}`,
            `definition.${field} must be an array`,
          ),
        );
      }
    }
  }

  // resourceIndex — array of ResourceIndexEntry with unique logicalId + known kind.
  if (!Array.isArray(m.resourceIndex)) {
    errors.push(
      err(
        'MANIFEST_RESOURCE_INDEX_MISSING',
        '$.resourceIndex',
        'resourceIndex must be an array',
      ),
    );
  } else {
    m.resourceIndex.forEach((entry, i) => {
      const path = `$.resourceIndex[${i}]`;
      if (!isPlainObject(entry)) {
        errors.push(err('RESOURCE_ENTRY_INVALID', path, 'entry must be a plain object'));
        return;
      }
      if (!isNonEmptyString(entry.logicalId)) {
        errors.push(err('RESOURCE_LOGICAL_ID_INVALID', `${path}.logicalId`, 'logicalId must be a non-empty string'));
      }
      if (!isNonEmptyString(entry.path)) {
        errors.push(err('RESOURCE_PATH_INVALID', `${path}.path`, 'path must be a non-empty string'));
      }
      if (typeof entry.kind !== 'string' || !RESOURCE_KIND_SET.has(entry.kind)) {
        errors.push(
          err(
            'RESOURCE_KIND_UNKNOWN',
            `${path}.kind`,
            `kind must be one of: ${[...RESOURCE_KIND_SET].join('|')}`,
          ),
        );
      }
      if (!isNonEmptyString(entry.digest)) {
        errors.push(err('RESOURCE_DIGEST_INVALID', `${path}.digest`, 'digest must be a non-empty string'));
      }
    });
    for (const dup of duplicateLogicalIds(m.resourceIndex as { logicalId: unknown }[])) {
      errors.push(
        err(
          'RESOURCE_LOGICAL_ID_DUPLICATE',
          '$.resourceIndex',
          `duplicate resource logicalId '${dup}'`,
        ),
      );
    }
  }

  // handlerRefs — array of HandlerRef with unique logicalId.
  if (!Array.isArray(m.handlerRefs)) {
    errors.push(
      err(
        'MANIFEST_HANDLER_REFS_MISSING',
        '$.handlerRefs',
        'handlerRefs must be an array',
      ),
    );
  } else {
    m.handlerRefs.forEach((entry, i) => {
      const path = `$.handlerRefs[${i}]`;
      if (!isPlainObject(entry)) {
        errors.push(err('HANDLER_REF_INVALID', path, 'entry must be a plain object'));
        return;
      }
      if (!isNonEmptyString(entry.logicalId)) {
        errors.push(err('HANDLER_LOGICAL_ID_INVALID', `${path}.logicalId`, 'logicalId must be a non-empty string'));
      }
      if (!isNonEmptyString(entry.version)) {
        errors.push(err('HANDLER_VERSION_INVALID', `${path}.version`, 'version must be a non-empty string'));
      }
      if (!isNonEmptyString(entry.digest)) {
        errors.push(err('HANDLER_DIGEST_INVALID', `${path}.digest`, 'digest must be a non-empty string'));
      } else if (entry.digest === PENDING_DIGEST) {
        // K3 (Saga Core Renewal): resources may carry the authoring-time
        // placeholder (the installer stamps real bytes at install, Step 3.5),
        // but a handler reference IS the pin of the executable implementation
        // — a placeholder here means the package cannot prove which code it
        // executes, and nothing may install it.
        errors.push(err(
          'HANDLER_DIGEST_PENDING',
          `${path}.digest`,
          `handler digest must be a real implementation digest; '${PENDING_DIGEST}' is not accepted for handlers (resources only)`,
        ));
      }
    });
    for (const dup of duplicateLogicalIds(m.handlerRefs as { logicalId: unknown }[])) {
      errors.push(
        err(
          'HANDLER_LOGICAL_ID_DUPLICATE',
          '$.handlerRefs',
          `duplicate handler logicalId '${dup}'`,
        ),
      );
    }
  }

  // inputContractRef / outputContractRef — plain objects (full ContractRef
  // validation lives in W1-A5; here we only enforce presence + shape).
  for (const field of ['inputContractRef', 'outputContractRef'] as const) {
    if (!isPlainObject(m[field])) {
      errors.push(
        err(
          'MANIFEST_CONTRACT_REF_INVALID',
          `$.${field}`,
          `${field} must be a plain ContractRef object`,
        ),
      );
    }
  }

  // runtimeCompatibilityRange — non-empty string.
  if (!isNonEmptyString(m.runtimeCompatibilityRange)) {
    errors.push(
      err(
        'MANIFEST_COMPAT_RANGE_INVALID',
        '$.runtimeCompatibilityRange',
        'runtimeCompatibilityRange must be a non-empty string',
      ),
    );
  }

  return { ok: errors.length === 0, errors };
}
