/**
 * W10-A3 — Human Director Approval package export surface.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a3.md`.
 *
 * Single import surface for the Human Director Approval Process Module
 * package. The Wave 2 installer / content-addressed package store / composition
 * root imports the central manifest + NodeProtocol + declared resources /
 * adapters / contracts from here, so the module installs and executes through
 * pinned package resources with no global lookup
 * (WAVE10-EXTENSIBILITY-SPEC §0.13.10).
 *
 *   import {
 *     humanDirectorApprovalManifest,
 *     DIRECTOR_SIGNOFF_NODE_PROTOCOL,
 *     HUMAN_DIRECTOR_RESOURCE_INDEX,
 *     HUMAN_DIRECTOR_HANDLER_REFS,
 *   } from '../src/index.ts';
 *
 * Import-boundary proof (WAVE10-EXTENSIBILITY-SPEC §4): this barrel
 * re-exports ONLY symbols defined in this package, which themselves import ONLY
 * from `domain/spi/`. The transitive import set never touches `src/index.ts`,
 * `modules/catalog.ts`, the composition root, or any existing module — that is
 * the §0.13.10 extensibility proof.
 */

export {
  // Pure module definition.
  humanDirectorApprovalModule,
  // Module identity + constants.
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
  HUMAN_DIRECTOR_APPROVAL_RUNTIME_COMPATIBILITY_RANGE,
  HUMAN_DIRECTOR_INPUT_SCHEMA,
  HUMAN_DIRECTOR_OUTPUT_SCHEMA,
  HUMAN_DIRECTOR_INTERACTION_CONTRACT,
  DIRECTOR_CONSOLE_ADAPTER_REF,
} from './definition.ts';

export {
  // Central manifest (validated at module load).
  humanDirectorApprovalManifest,
  // Manifest format + declared package surface.
  HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION,
  HUMAN_DIRECTOR_RESOURCE_INDEX,
  HUMAN_DIRECTOR_ADAPTER_REFS,
  HUMAN_DIRECTOR_HANDLER_REFS,
  HUMAN_DIRECTOR_INPUT_CONTRACT_REF,
  HUMAN_DIRECTOR_OUTPUT_CONTRACT_REF,
  HUMAN_DIRECTOR_MODULE_KEY,
} from './manifest.ts';

export {
  // Director sign-off NodeProtocol (validated at module load).
  DIRECTOR_SIGNOFF_NODE_PROTOCOL,
  DIRECTOR_SIGNOFF_PROTOCOL_ID,
  DIRECTOR_SIGNOFF_OWNING_FLOW_NODE_ID,
  DIRECTOR_SIGNOFF_NODE_RESOURCES,
  DIRECTOR_SIGNOFF_NODE_HANDLER_REFS,
  validateDirectorSignoffNodeProtocol,
} from './node-protocols/director-signoff-node-protocol.ts';
