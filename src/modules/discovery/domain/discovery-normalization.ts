import {
  validateDiscoveryProposal,
  type DiscoveryOutcome,
  type DiscoveryProposalPayload,
} from './discovery-proposal.js';

export const DISCOVERY_PROPOSAL_FIELDS = [
  'problem_statement',
  'observed_context',
  'stakeholders_or_actors',
  'assumptions',
  'unknowns',
  'risks',
  'candidate_scope',
  'evidence_refs',
  'recommended_outcome',
  'rationale',
] as const;

export type DiscoveryProposalField = typeof DISCOVERY_PROPOSAL_FIELDS[number];

export type DiscoveryNormalizationDisposition =
  | 'accepted'
  | 'needs_lm'
  | 'rejected_syntax';

export type DiscoveryNormalizationTraceStep =
  | 'direct_object'
  | 'strict_json'
  | 'markdown_fence_removed'
  | 'supported_aliases_applied';

export interface DeterministicDiscoveryNormalization {
  disposition: DiscoveryNormalizationDisposition;
  /** Exact worker-supplied string, or JSON serialization of the submitted object. */
  raw_text: string;
  /** Parsed payload before aliases. Null when strict JSON parsing failed. */
  parsed_payload: unknown | null;
  /** Canonical typed payload only when deterministic normalization completed. */
  normalized_payload: DiscoveryProposalPayload | null;
  trace: DiscoveryNormalizationTraceStep[];
  validation_errors: string[];
  alias_conflicts: string[];
  /** Evidence literals present in the original parsed response. LM may not add others. */
  allowed_evidence_refs: string[];
  reason_code: 'valid' | 'semantic_ambiguity' | 'invalid_json';
}

const FIELD_ALIASES: Readonly<Record<DiscoveryProposalField, readonly string[]>> = {
  problem_statement: ['problem', 'problemStatement'],
  observed_context: ['context', 'observedContext'],
  stakeholders_or_actors: ['stakeholders', 'actors', 'stakeholdersOrActors'],
  assumptions: ['assumption'],
  unknowns: ['open_questions', 'questions', 'unknown'],
  risks: ['risk'],
  candidate_scope: ['scope', 'candidateScope'],
  evidence_refs: ['evidence', 'evidenceReferences', 'evidenceRefs'],
  recommended_outcome: ['outcome', 'recommendation', 'recommendedOutcome'],
  rationale: ['reason', 'reasoning'],
};

const OUTCOME_ALIASES: Readonly<Record<string, DiscoveryOutcome>> = {
  ready: 'go',
  proceed: 'go',
  needs_clarification: 'clarify',
  clarification_required: 'clarify',
  unsupported: 'reject',
  not_supported: 'reject',
  postpone: 'defer',
  deferred: 'defer',
  uncertain: 'inconclusive',
  unknown: 'inconclusive',
  error: 'failed',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function equalValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function fullMarkdownFence(text: string): string | null {
  const match = text.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i);
  return match ? match[1] : null;
}

function parseWorkerInput(input: unknown): {
  rawText: string;
  parsed: unknown | null;
  trace: DiscoveryNormalizationTraceStep[];
} {
  if (isRecord(input)) {
    return { rawText: JSON.stringify(input), parsed: input, trace: ['direct_object'] };
  }
  if (typeof input !== 'string') {
    return { rawText: JSON.stringify(input), parsed: null, trace: [] };
  }

  try {
    return { rawText: input, parsed: JSON.parse(input), trace: ['strict_json'] };
  } catch {
    const inner = fullMarkdownFence(input);
    if (inner === null) return { rawText: input, parsed: null, trace: [] };
    try {
      return {
        rawText: input,
        parsed: JSON.parse(inner),
        trace: ['markdown_fence_removed', 'strict_json'],
      };
    } catch {
      return { rawText: input, parsed: null, trace: ['markdown_fence_removed'] };
    }
  }
}

