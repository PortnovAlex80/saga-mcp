/**
 * Documentation workshop — pure domain schemas, document-kind registry and
 * payload validators.
 *
 * The workshop authors documents as STRUCTURED, schema-valid JSON products
 * (never raw PDF bytes): a worker product is `DocumentationDocument`, a
 * deterministic kernel provider renders it to PDF afterwards. This keeps the
 * conveyor boundary textual/content-addressed (CONVEYOR §1) and gives the
 * author gate an executable contract to check.
 */

// The lifecycle-referenced identity string lives canonically in the contracts
// module (single definition, byte-stable); imported here so `typeof` typing
// keeps working and re-exported so this file stays the module's schema-id
// surface for everything else.
import { DOCUMENTATION_RELEASE_CASE_SCHEMA } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
export { DOCUMENTATION_RELEASE_CASE_SCHEMA };

export const DOCUMENTATION_PLAN_SCHEMA = 'factory.documentation-plan.v1';
export const DOCUMENTATION_DOCUMENT_SCHEMA = 'factory.documentation-document.v1';
export const DOCUMENTATION_REVIEW_VERDICT_SCHEMA =
  'factory.documentation-review-verdict.v1';
export const DOCUMENTATION_BUNDLE_SCHEMA = 'factory.documentation-bundle.v1';
export const DOCUMENTATION_CERTIFICATE_SCHEMA =
  'factory.documentation-certificate.v1';

// ---------------------------------------------------------------------------
// Document kinds — the data-driven fan-out set.
//
// Adding a document kind is a registry entry (plus skill guidance in the
// writer/reviewer SKILL.md), never a flow change: the assembler kernel emits
// one plan item per requested kind and the authoring cell fans out over them.
// ---------------------------------------------------------------------------

export interface DocumentationKindDefinition {
  readonly id: string;
  /** Human title used as the rendered document's default heading. */
  readonly title: string;
  /** Section ids the completeness check provider requires (deterministic gate). */
  readonly requiredSections: readonly string[];
  readonly description: string;
}

export const DOCUMENTATION_KINDS: Readonly<Record<string, DocumentationKindDefinition>> = {
  'user-manual': {
    id: 'user-manual',
    title: 'Руководство пользователя',
    requiredSections: ['purpose', 'getting-started', 'usage', 'troubleshooting'],
    description: 'End-user guide: what the product does, how to start, typical scenarios, error recovery.',
  },
  'programmer-manual': {
    id: 'programmer-manual',
    title: 'Руководство программиста',
    requiredSections: ['architecture', 'code-structure', 'build-and-test', 'extension'],
    description: 'Developer guide: architecture decisions, module map, build/test loops, how to change safely.',
  },
  'operator-manual': {
    id: 'operator-manual',
    title: 'Руководство оператора',
    requiredSections: ['installation', 'configuration', 'run-and-monitor', 'recovery'],
    description: 'Operations guide: install, configure, run, observe, recover.',
  },
  'acceptance-report': {
    id: 'acceptance-report',
    title: 'Отчёт о приёмочных испытаниях',
    requiredSections: ['scope', 'criteria-results', 'verdict', 'appendix'],
    description: 'Acceptance test report compiled from the frozen candidate and verification evidence.',
  },
};

/** Default document set requested when the operator does not pick kinds. */
export const DEFAULT_DOCUMENTATION_KINDS: readonly string[] = [
  'user-manual',
  'programmer-manual',
  'acceptance-report',
];

export function isKnownDocumentationKind(id: string): boolean {
  return Object.hasOwn(DOCUMENTATION_KINDS, id);
}

// ---------------------------------------------------------------------------
// Input case (module input contract).
// ---------------------------------------------------------------------------

