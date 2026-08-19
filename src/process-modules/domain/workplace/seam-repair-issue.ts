import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';

/**
 * SEAM-ARCHITECT Layer 2 (b) — the typed repair-issue a seam check emits.
 *
 * A seam check (integration verification over the assembled whole) does NOT
 * collapse its outcome to boolean passed/failed. When a seam breaks it emits
 * a {@link SeamRepairIssue} naming:
 *
 *   - WHICH seam broke (the closed {@link SeamKind} set);
 *   - the PRODUCING task that owns the seam (resolved by path through the
 *     task graph change scopes; typed fallbacks `seam:integration` for
 *     cross-item / unowned seams and `cell:<id>` for cell-owned contracts
 *     when no accepted head is bound);
 *   - WHERE the failure localized (phase, substrate, command, file hints
 *     extracted from the failure output);
 *   - the EVIDENCE (summary + the content-addressed digest ref of the full
 *     observation).
 *
 * The issue is content-addressed exactly like a factory-check-diagnostic
 * (`factory-seam-repair-issue/v1/<sha256>/<base64url>`) so it can RIDE the
 * EXISTING evidence_refs arrays of check receipts — no new authority path.
 * Downstream decoders (recovery feedback, continuation defect evidence)
 * decode it at their point of decision (X3/X4 blindness class).
 */

const PREFIX = 'factory-seam-repair-issue/v1';

/**
 * The closed seam taxonomy. Ordered by verification phase.
 * Keep in sync with SEAM_KINDS (the runtime set) and the seam-repair-issue
 * tests (which assert the closed set verbatim).
 */
export type SeamKind =
  | 'readiness-profile-invalid'
  | 'install-command'
  | 'test-command'
  | 'serve-start'
  | 'serve-probe'
  | 'serve-shutdown'
  | 'compose-config'
  | 'compose-up'
  | 'compose-down'
  | 'substrate-unavailable';

/** The closed set — decoders reject any seamKind outside it (forward-safe). */
export const SEAM_KINDS: readonly SeamKind[] = [
  'readiness-profile-invalid',
  'install-command',
  'test-command',
  'serve-start',
  'serve-probe',
  'serve-shutdown',
  'compose-config',
  'compose-up',
  'compose-down',
  'substrate-unavailable',
];

const SEAM_KIND_SET: ReadonlySet<string> = new Set(SEAM_KINDS);

export const SEAM_REPAIR_ISSUE_PREFIX = PREFIX;

/** Where the failure localized. Every field typed; no free prose contracts. */
export interface SeamLocalization {
  /** The verification phase that failed (e.g. 'profile-test', 'compose-up'). */
  readonly phase: string;
  /** The execution substrate the seam was verified on. */
  readonly substrate: 'host' | 'docker';
  /** The profile-stated command that failed, when one did. */
  readonly command?: string;
  /** Repo-relative file paths extracted from the failure output (capped). */
  readonly fileHints: readonly string[];
}

/** The evidence a repair author needs: what broke, where to read the proof. */
export interface SeamEvidence {
  /** Human-readable summary (tail of the failing output). */
  readonly summary: string;
  /** The content-addressed evidence ref holding the full observation. */
  readonly digestRef: string;
}

export interface SeamRepairIssue {
  readonly seamKind: SeamKind;
  /**
   * The producing task that owns the seam: `task:<id>` when exactly one
   * implementation item's change scope covers the localized files,
   * `seam:integration` for cross-item / unresolvable seams, or
   * `cell:<production-cell-id>` for cell-owned contract defects.
   */
  readonly producingTaskRef: string;
  readonly localization: SeamLocalization;
  readonly evidence: SeamEvidence;
  /** The CandidateSet whose check produced this issue. */
  readonly subjectCandidateSetRef: string;
}

interface SeamRepairIssueSnapshot {
  seamKind: string;
  producingTaskRef: string;
  localization: {
    phase: string;
    substrate: string;
    command?: string;
    fileHints: unknown;
  };
  evidence: {
    summary: string;
    digestRef: string;
  };
  subjectCandidateSetRef: string;
}

export function encodeSeamRepairIssue(issue: SeamRepairIssue): string {
  const snapshot = canonicalJson(toSnapshot(issue));
  return `${PREFIX}/${sha256Hex(snapshot)}/${Buffer.from(snapshot, 'utf8').toString('base64url')}`;
}

export function decodeSeamRepairIssue(ref: string): SeamRepairIssue | null {
  const parts = ref.split('/');
  if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== PREFIX) return null;
  try {
    const snapshotText = Buffer.from(parts[3], 'base64url').toString('utf8');
    if (sha256Hex(snapshotText) !== parts[2]) return null;
    const value = JSON.parse(snapshotText) as Partial<SeamRepairIssueSnapshot>;
    if (
      typeof value.seamKind !== 'string' || !SEAM_KIND_SET.has(value.seamKind)
      || typeof value.producingTaskRef !== 'string'
      || value.producingTaskRef.trim() === ''
      || !isLocalization(value.localization)
      || !isEvidence(value.evidence)
      || typeof value.subjectCandidateSetRef !== 'string'
      || value.subjectCandidateSetRef.trim() === ''
    ) {
      return null;
    }
    return {
      seamKind: value.seamKind as SeamKind,
      producingTaskRef: value.producingTaskRef,
      localization: value.localization,
      evidence: value.evidence,
      subjectCandidateSetRef: value.subjectCandidateSetRef,
    };
  } catch {
    return null;
  }
}

function toSnapshot(issue: SeamRepairIssue): SeamRepairIssueSnapshot {
  return {
    seamKind: issue.seamKind,
    producingTaskRef: issue.producingTaskRef,
    localization: {
      phase: issue.localization.phase,
      substrate: issue.localization.substrate,
      ...(issue.localization.command !== undefined
        ? { command: issue.localization.command }
        : {}),
      fileHints: [...issue.localization.fileHints],
    },
    evidence: {
      summary: issue.evidence.summary,
      digestRef: issue.evidence.digestRef,
    },
    subjectCandidateSetRef: issue.subjectCandidateSetRef,
  };
}

function isLocalization(value: unknown): value is SeamLocalization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const localization = value as Partial<SeamLocalization>;
  return typeof localization.phase === 'string'
    && localization.phase.trim() !== ''
    && (localization.substrate === 'host' || localization.substrate === 'docker')
    && (localization.command === undefined
      || typeof localization.command === 'string')
    && Array.isArray(localization.fileHints)
    && localization.fileHints.every(hint =>
      typeof hint === 'string' && hint.trim() !== '');
}

function isEvidence(value: unknown): value is SeamEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Partial<SeamEvidence>;
  return typeof evidence.summary === 'string'
    && evidence.summary.trim() !== ''
    && typeof evidence.digestRef === 'string'
    && evidence.digestRef.trim() !== '';
}
