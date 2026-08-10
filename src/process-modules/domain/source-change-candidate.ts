/** Managed textual source material submitted by an LM without Git authority. */
export const SOURCE_CHANGE_CANDIDATE_SCHEMA =
  'factory.source-change-candidate.v1' as const;

export interface SourceChangeEntry {
  readonly path: string;
  readonly operation: 'create' | 'modify' | 'delete';
  readonly content?: string;
  readonly digest?: string;
  readonly mediaType?: string;
  readonly mode?: '100644';
}

export interface SourceChangeCandidateInput {
  readonly schemaVersion: typeof SOURCE_CHANGE_CANDIDATE_SCHEMA;
  readonly workItemKey: string;
  readonly baseCommit: string;
  readonly entries: readonly SourceChangeEntry[];
  readonly tests?: readonly unknown[];
  readonly reasonCodes?: readonly string[];
}