export interface DocumentationReleaseCase {
  readonly schemaVersion: typeof DOCUMENTATION_RELEASE_CASE_SCHEMA;
  readonly projectId: number;
  readonly epicId: number | null;
  readonly developmentCertificate: {
    readonly schema: string;
    readonly ref: string;
    readonly hash: string;
    readonly decision: 'verified';
  };
  readonly verifiedIntegrationBundle: {
    readonly schema: string;
    readonly ref: string;
    readonly hash: string;
  };
  /** Repository snapshots of the integrated candidate (single-repo MVP). */
  readonly candidateRepositories: readonly {
    readonly projectRepositoryId: number;
    readonly branch: string;
    readonly commitSha: string;
    readonly treeHash: string;
  }[];
  readonly integratedCandidateHash: string;
  /** Accepted SRS payload from Formalization (prose sections for briefs). */
  readonly srs: unknown;
  readonly acceptanceCriteria: readonly unknown[];
  /** Requested document kinds (validated against the registry). */
  readonly documentKinds: readonly string[];
  /** Absolute root directory for rendered PDF artifacts. */
  readonly outputRoot: string;
  readonly initiatedBy: string;
}

// ---------------------------------------------------------------------------
// Assembler kernel output — the fan-out plan.
// ---------------------------------------------------------------------------

export interface DocumentationBrief {
  /** Stable fan-out item identity (extractItems contract: string id). */
  readonly id: string;
  readonly kind: string;
  readonly kindTitle: string;
  readonly productSubject: string;
  readonly candidateHash: string;
  readonly repositoryTree: readonly string[];
  /** Capped excerpts of repository files selected deterministically. */
  readonly fileExcerpts: readonly {
    readonly path: string;
    readonly bytes: string;
    readonly truncated: boolean;
  }[];
  readonly srs: unknown;
  readonly acceptanceCriteria: readonly unknown[];
  readonly requiredSections: readonly string[];
}

export interface DocumentationPlan {
  readonly schemaVersion: typeof DOCUMENTATION_PLAN_SCHEMA;
  readonly candidateHash: string;
  readonly outputRoot: string;
  readonly documents: readonly DocumentationBrief[];
}

// ---------------------------------------------------------------------------
// Worker product — one structured document.
// ---------------------------------------------------------------------------

