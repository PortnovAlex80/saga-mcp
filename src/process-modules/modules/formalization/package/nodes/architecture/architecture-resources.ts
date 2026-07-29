/**
 * W8-A5 — Package-local resources for the Formalization architecture lane.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 *       lane W8-A5 (architecture + recovery node protocols + package-local
 *       resources).
 * Plan: §0.11.6, §5.5.1 (resolve every declared resource under the package root).
 *
 * This file owns the ResourceIndexEntry declarations the architecture node
 * protocols reference by `logicalId`. Every entry is pure canonical data
 * (`ResourceIndexEntry` from Wave 1 SPI — `domain/spi/resource-index.ts`). The
 * central Formalization package manifest (W8-A1) is the ONLY lane that edits
 * the manifest; this lane OWNS these entries and SUBMITS them to W8-A1 (plan
 * §0.11.10). `ARCHITECTURE_RESOURCE_ENTRIES` is the authoritative set W8-A1
 * merges into the manifest's `resourceIndex`.
 *
 * Resource paths are package-relative (plan §5.5.1). W13-A2 moved the
 * formalization resources out of the legacy global root
 * (`tool-templates/formalization/`, `skills/`) into the formalization package
 * resources directory (`src/process-modules/modules/formalization/package/
 * resources/`). These repo-root-relative POSIX paths are the immutable,
 * content-addressed resources the architecture node resolves at runtime. The
 * shared `saga-process-module-worker-protocol` skill stays a PLATFORM resource
 * under `skills/` (pinned by every process module).
 *
 * `digest` uses the documented `'pending@wave-2'` placeholder — the Wave 2
 * content-addressed installer replaces it with the real `sha256Hex` of the
 * resource bytes at install time. This is the sanctioned Wave 1/8 convention.
 *
 * PURE: data only.
 */

import type { ResourceIndexEntry } from '../../../../../domain/spi/resource-index.js';

import { ARCHITECTURE_RESOURCE_IDS } from './srs-node-protocol.js';

/**
 * The package-local resource entries owned by the architecture lane.
 *
 * Ordered by the role they play in the protocol: skills first (semantic +
 * execution + review + protocol), then the per-node checklist + stage tracker,
 * then the MCP call templates, then the schema contract references.
 *
 * `logicalId` values are module-namespaced and unique within this lane; W8-A1
 * guarantees global uniqueness when merging into the manifest.
 */
export const ARCHITECTURE_RESOURCE_ENTRIES: readonly ResourceIndexEntry[] = Object.freeze([
  // ---- Skills (semantic, execution, review, protocol) ----
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.architectSkill,
    path: 'src/process-modules/modules/formalization/package/resources/skills/saga-architect/SKILL.md',
    kind: 'skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.reviewerSkill,
    path: 'src/process-modules/modules/formalization/package/resources/skills/saga-architecture-reviewer/SKILL.md',
    kind: 'reviewer-skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.protocolSkill,
    path: 'skills/saga-process-module-worker-protocol/SKILL.md',
    kind: 'skill',
    digest: 'pending@wave-2',
  },

  // ---- Checklist + stage tracker ----
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.checklist,
    path: 'src/process-modules/modules/formalization/package/resources/formalization-node-checklist.md',
    kind: 'checklist',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.trackerTemplate,
    path: 'src/process-modules/modules/formalization/package/resources/process-module-stage-tracker.md',
    kind: 'template',
    digest: 'pending@wave-2',
  },

  // ---- MCP call templates ----
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.artifactCallTemplate,
    path: 'src/process-modules/modules/formalization/package/resources/artifact-create-call-template.json',
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.traceCallTemplate,
    path: 'src/process-modules/modules/formalization/package/resources/trace-add-call-template.json',
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.doneCallTemplate,
    path: 'src/process-modules/modules/formalization/package/resources/worker-done-call-template.json',
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },

  // ---- Schema contract references ----
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.srsSchema,
    path: 'src/process-modules/modules/formalization/formalization-schemas.ts',
    kind: 'schema',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.architectureBundleSchema,
    path: 'src/process-modules/modules/formalization/formalization-schemas.ts',
    kind: 'schema',
    digest: 'pending@wave-2',
  },
  {
    logicalId: ARCHITECTURE_RESOURCE_IDS.workIntentSchema,
    path: 'src/process-modules/modules/formalization/formalization-schemas.ts',
    kind: 'schema',
    digest: 'pending@wave-2',
  },
]);

/**
 * Contract-ref values the architecture node protocols pin. Centralized here so
 * the protocol files and any future manifest contractRefs cannot drift. Wave 2
 * replaces `pending@wave-2` digests with real schema-document hashes.
 */
export const ARCHITECTURE_CONTRACT_REFS = {
  srs: {
    schemaId: 'saga3.srs.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  architectureBundle: {
    schemaId: 'saga3.formalization-architecture-bundle.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  acceptanceBaseline: {
    schemaId: 'saga3.acceptance-baseline-snapshot.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  architectureGate: {
    schemaId: 'saga3.architecture-gate.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  recoveryIssue: {
    schemaId: 'saga3.recovery-issue.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
} as const;
