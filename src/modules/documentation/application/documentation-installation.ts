/**
 * Documentation workshop — kernel handlers, output resolver, wiring seam.
 *
 * Three deterministic handlers drive the flow:
 *   assemble — validate the case, observe the repository at the EXACT
 *              integrated commit, emit one fan-out brief per document kind;
 *   render   — render every accepted document product to PDF through the
 *              injected provider (typed blocked when the engine is missing);
 *   settle   — verify the complete rendered workset and issue the module
 *              certificate + outcome.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { KernelHandler } from '../../../process-modules/application/kernel-handler-registry.js';
import type { ProcessOutputPayloadResolver } from '../../../process-modules/application/lifecycle-orchestrator.js';
import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
import type {
  ModuleCompletion,
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/index.js';
import type { ProcessModuleExecutionContext } from '../../../process-modules/application/process-module-executor.js';
import type { NodeExecutionResult } from '../../../process-modules/application/node-executor.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import type { ProcessOutcomeCertificateRepository } from '../../../process-modules/persistence/process-outcome-certificate-repository.js';
import type { IssueProcessOutcomeCertificateCommand } from '../../../process-modules/persistence/process-outcome-certificate.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import { DOCUMENTATION_PROCESS_MODULE_REF } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import type {
  DocumentationOutputRepository,
  DocumentationProductReader,
  DocumentationRenderProvider,
  DocumentationRepositoryObservationPort,
} from '../domain/documentation-kernel-ports.js';
import {
  DOCUMENTATION_BUNDLE_SCHEMA,
  DOCUMENTATION_CERTIFICATE_SCHEMA,
  DOCUMENTATION_DOCUMENT_SCHEMA,
  DOCUMENTATION_KINDS,
  DOCUMENTATION_PLAN_SCHEMA,
  DOCUMENTATION_RELEASE_CASE_SCHEMA,
  type DocumentationBundle,
  type DocumentationDocument,
  type DocumentationPlan,
  type DocumentationReleaseCase,
} from '../domain/documentation-schemas.js';

export interface DocumentationModuleInstallationDependencies {
  readonly productReader: DocumentationProductReader;
  readonly renderProvider: DocumentationRenderProvider;
  readonly repositoryObservation: DocumentationRepositoryObservationPort;
  readonly outputRepository: DocumentationOutputRepository;
  readonly certificateRepo: ProcessOutcomeCertificateRepository;
}

export function createDocumentationKernelHandlers(
  deps: DocumentationModuleInstallationDependencies,
): Record<string, KernelHandler> {
  return {
    'documentation-case-assembler': createCaseAssembler(deps),
    'documentation-renderer': createRenderer(deps),
    'documentation-settlement-policy': createSettlement(deps),
  };
}

// ---------------------------------------------------------------------------
// Assembler.
// ---------------------------------------------------------------------------

/** Deterministically selected repository files embedded into briefs. */
const BRIEF_FILE_PATTERNS = [
  /^README(\.[a-zA-Z0-9]+)?$/i,
  /^package\.json$/i,
  /^pyproject\.toml$/i,
  /^Cargo\.toml$/i,
  /^go\.mod$/i,
  /^Dockerfile$/i,
  /^docker-compose\.ya?ml$/i,
  /^Makefile$/i,
  /^src\/index\.[a-z]+$/i,
  /^src\/main\.[a-z]+$/i,
  /^src\/app\.[a-z]+$/i,
];
const BRIEF_MAX_FILE_BYTES = 24 * 1024;
const BRIEF_MAX_EXCERPTS = 12;
const BRIEF_MAX_TREE_ENTRIES = 400;

