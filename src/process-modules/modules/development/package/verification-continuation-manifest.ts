import type { ProcessModuleManifest } from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../../modules/development/domain/development-kernel-ports.js';
import { developmentVerificationContinuationProcessModule } from '../development-verification-continuation-process-module.js';
import { developmentPackageManifest } from './manifest.js';

export const developmentVerificationContinuationPackageManifest:
ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    ...developmentPackageManifest,
    definition: developmentVerificationContinuationProcessModule,
    handlerRefs: [
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.adoptVerificationBaseline,
        version: '1.0.0',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.settleVerificationContinuation,
        version: '1.0.0',
        digest: PENDING_DIGEST,
      },
    ],
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      'development verification continuation package manifest invalid: '
      + validation.errors.map(error => `${error.path}:${error.code}`).join(', '),
    );
  }
  return manifest;
})();
