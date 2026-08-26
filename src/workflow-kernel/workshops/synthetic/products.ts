/**
 * workflow-kernel/workshops/synthetic/products.ts - the products and the
 * PURE machine verification of the synthetic report-generator workshop
 * (WP-11V). The verification is deliberately data-level (digest
 * membership): the point of the synthetic workshop is the KERNEL
 * generalization proof, not a real build pipeline - yet the effect still
 * settles ONLY over verified ProductVerificationEvidence, exactly like
 * the real workshop.
 *
 * PURITY: pure functions over the fixture values. No I/O, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';

/* ------------------------------------------------------------------ */
/* The dataset snapshot fixture (the workshop's input material)        */
/* ------------------------------------------------------------------ */

/** One deterministic dataset snapshot the report renders. */
export interface DatasetSnapshot {
  readonly datasetId: string;
  readonly rows: readonly { readonly label: string; readonly value: number }[];
}

export const SYNTHETIC_DATASET: DatasetSnapshot = {
  datasetId: 'dataset:factory-throughput-2026-08',
  rows: [
    { label: 'capsules-ingested', value: 12 },
    { label: 'cells-materialized', value: 12 },
    { label: 'gates-accepted', value: 24 },
    { label: 'effects-settled', value: 12 },
  ],
};

export const SYNTHETIC_SECTION_REFS: readonly string[] = [
  'content://report-sections/summary',
  'content://report-sections/throughput-table',
  'content://report-sections/outlier-notes',
];

export function datasetDigest(snapshot: DatasetSnapshot = SYNTHETIC_DATASET): string {
  return sha256OfCanonical(snapshot);
}

/* ------------------------------------------------------------------ */
/* The report products                                                 */
/* ------------------------------------------------------------------ */

/** The author's rendered report draft (input of review). */
export interface ReportDraft {
  readonly schemaId: 'workshop.synthetic-reporting.report-draft.v1';
  readonly capsuleRef: string;
  readonly datasetDigest: string;
  readonly reportDigest: string;
  readonly sectionRefs: readonly string[];
}

export function buildReportDraft(capsuleRef: string, snapshot: DatasetSnapshot = SYNTHETIC_DATASET): ReportDraft {
  const rendered = renderReportMarkdown(snapshot);
  return {
    schemaId: 'workshop.synthetic-reporting.report-draft.v1',
    capsuleRef,
    datasetDigest: datasetDigest(snapshot),
    reportDigest: sha256OfCanonical(rendered),
    sectionRefs: [...SYNTHETIC_SECTION_REFS],
  };
}

/** Deterministic markdown rendering of the dataset (the report body). */
export function renderReportMarkdown(snapshot: DatasetSnapshot = SYNTHETIC_DATASET): string {
  const header = `# Throughput report (${snapshot.datasetId})`;
  const table = ['| metric | value |', '| --- | --- |', ...snapshot.rows.map((row) => `| ${row.label} | ${row.value} |`)].join('\n');
  const notes = snapshot.rows
    .filter((row) => row.value > 20)
    .map((row) => `- outlier: ${row.label}=${row.value}`)
    .join('\n');
  return [header, '', table, '', '## Outliers', '', notes].join('\n');
}

/* ------------------------------------------------------------------ */
/* The pure machine verification (the effect's evidence gate)          */
/* ------------------------------------------------------------------ */

export type ReportVerification =
  | { readonly ok: true; readonly detail: string; readonly digest: string; readonly verified: readonly string[] }
  | { readonly ok: false; readonly detail: string; readonly digest: string };

/**
 * The machine observation of the report product: the draft must cite the
 * exact dataset digest and carry every declared section ref. Everything
 * else (publication readiness) stays operator-only by declaration.
 */
export function verifyReportProduct(draft: ReportDraft, expected: { readonly datasetDigest: string; readonly sectionRefs: readonly string[] }): ReportVerification {
  if (draft.datasetDigest !== expected.datasetDigest) {
    return { ok: false, detail: `the draft cites dataset digest ${draft.datasetDigest} but the snapshot is ${expected.datasetDigest} (stale dataset)`, digest: draft.datasetDigest };
  }
  const missing = expected.sectionRefs.filter((ref) => !draft.sectionRefs.includes(ref));
  if (missing.length > 0) {
    return { ok: false, detail: `the draft is missing section refs: ${missing.join(', ')}`, digest: draft.reportDigest };
  }
  if (draft.reportDigest.length !== 64) {
    return { ok: false, detail: 'the draft report digest is malformed', digest: draft.reportDigest };
  }
  return {
    ok: true,
    detail: `verified: dataset-digest + ${expected.sectionRefs.length} section refs`,
    digest: draft.reportDigest,
    verified: ['dataset-digest-match', 'section-coverage'],
  };
}

/** The terminal published-report product (the workshop output). */
export interface PublishedReport {
  readonly schemaId: 'workshop.synthetic-reporting.published-report.v1';
  readonly capsuleRef: string;
  readonly acceptanceDigest: string;
  readonly terminalProofs: readonly string[];
  readonly runTerminalOutcome: 'success';
}

export function buildPublishedReport(input: {
  readonly capsuleRef: string;
  readonly acceptanceDigest: string;
  readonly terminalProofs: readonly string[];
  readonly runTerminalOutcome: string;
}): { readonly mapped: true; readonly value: PublishedReport; readonly digest: string } | { readonly mapped: false; readonly detail: string } {
  if (input.runTerminalOutcome !== 'success' || input.terminalProofs.length === 0) {
    return { mapped: false, detail: `a published report requires the run success proof and non-empty terminal proofs (got ${String(input.runTerminalOutcome)})` };
  }
  const value: PublishedReport = {
    schemaId: 'workshop.synthetic-reporting.published-report.v1',
    capsuleRef: input.capsuleRef,
    acceptanceDigest: input.acceptanceDigest,
    terminalProofs: [...input.terminalProofs],
    runTerminalOutcome: 'success',
  };
  return { mapped: true, value, digest: sha256OfCanonical(value) };
}