function applySupportedAliases(input: Record<string, unknown>): {
  value: Record<string, unknown>;
  changed: boolean;
  conflicts: string[];
} {
  const output: Record<string, unknown> = { ...input };
  const conflicts: string[] = [];
  let changed = false;

  for (const canonical of DISCOVERY_PROPOSAL_FIELDS) {
    const aliases = FIELD_ALIASES[canonical];
    const present = aliases.filter(alias => Object.prototype.hasOwnProperty.call(output, alias));
    const canonicalPresent = Object.prototype.hasOwnProperty.call(output, canonical);
    const candidates = present.map(alias => ({ alias, value: output[alias] }));

    if (canonicalPresent) {
      for (const candidate of candidates) {
        if (!equalValue(output[canonical], candidate.value)) {
          conflicts.push(`${canonical}<->${candidate.alias}`);
        } else {
          delete output[candidate.alias];
          changed = true;
        }
      }
      continue;
    }

    if (candidates.length === 0) continue;
    const first = candidates[0];
    if (candidates.some(candidate => !equalValue(candidate.value, first.value))) {
      conflicts.push(`${canonical}<->${candidates.map(candidate => candidate.alias).join('|')}`);
      continue;
    }
    output[canonical] = first.value;
    for (const candidate of candidates) delete output[candidate.alias];
    changed = true;
  }

  const outcome = output.recommended_outcome;
  if (typeof outcome === 'string') {
    const mapped = OUTCOME_ALIASES[outcome.trim().toLowerCase()];
    if (mapped) {
      output.recommended_outcome = mapped;
      changed = true;
    }
  }

  return { value: output, changed, conflicts };
}

export function collectOriginalEvidenceRefs(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const values: string[] = [];
  for (const key of ['evidence_refs', ...FIELD_ALIASES.evidence_refs]) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') values.push(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') values.push(item);
      }
    }
  }
  return [...new Set(values)];
}

export function normalizeDiscoveryProposalInput(input: unknown): DeterministicDiscoveryNormalization {
  const parsed = parseWorkerInput(input);
  if (!isRecord(parsed.parsed)) {
    return {
      disposition: 'rejected_syntax',
      raw_text: parsed.rawText,
      parsed_payload: parsed.parsed,
      normalized_payload: null,
      trace: parsed.trace,
      validation_errors: ['worker response is not a strict JSON object'],
      alias_conflicts: [],
      allowed_evidence_refs: [],
      reason_code: 'invalid_json',
    };
  }

  const aliases = applySupportedAliases(parsed.parsed);
  const trace = aliases.changed
    ? [...parsed.trace, 'supported_aliases_applied' as const]
    : parsed.trace;
  const validation = validateDiscoveryProposal(aliases.value);
  const allowedEvidence = collectOriginalEvidenceRefs(parsed.parsed);

  if (validation.valid && aliases.conflicts.length === 0) {
    return {
      disposition: 'accepted',
      raw_text: parsed.rawText,
      parsed_payload: parsed.parsed,
      normalized_payload: aliases.value as unknown as DiscoveryProposalPayload,
      trace,
      validation_errors: [],
      alias_conflicts: [],
      allowed_evidence_refs: allowedEvidence,
      reason_code: 'valid',
    };
  }

  return {
    disposition: 'needs_lm',
    raw_text: parsed.rawText,
    parsed_payload: parsed.parsed,
    normalized_payload: null,
    trace,
    validation_errors: validation.errors,
    alias_conflicts: aliases.conflicts,
    allowed_evidence_refs: allowedEvidence,
    reason_code: 'semantic_ambiguity',
  };
}

/** Only top-level JSON paths are accepted in D2. */
export function readTopLevelSourcePath(parsed: unknown, path: string): unknown {
  if (!isRecord(parsed) || !/^\$\.[A-Za-z_][A-Za-z0-9_]*$/.test(path)) return undefined;
  return parsed[path.slice(2)];
}
