/**
 * Documentation workshop package manifest.
 *
 * Mirrors the delivery/formalization manifest pattern: pure data, validated at
 * module load, content-addressed at install. Resources (skills, checklists,
 * call templates, tracker) live under `package/resources/`; the shared worker
 * protocol skill stays a PLATFORM resource pinned from the repo root.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handlerImplementationDigest } from '../../../installation/domain/handler-implementation-digest.js';

import type {
  HandlerRef,
  ProcessModuleManifest,
  ResourceIndexEntry,
} from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import type { ContractRef } from '../../../domain/spi/contract-ref.js';
import { CONTRACT_REF_PENDING_DIGEST } from '../../../domain/spi/contract-ref.js';
import { documentationProcessModule } from '../documentation-process-module.js';
import { DOCUMENTATION_KERNEL_HANDLER_IDS } from '../../../../modules/documentation/domain/documentation-kernel-ports.js';
import { DOCUMENTATION_RELEASE_CASE_SCHEMA, DOCUMENTATION_BUNDLE_SCHEMA } from '../../../../modules/documentation/domain/documentation-schemas.js';

export const DOCUMENTATION_MANIFEST_FORMAT_VERSION = '1';
export const DOCUMENTATION_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';
export const DOCUMENTATION_MODULE_KEY =
  `${documentationProcessModule.identity.name}@${documentationProcessModule.identity.version}`;

const RESOURCE_ROOT =
  'src/process-modules/modules/documentation/package/resources';
const RESOURCE_PATHS = {
  writerSkill: `${RESOURCE_ROOT}/skills/saga-documentation-writer/SKILL.md`,
  protocolSkill: 'skills/saga-process-module-worker-protocol/SKILL.md',
  writerChecklist: `${RESOURCE_ROOT}/documentation-writer-checklist.md`,
  reviewerChecklist: `${RESOURCE_ROOT}/documentation-reviewer-checklist.md`,
  submissionCallTemplate: `${RESOURCE_ROOT}/document-submit-call-template.json`,
  reviewCallTemplate: `${RESOURCE_ROOT}/review-verdict-call-template.json`,
  stageTracker: `${RESOURCE_ROOT}/process-module-stage-tracker.md`,
} as const;

export const DOCUMENTATION_RESOURCE_INDEX: readonly ResourceIndexEntry[] = [
  {
    logicalId: 'documentation.skill.writer',
    path: RESOURCE_PATHS.writerSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.skill.process-protocol',
    path: RESOURCE_PATHS.protocolSkill,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.checklist.writer',
    path: RESOURCE_PATHS.writerChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.checklist.reviewer',
    path: RESOURCE_PATHS.reviewerChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.template.document-submit-call',
    path: RESOURCE_PATHS.submissionCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.template.review-verdict-call',
    path: RESOURCE_PATHS.reviewCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'documentation.tracker.stage',
    path: RESOURCE_PATHS.stageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
];

const HANDLER_VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const DOCUMENTATION_HANDLER_IMPLEMENTATION_DIGEST = handlerImplementationDigest(
  HERE,
  '../../../../modules/documentation/application/documentation-installation.js',
  'documentation',
);

function documentationHandlerRef(logicalId: string): HandlerRef {
  return {
    logicalId,
    version: HANDLER_VERSION,
    digest: DOCUMENTATION_HANDLER_IMPLEMENTATION_DIGEST,
  };
}

export const DOCUMENTATION_HANDLER_REFS: readonly HandlerRef[] = [
  documentationHandlerRef(DOCUMENTATION_KERNEL_HANDLER_IDS.assemble),
  documentationHandlerRef(DOCUMENTATION_KERNEL_HANDLER_IDS.render),
  documentationHandlerRef(DOCUMENTATION_KERNEL_HANDLER_IDS.settle),
];

function documentationContractRef(schemaId: string): ContractRef {
  return {
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  };
}

export const DOCUMENTATION_INPUT_CONTRACT_REF: ContractRef =
  documentationContractRef(DOCUMENTATION_RELEASE_CASE_SCHEMA);
export const DOCUMENTATION_OUTPUT_CONTRACT_REF: ContractRef =
  documentationContractRef(DOCUMENTATION_BUNDLE_SCHEMA);

export const documentationPackageManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: DOCUMENTATION_MANIFEST_FORMAT_VERSION,
    definition: documentationProcessModule,
    resourceIndex: DOCUMENTATION_RESOURCE_INDEX,
    handlerRefs: DOCUMENTATION_HANDLER_REFS,
    inputContractRef: DOCUMENTATION_INPUT_CONTRACT_REF,
    outputContractRef: DOCUMENTATION_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange: DOCUMENTATION_RUNTIME_COMPATIBILITY_RANGE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `documentation package manifest failed validation:\n${rendered}`,
    );
  }
  return manifest;
})();