function createCaseAssembler(
  deps: DocumentationModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    try {
      const releaseCase = requireReleaseCase(ctx.input);
      // Single-repository MVP: the integrated candidate snapshot selects the
      // exact repo observation target. Zero or multiple repos degrade to an
      // SRS-only brief (documented honestly, never guessed).
      const repository = releaseCase.candidateRepositories.length === 1
        ? releaseCase.candidateRepositories[0]!
        : null;
      const tree = repository !== null
        ? deps.repositoryObservation.listTree(
          repository.projectRepositoryId, repository.commitSha)
        : [];
      const selected = tree
        .filter(filePath => BRIEF_FILE_PATTERNS.some(pattern => pattern.test(filePath)))
        .slice(0, BRIEF_MAX_EXCERPTS);
      const fileExcerpts = selected.map(filePath => ({
        path: filePath,
        ...(repository !== null
          ? deps.repositoryObservation.readFileAt(
            repository.projectRepositoryId,
            repository.commitSha,
            filePath,
            BRIEF_MAX_FILE_BYTES,
          ) ?? { bytes: '', truncated: false }
          : { bytes: '', truncated: false }),
      })).filter(excerpt => excerpt.bytes.length > 0);
      const documents = releaseCase.documentKinds.map(kind => {
        const definition = DOCUMENTATION_KINDS[kind]!;
        return {
          // `id` mirrors the kind: the stable fan-out item identity the cell
          // materializer derives workKeys from (extractItems contract).
          id: definition.id,
          kind: definition.id,
          kindTitle: definition.title,
          productSubject: releaseCase.srs && typeof releaseCase.srs === 'object'
            && typeof (releaseCase.srs as Record<string, unknown>).productSubject === 'string'
            ? String((releaseCase.srs as Record<string, unknown>).productSubject)
            : `product candidate ${releaseCase.integratedCandidateHash.slice(0, 12)}`,
          candidateHash: releaseCase.integratedCandidateHash,
          repositoryTree: tree.slice(0, BRIEF_MAX_TREE_ENTRIES),
          fileExcerpts,
          srs: releaseCase.srs,
          acceptanceCriteria: releaseCase.acceptanceCriteria,
          requiredSections: definition.requiredSections,
        };
      });
      const plan: DocumentationPlan = {
        schemaVersion: DOCUMENTATION_PLAN_SCHEMA,
        candidateHash: releaseCase.integratedCandidateHash,
        outputRoot: releaseCase.outputRoot,
        documents,
      };
      const semanticDigest = sha256Hex({
        candidateHash: plan.candidateHash,
        kinds: plan.documents.map(item => item.kind).sort(),
      });
      return {
        event: 'ready',
        production: {
          schema: DOCUMENTATION_PLAN_SCHEMA,
          artifactRef: `documentation-plan:${ctx.processRunId}:${semanticDigest}`,
          contentHash: sha256Hex(plan),
          semanticDigest,
          bindings: { documents: plan.documents, candidateHash: plan.candidateHash, outputRoot: plan.outputRoot },
        },
      };
    } catch (error) {
      return {
        event: 'failed',
        production: {
          schema: DOCUMENTATION_PLAN_SCHEMA,
          artifactRef: `documentation-plan-failed:${ctx.processRunId}:${sha256Hex(String(error))}`,
          contentHash: sha256Hex({ processRunId: ctx.processRunId, error: String(error) }),
          bindings: { assemblyError: String(error) },
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------

function createRenderer(
  deps: DocumentationModuleInstallationDependencies,
): KernelHandler {
  return async ctx => {
    try {
      const plan = requirePlanFromFrame(ctx.frame);
      const cellManifest = ctx.frame.productions['author-documents'];
      const items = Array.isArray(
        (cellManifest?.bindings as Record<string, unknown> | undefined)?.items,
      )
        ? ((cellManifest!.bindings as Record<string, unknown>).items as readonly {
          workKey: string;
          accepted: boolean;
          products?: readonly ProductRef[];
        }[])
        : [];
      const acceptedItems = items.filter(item => item.accepted && item.products?.length);
      if (acceptedItems.length !== plan.documents.length) {
        return {
          event: 'failed',
          production: failedProduction(ctx.processRunId,
            `render expected ${plan.documents.length} accepted documents, found ${acceptedItems.length}`),
        };
      }
      const capability = deps.renderProvider.probe();
      if (!capability.available) {
        // Honest typed boundary: PDF engine/fonts missing must BLOCK, never
        // silently degrade or fabricate a release (CONVEYOR §17 unknown rule).
        return {
          event: 'blocked',
          production: failedProduction(ctx.processRunId, capability.reason),
        };
      }
      mkdirSync(plan.outputRoot, { recursive: true });
      const rendered = [];
      for (const item of acceptedItems) {
        const productRef = item.products!.find(
          product => product.schemaId === DOCUMENTATION_DOCUMENT_SCHEMA,
        );
        if (!productRef) {
          return {
            event: 'failed',
            production: failedProduction(ctx.processRunId,
              `workplace '${item.workKey}' has no ${DOCUMENTATION_DOCUMENT_SCHEMA} product`),
          };
        }
        const payload = deps.productReader.readProductPayload({
          schemaId: productRef.schemaId,
          ref: productRef.ref,
          digest: productRef.digest,
        });
        const document = payload as DocumentationDocument;
        const outputPath = path.join(plan.outputRoot, `${document.documentKind}.pdf`);
        const result = await deps.renderProvider.render({ document, outputPath });
        rendered.push({
          kind: document.documentKind,
          documentRef: {
            schemaId: productRef.schemaId,
            ref: productRef.ref,
            digest: productRef.digest,
          },
          pdfFileName: result.pdfFileName,
          pdfByteHash: result.pdfByteHash,
          pdfByteSize: result.pdfByteSize,
          renderer: { id: deps.renderProvider.id, version: deps.renderProvider.version },
        });
      }
      const bundleBody: Omit<DocumentationBundle, 'bundleHash'> = {
        schemaVersion: DOCUMENTATION_BUNDLE_SCHEMA,
        candidateHash: plan.candidateHash,
        outputRoot: plan.outputRoot,
        renderedAt: new Date().toISOString(),
        documents: rendered,
      };
      const bundle: DocumentationBundle = {
        ...bundleBody,
        bundleHash: sha256Hex(bundleBody),
      };
      const persisted = deps.outputRepository.persistBundle({
        processRunId: ctx.processRunId,
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        payload: bundle,
      });
      const semanticDigest = sha256Hex({
        candidateHash: bundle.candidateHash,
        documents: bundle.documents
          .map(doc => ({ kind: doc.kind, documentDigest: doc.documentRef.digest }))
          .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
      });
      return {
        event: 'rendered',
        production: {
          schema: DOCUMENTATION_BUNDLE_SCHEMA,
          artifactRef: persisted.record.artifactRef,
          contentHash: persisted.record.contentHash,
          semanticDigest,
          bindings: {
            bundleRef: persisted.record.artifactRef,
            bundleHash: persisted.record.contentHash,
            documents: bundle.documents,
            outputRoot: bundle.outputRoot,
            replayed: persisted.replayed,
          },
        },
      };
    } catch (error) {
      return {
        event: 'failed',
        production: failedProduction(ctx.processRunId, String(error)),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Settlement.
// ---------------------------------------------------------------------------

function createSettlement(
  deps: DocumentationModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    try {
      const plan = requirePlanFromFrame(ctx.frame);
      const renderProduction = ctx.frame.productions['render-documentation-bundle'];
      const bindings = (renderProduction?.bindings ?? {}) as Record<string, unknown>;
      let decision: 'documented' | 'blocked' | 'failed';
      const reasonCodes: string[] = [];
      let bundleRef: string | null = null;
      let bundleHash: string | null = null;

      if (bindings.bundleRef && bindings.bundleHash) {
        const stored = deps.outputRepository.readByProcessRun(ctx.processRunId);
        const renderedKinds = new Set(
          ((stored?.payload.documents ?? []) as readonly { kind: string }[])
            .map(doc => doc.kind),
        );
        const missing = plan.documents
          .map(item => item.kind)
          .filter(kind => !renderedKinds.has(kind));
        if (stored && missing.length === 0) {
          decision = 'documented';
          bundleRef = stored.artifactRef;
          bundleHash = stored.contentHash;
        } else {
          decision = 'failed';
          reasonCodes.push('rendered-workset-incomplete');
        }
      } else {
        // The render node typed-blocked (engine unavailable) or failed.
        decision = renderProduction ? 'blocked' : 'failed';
        reasonCodes.push('render-not-available');
      }

      const certificateBody = {
        decision,
        reasonCodes,
        rationale: decision === 'documented'
          ? 'Every planned document kind has an accepted product and a deterministic PDF render receipt.'
          : 'Documentation settlement failed closed; see reasonCodes.',
        candidateHash: plan.candidateHash,
        bundleRef,
        bundleHash,
        documentKinds: plan.documents.map(item => item.kind),
      };
      const certificatePayload = {
        schemaVersion: DOCUMENTATION_CERTIFICATE_SCHEMA,
        decision,
        reasonCodes,
        rationale: certificateBody.rationale,
        inputHash: sha256Hex(plan),
        payload: certificateBody,
      };
      const certificateHash = sha256Hex(certificatePayload);
      const issued = deps.certificateRepo.issue({
        processRunId: ctx.processRunId,
        moduleRef: DOCUMENTATION_PROCESS_MODULE_REF,
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        payload: certificatePayload,
        certificateHash,
        authority: 'documentation_settlement_policy',
      } satisfies IssueProcessOutcomeCertificateCommand);
      const certificateRef: ProductRef = {
        schemaId: DOCUMENTATION_CERTIFICATE_SCHEMA,
        ref: `certificate:${issued.record.id}`,
        digest: issued.record.certificateHash,
      };
      return {
        event: decision,
        production: {
          schema: DOCUMENTATION_BUNDLE_SCHEMA,
          artifactRef: bundleRef ?? `documentation-settlement:${ctx.processRunId}:${certificateHash}`,
          contentHash: bundleHash ?? certificateHash,
          bindings: {
            bundleRef,
            bundleHash,
            documentKinds: certificateBody.documentKinds,
            authority: 'documentation_settlement_policy',
          },
        },
        completion: moduleCompletion(decision, certificateRef),
      };
    } catch (error) {
      return {
        event: 'failed',
        production: failedProduction(ctx.processRunId, String(error)),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Output resolvers (module + lifecycle hand-off).
// ---------------------------------------------------------------------------

export function createDocumentationOutputResolver(
  outputRepository: DocumentationOutputRepository,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (module, terminalOutcome, terminalResult, context) => {
    if (terminalOutcome !== 'documented') return null;
    assertDocumentationModule(module);
    const bindings = terminalResult.production?.bindings ?? {};
    const artifactRef = stringBinding(bindings, 'bundleRef');
    const contentHash = stringBinding(bindings, 'bundleHash');
    const record = outputRepository.readByProcessRun(context.processRunId);
    if (!record || record.artifactRef !== artifactRef
      || record.contentHash !== contentHash) {
      throw new Error('DOCUMENTATION_OUTPUT_BINDING_MISMATCH');
    }
    return {
      schema: record.payload.schemaVersion,
      artifactRef: record.artifactRef,
      contentHash: record.contentHash,
    };
  };
}

function assertDocumentationModule(
  module: ProcessModuleDefinition,
): void {
  if (module.identity.name !== DOCUMENTATION_PROCESS_MODULE_REF.name) {
    throw new Error(`DOCUMENTATION_MODULE_MISMATCH: ${module.identity.name}`);
  }
}

function stringBinding(
  bindings: Record<string, unknown>,
  key: string,
): string {
  const value = bindings[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`DOCUMENTATION_OUTPUT_BINDING_MISSING: ${key}`);
  }
  return value;
}

export function createDocumentationLifecycleOutputPayloadResolver(
  outputRepository: DocumentationOutputRepository,
): ProcessOutputPayloadResolver {
  return ({ processRunId }) => {
    const record = outputRepository.readByProcessRun(processRunId);
    return record ? record.payload
      : { schemaVersion: DOCUMENTATION_BUNDLE_SCHEMA, documents: [] };
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function moduleCompletion(outcome: string, certificateRef: ProductRef): ModuleCompletion {
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  return { outcome, outputEnvelope, terminal: true };
}

function requireReleaseCase(input: unknown): DocumentationReleaseCase {
  if (!input || typeof input !== 'object') {
    throw new Error('DOCUMENTATION_CASE_REQUIRED');
  }
  const value = input as DocumentationReleaseCase;
  if (value.schemaVersion !== DOCUMENTATION_RELEASE_CASE_SCHEMA) {
    throw new Error('DOCUMENTATION_CASE_SCHEMA_MISMATCH');
  }
  if (!Array.isArray(value.documentKinds) || value.documentKinds.length === 0) {
    throw new Error('DOCUMENTATION_CASE_KINDS_REQUIRED');
  }
  for (const kind of value.documentKinds) {
    if (!Object.hasOwn(DOCUMENTATION_KINDS, kind)) {
      throw new Error(`DOCUMENTATION_CASE_KIND_UNKNOWN: ${kind}`);
    }
  }
  if (typeof value.outputRoot !== 'string' || value.outputRoot.trim().length === 0) {
    throw new Error('DOCUMENTATION_CASE_OUTPUT_ROOT_REQUIRED');
  }
  if (typeof value.integratedCandidateHash !== 'string'
    || value.integratedCandidateHash.trim().length === 0) {
    throw new Error('DOCUMENTATION_CASE_CANDIDATE_REQUIRED');
  }
  if (!Array.isArray(value.candidateRepositories)) {
    throw new Error('DOCUMENTATION_CASE_REPOSITORIES_REQUIRED');
  }
  return value;
}

function requirePlan(input: unknown): DocumentationPlan {
  if (!input || typeof input !== 'object') {
    throw new Error('DOCUMENTATION_PLAN_REQUIRED');
  }
  const value = input as DocumentationPlan;
  if (value.schemaVersion !== DOCUMENTATION_PLAN_SCHEMA) {
    throw new Error('DOCUMENTATION_PLAN_SCHEMA_MISMATCH');
  }
  if (!Array.isArray(value.documents) || value.documents.length === 0) {
    throw new Error('DOCUMENTATION_PLAN_EMPTY');
  }
  return value;
}

/**
 * Read the assembler's plan from the EXECUTION FRAME (canonical post-cell
 * input path). The generic executor chains `ctx.input` = the previous node's
 * output, so a kernel downstream of the authoring Cell receives the cell
 * manifest — the plan lives in the durable frame production of the
 * ASSEMBLER node (replay-safe: the frame is assembled from durable NodeRuns).
 */
function requirePlanFromFrame(
  frame: { readonly productions: Record<string, { readonly bindings?: unknown }> },
): DocumentationPlan {
  const production = frame.productions['assemble-documentation-case'];
  const bindings = (production?.bindings ?? {}) as Record<string, unknown>;
  return requirePlan({
    schemaVersion: DOCUMENTATION_PLAN_SCHEMA,
    candidateHash: bindings.candidateHash,
    outputRoot: bindings.outputRoot,
    documents: bindings.documents,
  });
}

function failedProduction(processRunId: number, error: string) {
  return {
    schema: DOCUMENTATION_BUNDLE_SCHEMA,
    artifactRef: `documentation-failed:process-run:${processRunId}:${sha256Hex(error)}`,
    contentHash: sha256Hex({ processRunId, error }),
    bindings: { error },
  };
}
