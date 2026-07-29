// @ts-check
/**
 * W8-A4 — Resource index for the acceptance + reconciliation subtree.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a4.md`.
 * Plan: §0.11.5 + §0.11.10 — only W8-A1 edits the central Formalization
 * manifest; other lanes create isolated node subtrees and submit manifest
 * entries to W8-A1. This file IS that submission: the declarative
 * `ResourceIndexEntry[]` for every package-local resource the acceptance +
 * reconciliation node protocols reference.
 *
 * Each entry mirrors `ResourceIndexEntry` from
 * `src/process-modules/domain/spi/resource-index.ts`:
 *   - `logicalId`  stable, module-namespaced id (unique within this subtree).
 *   - `path`       module-relative POSIX path under the formalization package
 *                  root (`modules/formalization/package/`).
 *   - `kind`       one of the frozen `RESOURCE_KINDS`.
 *   - `digest`     `sha256Hex` of the resource bytes, OR the documented
 *                  placeholder `'pending@wave-2'` until the Wave 2
 *                  content-addressed installer computes the real hash.
 *
 * Pure data only (plan §3.5). W8-A1 imports `ACCEPTANCE_RESOURCE_INDEX` and
 * concatenates it into the central manifest's `resourceIndex`, enforcing
 * `logicalId` uniqueness across the whole package.
 */

import {
  ACCEPTANCE_RESOURCE_PATHS,
} from './acceptance-node-protocol.mjs';
import {
  RECONCILIATION_RESOURCE_PATHS,
} from './reconciliation-node-protocol.mjs';

/**
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 */

/**
 * The acceptance + reconciliation subtree's resource index. Every protocol
 * step `resources[]` path MUST appear here exactly once — the W8-A8 package
 * isolation conformance test asserts that closure
 * (no protocol references an undeclared resource, no declared resource is
 * unreferenced).
 *
 * `digest` uses the documented `'pending@wave-2'` placeholder for every entry:
 * Wave 2's content-addressed installer replaces it with the real `sha256Hex`
 * of the on-disk bytes at install time.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const ACCEPTANCE_RESOURCE_INDEX = Object.freeze([
  // ---- Acceptance (AC) author + resolver resources ----
  {
    logicalId: 'formalization.acceptance.author-skill',
    path: ACCEPTANCE_RESOURCE_PATHS.AC_SKILL,
    kind: 'skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.reviewer-skill',
    path: ACCEPTANCE_RESOURCE_PATHS.AC_REVIEW_SKILL,
    kind: 'reviewer-skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.artifact-create-call',
    path: ACCEPTANCE_RESOURCE_PATHS.ARTIFACT_CALL,
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.trace-add-call',
    path: ACCEPTANCE_RESOURCE_PATHS.TRACE_CALL,
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.worker-done-call',
    path: ACCEPTANCE_RESOURCE_PATHS.DONE_CALL,
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.node-checklist',
    path: ACCEPTANCE_RESOURCE_PATHS.CHECKLIST,
    kind: 'checklist',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.acceptance.bundle-schema',
    path: ACCEPTANCE_RESOURCE_PATHS.BUNDLE_SCHEMA,
    kind: 'schema',
    digest: 'pending@wave-2',
  },

  // ---- Reconciliation trio resources ----
  {
    logicalId: 'formalization.reconciliation.reconciler-skill',
    path: RECONCILIATION_RESOURCE_PATHS.RECONCILER_SKILL,
    kind: 'skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.reviewer-skill',
    path: RECONCILIATION_RESOURCE_PATHS.RECONCILER_REVIEW_SKILL,
    kind: 'reviewer-skill',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.trace-add-call',
    path: RECONCILIATION_RESOURCE_PATHS.TRACE_CALL,
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.worker-done-call',
    path: RECONCILIATION_RESOURCE_PATHS.DONE_CALL,
    kind: 'mcp-call-template',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.node-checklist',
    path: RECONCILIATION_RESOURCE_PATHS.CHECKLIST,
    kind: 'checklist',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.report-schema',
    path: RECONCILIATION_RESOURCE_PATHS.REPORT_SCHEMA,
    kind: 'schema',
    digest: 'pending@wave-2',
  },
  {
    logicalId: 'formalization.reconciliation.baseline-schema',
    path: RECONCILIATION_RESOURCE_PATHS.BASELINE_SCHEMA,
    kind: 'schema',
    digest: 'pending@wave-2',
  },
]);

/**
 * The set of logicalIds in this subtree, exported for the W8-A8 conformance
 * test (uniqueness-within-package check) and for W8-A1's manifest merge to
 * detect cross-subtree collisions early.
 *
 * @readonly
 * @returns {readonly string[]}
 */
export const ACCEPTANCE_RESOURCE_LOGICAL_IDS = Object.freeze(
  ACCEPTANCE_RESOURCE_INDEX.map((entry) => entry.logicalId),
);