export type DocumentationBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly type: 'code'; readonly language: string; readonly text: string }
  | {
      readonly type: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface DocumentationSection {
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly DocumentationBlock[];
}

export interface DocumentationDocument {
  readonly schemaVersion: typeof DOCUMENTATION_DOCUMENT_SCHEMA;
  readonly documentKind: string;
  readonly title: string;
  readonly locale: string;
  readonly sections: readonly DocumentationSection[];
  /** Provenance the renderer stamps on the title page. */
  readonly generatedFor: {
    readonly candidateHash: string;
    readonly productSubject: string;
  };
}

// ---------------------------------------------------------------------------
// Rendered bundle (module output contract payload).
// ---------------------------------------------------------------------------

export interface DocumentationRenderedDocument {
  readonly kind: string;
  readonly documentRef: {
    readonly schemaId: string;
    readonly ref: string;
    readonly digest: string;
  };
  readonly pdfFileName: string;
  readonly pdfByteHash: string;
  readonly pdfByteSize: number;
  readonly renderer: { readonly id: string; readonly version: string };
}

export interface DocumentationBundle {
  readonly schemaVersion: typeof DOCUMENTATION_BUNDLE_SCHEMA;
  readonly candidateHash: string;
  readonly outputRoot: string;
  readonly renderedAt: string;
  readonly documents: readonly DocumentationRenderedDocument[];
  readonly bundleHash: string;
}

// ---------------------------------------------------------------------------
// Settlement certificate payload.
// ---------------------------------------------------------------------------

export interface DocumentationCertificate {
  readonly schemaVersion: typeof DOCUMENTATION_CERTIFICATE_SCHEMA;
  readonly decision: 'documented' | 'blocked' | 'failed';
  readonly reasonCodes: readonly string[];
  readonly rationale: string;
  readonly inputHash: string;
  readonly candidateHash: string;
  readonly bundleRef: string | null;
  readonly bundleHash: string | null;
  readonly documentKinds: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure validators (shared by payload contracts, gates and the renderer).
// ---------------------------------------------------------------------------

export function validateDocumentationDocument(
  value: unknown,
): { valid: true; document: DocumentationDocument } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ['document must be an object'] };
  if (value.schemaVersion !== DOCUMENTATION_DOCUMENT_SCHEMA) {
    errors.push(`schemaVersion must be '${DOCUMENTATION_DOCUMENT_SCHEMA}'`);
  }
  if (typeof value.documentKind !== 'string' || !isKnownDocumentationKind(value.documentKind)) {
    errors.push(`documentKind must be a registered kind, got '${String(value.documentKind)}'`);
  }
  if (typeof value.title !== 'string' || value.title.trim().length === 0) {
    errors.push('title must be a non-empty string');
  }
  if (typeof value.locale !== 'string' || value.locale.trim().length === 0) {
    errors.push('locale must be a non-empty string');
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    errors.push('sections must be a non-empty array');
  } else {
    const seen = new Set<string>();
    for (const section of value.sections) {
      if (!isRecord(section)) {
        errors.push('each section must be an object');
        continue;
      }
      if (typeof section.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(section.id)) {
        errors.push(`section id must be kebab-case, got '${String(section.id)}'`);
      } else if (seen.has(section.id)) {
        errors.push(`section id '${section.id}' is duplicated`);
      } else {
        seen.add(section.id);
      }
      if (typeof section.heading !== 'string' || section.heading.trim().length === 0) {
        errors.push(`section '${String(section.id)}' heading must be non-empty`);
      }
      if (!Array.isArray(section.blocks) || section.blocks.length === 0) {
        errors.push(`section '${String(section.id)}' must have at least one block`);
        continue;
      }
      for (const block of section.blocks) validateBlock(block, errors, String(section.id));
    }
  }
  if (!isRecord(value.generatedFor)
    || typeof value.generatedFor.candidateHash !== 'string'
    || value.generatedFor.candidateHash.trim().length === 0
    || typeof value.generatedFor.productSubject !== 'string'
    || value.generatedFor.productSubject.trim().length === 0) {
    errors.push('generatedFor.{candidateHash,productSubject} are required');
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, document: value as unknown as DocumentationDocument };
}

function validateBlock(block: unknown, errors: string[], sectionId: string): void {
  if (!isRecord(block)) {
    errors.push(`section '${sectionId}': block must be an object`);
    return;
  }
  switch (block.type) {
    case 'paragraph':
      if (typeof block.text !== 'string' || block.text.trim().length === 0) {
        errors.push(`section '${sectionId}': paragraph.text must be non-empty`);
      }
      return;
    case 'list':
      if (!Array.isArray(block.items) || block.items.length === 0
        || block.items.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        errors.push(`section '${sectionId}': list.items must be non-empty strings`);
      }
      return;
    case 'code':
      if (typeof block.text !== 'string' || block.text.trim().length === 0) {
        errors.push(`section '${sectionId}': code.text must be non-empty`);
      }
      return;
    case 'table': {
      const columns = block.columns;
      const rows = block.rows;
      if (!Array.isArray(columns) || columns.length === 0
        || !Array.isArray(rows)
        || rows.some(row => !Array.isArray(row) || row.length !== columns.length)) {
        errors.push(`section '${sectionId}': table columns/rows shape is invalid`);
      }
      return;
    }
    default:
      errors.push(`section '${sectionId}': unknown block type '${String(block.type)}'`);
  }
}

export function missingRequiredSections(
  document: DocumentationDocument,
): readonly string[] {
  const definition = DOCUMENTATION_KINDS[document.documentKind];
  if (!definition) return ['documentKind'];
  const present = new Set(document.sections.map(section => section.id));
  return definition.requiredSections.filter(sectionId => !present.has(sectionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
