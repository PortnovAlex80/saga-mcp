/**
 * Product-Delivery Lifecycle module contracts.
 *
 * CONVEYOR Wave 7 — Isolate modules behind ports (Rule 3):
 * a Lifecycle Scenario references module *contracts* and *installed package
 * identities* only, never module implementation classes. The four process-
 * module identity refs and the schema-id strings are durable contracts (they
 * are content-addressed identity, not implementation), so their CANONICAL home
 * is here, in the `lifecycles/` directory that owns the lifecycle definition.
 * The module definition files (`modules/<x>/<x>-process-module.ts`) and schema
 * files (`modules/<x>/<x>-schemas.ts`) import these refs back — that is the
 * `modules/ -> lifecycles/` direction, which is inward (allowed): modules are
 * leaf implementations, the contract is upstream.
 *
 * This file imports NOTHING under `modules/` — only the shared
 * `ProcessModuleReference` type from `domain/`. The values are byte-identical
 * to the former per-module definitions, so discovery certificates, formalization
 * solution contracts and development case hashes remain stable. The
 * `FORMALIZATION_PROCESS_MODULE_REF` duplicate (previously defined independently
 * in both `formalization-process-module.ts` and `formalization-schemas.ts`) is
 * resolved here: one canonical definition.
 */

import type { ProcessModuleReference } from '../domain/process-module.js';

// ---------------------------------------------------------------------------
// Process-module identity refs (content-addressed package identities).
// ---------------------------------------------------------------------------

export const DISCOVERY_PROCESS_MODULE_REF = {
  name: 'product-discovery',
  version: '3.0.2',
} as const satisfies ProcessModuleReference;

export const FORMALIZATION_PROCESS_MODULE_REF = {
  name: 'solution-formalization',
  version: '1.0.0',
} as const satisfies ProcessModuleReference;

export const DEVELOPMENT_PROCESS_MODULE_REF = {
  name: 'solution-development',
  version: '1.4.3',
} as const satisfies ProcessModuleReference;

export const DELIVERY_PROCESS_MODULE_REF = {
  name: 'delivery-release',
  version: '1.0.0',
} as const satisfies ProcessModuleReference;

// ---------------------------------------------------------------------------
// Schema-id string contracts referenced by the lifecycle stage mappings.
// These are identity strings (the `schemaVersion` literal bound into a stage's
// inputMapping), not implementation. They are re-exported to the module schema
// files below so each module remains the single source of truth for its OTHER
// schema-id strings (only the four lifecycle-referenced ones live here).
// ---------------------------------------------------------------------------

export const DELIVERY_RELEASE_CASE_SCHEMA = 'factory.delivery-release-case.v2';
export const DELIVERY_DEFERRED_PROFILE_SCHEMA =
  'factory.delivery-deferred-profile.v1';
export const DEVELOPMENT_CASE_SCHEMA = 'factory.development-case.v1';
export const FORMALIZATION_CASE_SCHEMA = 'factory.formalization-case.v1';
