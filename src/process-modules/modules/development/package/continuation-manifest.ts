import type { ProcessModuleManifest } from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../../modules/development/domain/development-kernel-ports.js';
import { developmentContinuationProcessModule } from '../development-continuation-process-module.js';
import { developmentPackageManifest } from './manifest.js';
import { handlerImplementationDigest } from '../../shared/handler-implementation-digest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT =
  'src/process-modules/modules/development/package/resources/managed-source';

/**
 * Content address of the development continuation installation module — the
 * module that creates the continuation-specific handlers pinned below (the
 * versioned freeze/settle handlers come from the main development
 * installation, whose digest the main manifest pins). Computed by the
 * canonical shared digester (K3): sha256 over the module's raw bytes,
 * resolved from THIS manifest's directory. K4's RuntimePackageFingerprint
 * will supersede per-package pins with the full executable-contract digest.
 */
const CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST = handlerImplementationDigest(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../modules/development/infrastructure/development-continuation-installation.js',
  'development-continuation',
);

export const developmentContinuationPackageManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    ...developmentPackageManifest,
    definition: developmentContinuationProcessModule,
    resourceIndex: [
      ...developmentPackageManifest.resourceIndex,
      {
        logicalId: 'development.managed-source.author-skill',
        path: `${ROOT}/skills/saga-managed-source-author/SKILL.md`,
        kind: 'skill',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'development.managed-source.reviewer-skill',
        path: `${ROOT}/skills/saga-managed-source-reviewer/SKILL.md`,
        kind: 'reviewer-skill',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'development.managed-source.tracker',
        path: `${ROOT}/managed-source-tracker.md`,
        kind: 'template',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'development.managed-source.checklist',
        path: `${ROOT}/managed-source-checklist.md`,
        kind: 'checklist',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'development.managed-review.tracker',
        path: `${ROOT}/managed-review-tracker.md`,
        kind: 'template',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'development.managed-review.checklist',
        path: `${ROOT}/managed-review-checklist.md`,
        kind: 'checklist',
        digest: PENDING_DIGEST,
      },
    ],
    handlerRefs: [
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveContinuationTaskGraph,
        version: '1.0.0',
        digest: CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeContinuationCandidate,
        version: '1.0.0',
        digest: CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.settleContinuation,
        version: '1.0.0',
        digest: CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST,
      },
    ],
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `development continuation package manifest invalid: `
      + validation.errors.map(error => `${error.path}:${error.code}`).join(', '),
    );
  }
  return manifest;
})();
