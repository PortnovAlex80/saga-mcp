import type { ProcessModuleManifest } from '../../../domain/spi/module-manifest.js';
import {
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../../modules/development/domain/development-kernel-ports.js';
import { developmentVerificationContinuationProcessModule } from '../development-verification-continuation-process-module.js';
import { developmentPackageManifest } from './manifest.js';
import { handlerImplementationDigest } from '../../../installation/domain/handler-implementation-digest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Content address of the development verification-continuation installation
 * module — the module that creates the verification-adoption handler pinned
 * below (the settle handler is a versioned handler from the main development
 * installation, whose digest the main manifest pins). Computed by the
 * canonical shared digester (K3): sha256 over the module's raw bytes,
 * resolved from THIS manifest's directory. K4's RuntimePackageFingerprint
 * will supersede per-package pins with the full executable-contract digest.
 */
const VERIFICATION_CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST
  = handlerImplementationDigest(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../modules/development/infrastructure/sqlite-development-verification-adoption.js',
    'development-verification-continuation',
  );

export const developmentVerificationContinuationPackageManifest:
ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    ...developmentPackageManifest,
    definition: developmentVerificationContinuationProcessModule,
    handlerRefs: [
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.adoptVerificationBaseline,
        version: '1.0.0',
        digest: VERIFICATION_CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST,
      },
      {
        logicalId: DEVELOPMENT_KERNEL_HANDLER_IDS.settleVerificationContinuation,
        version: '1.0.0',
        digest: VERIFICATION_CONTINUATION_HANDLER_IMPLEMENTATION_DIGEST,
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
