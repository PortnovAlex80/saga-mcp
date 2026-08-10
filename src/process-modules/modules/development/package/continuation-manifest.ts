import type { ProcessModuleManifest } from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../../modules/development/domain/development-kernel-ports.js';
import { developmentContinuationProcessModule } from '../development-continuation-process-module.js';
import { developmentPackageManifest } from './manifest.js';

const ROOT =
  'src/process-modules/modules/development/package/resources/managed-source';

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
        digest: PENDING_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeContinuationCandidate,
        version: '1.0.0',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.settleContinuation,
        version: '1.0.0',
        digest: PENDING_DIGEST,
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
