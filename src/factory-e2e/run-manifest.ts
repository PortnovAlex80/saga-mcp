// src/factory-e2e/run-manifest.ts
//
// W9 finish-line RUN MANIFEST — a typed, parse-validated declaration of the
// scripted E2E scenarios that W9-02 (happy path) and W9-03 (adversarial) drive
// against the fresh scripted completion harness (fresh-harness.ts).
//
// ADR-053 alignment. The manifest is a DECLARATION only — it describes WHAT the
// finish line must prove (fresh state, scripted inference, concurrency ≤ 2, no
// authority hacks, deterministic crash points). It does not encode authority
// bindings or lifecycle transitions; those EMERGE from production APIs when the
// harness drives a run. Downstream cards (W9-02/W9-03) read a parsed manifest
// and execute each declared scenario through the harness.
//
// Design rules enforced by parseRunManifest:
//   - Every scenario starts from FRESH state (freshState === true). No carry-over.
//   - Every scenario caps concurrency at ≤ 2 (scripted inference, not a swarm).
//   - Inference is ALWAYS scripted (mode === 'scripted') — never a real model.
//   - Crash points are NAMED and DETERMINISTIC (trigger + invocation index) —
//     random fault injection is structurally rejected.
//   - Each scenario declares the authority invariants it must preserve, drawn
//     from ADR-053 §"Какие тесты нужны вместо текущей цепочки регрессий".

export const RUN_MANIFEST_VERSION = 'factory-e2e.run-manifest.v1' as const;
export type RunManifestVersion = typeof RUN_MANIFEST_VERSION;

/** The W9 finish-line lane a scenario belongs to. */
export type E2ELane = 'W9-02' | 'W9-03';

/** The only inference mode the finish-line harness permits. */
export type InferenceMode = 'scripted';

/**
 * The hard ceiling on concurrent scripted inferences. The W9 plan mandates
 * "concurrency ≤ 2 (scripted inference, not a swarm)". The manifest rejects any
 * baseline or scenario cap above this.
 */
export const HARNESS_CONCURRENCY_CEILING = 2;

/**
 * The accepted-material authority model the harness is allowed to exercise.
 * The harness must let Workplace production revisions emerge as the sole
 * accepted-material authority (ADR-053); it may NOT inject execution/task/
 * latest/submission authority.
 */
export type AuthorityModel = 'workplace-production-revision';

/** Describes which scripted-scenario fixture set drives inference for a scenario. */
export interface ScriptedInferenceProfile {
  /** Always 'scripted' — the finish line forbids real-model inference. */
  readonly mode: InferenceMode;
  /**
   * Stable semantic key identifying the scenario fixture set (e.g.
   * 'w9-happy-full-lifecycle'). W9-02/W9-03 resolve this to a concrete
   * in-process scripted handler map. Cross-run stable, like scenarioKey().
   */
  readonly scenarioKey: string;
  readonly description: string;
}

/**
 * A named, DETERMINISTIC fault point. Random fault injection is forbidden by
 * the W9 plan ("no random fault injection — use named deterministic crash
 * points"). Each point fires at a precise, reproducible moment so W9-03 can
 * prove recovery preserves accepted-material identity.
 */
export interface DeterministicCrashPoint {
  /** Stable name, e.g. 'author-exit-before-worker-done'. */
  readonly name: string;
  /**
   * 'invocation-count' fires on the Nth scripted invocation of a given
   * scenario key (exact, reproducible). 'named-marker' fires when production
   * reaches a named lifecycle marker (W9-03 resolves the marker).
   */
  readonly trigger: 'invocation-count' | 'named-marker';
  /** For 'invocation-count': the 1-based invocation index that crashes. */
  readonly atInvocation: number | null;
  /**
   * 'exit-without-done': process exits cleanly but never calls worker_done
   * (lost execution → crash repair). 'exit-nonzero': process fails.
   */
  readonly effect: 'exit-without-done' | 'exit-nonzero';
  readonly description: string;
}

/**
 * An accepted-material authority invariant a scenario must preserve. The ids
 * mirror the generative invariant families in ADR-053 §"Какие тесты нужны":
 * authority conservation, contribution partition invariance, cardinality
 * conservation, representation normalization.
 */
export interface AuthorityInvariant {
  readonly id:
    | 'authority-conservation'
    | 'contribution-partition-invariance'
    | 'cardinality-conservation'
    | 'representation-normalization'
    | 'no-authority-hacks'
    | 'no-stranded-executions';
  readonly description: string;
}

/** One declared W9 scenario executed through the fresh harness. */
export interface RunScenario {
  readonly scenarioId: string;
  readonly lane: E2ELane;
  readonly description: string;
  /** Must be true — every W9 run starts from a clean per-run DB/workspace. */
  readonly freshState: boolean;
  /** Per-scenario cap; must be ≤ HARNESS_CONCURRENCY_CEILING. */
  readonly concurrencyCap: number;
  readonly scriptedInference: ScriptedInferenceProfile;
  readonly deterministicCrashPoints: readonly DeterministicCrashPoint[];
  readonly expectedAuthorityInvariants: readonly AuthorityInvariant[];
}

/** Harness-wide baseline pinned for every scenario in the manifest. */
export interface RunManifestBaseline {
  /** The integration SHA the harness branch was cut from. */
  readonly startingSha: string;
  /** The harness-wide concurrency cap (≤ HARNESS_CONCURRENCY_CEILING). */
  readonly concurrencyCap: number;
  readonly inferenceMode: InferenceMode;
  readonly authorityModel: AuthorityModel;
}

/** A parsed, validated W9 run manifest. */
export interface RunManifest {
  readonly manifestVersion: RunManifestVersion;
  readonly createdAt: string;
  readonly baseline: RunManifestBaseline;
  readonly scenarios: readonly RunScenario[];
}

// ---------------------------------------------------------------------------
// Validation + parsing.
// ---------------------------------------------------------------------------

class ManifestError extends Error {
  constructor(message: string) {
    super(`RUN_MANIFEST_INVALID: ${message}`);
    this.name = 'ManifestError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManifestError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ManifestError(`${label} must be a boolean`);
  }
  return value;
}

function requireConcurrencyCap(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > HARNESS_CONCURRENCY_CEILING) {
    throw new ManifestError(
      `${label} must be an integer in 1..${HARNESS_CONCURRENCY_CEILING}, got ${String(value)}`,
    );
  }
  return value as number;
}

function parseScriptedInference(raw: unknown): ScriptedInferenceProfile {
  if (!isObject(raw)) throw new ManifestError('scriptedInference must be an object');
  if (raw.mode !== 'scripted') {
    throw new ManifestError(`scriptedInference.mode must be 'scripted', got '${String(raw.mode)}'`);
  }
  return {
    mode: 'scripted',
    scenarioKey: requireString(raw.scenarioKey, 'scriptedInference.scenarioKey'),
    description: requireString(raw.description, 'scriptedInference.description'),
  };
}

function parseDeterministicCrashPoint(raw: unknown): DeterministicCrashPoint {
  if (!isObject(raw)) throw new ManifestError('deterministicCrashPoint must be an object');
  const trigger = raw.trigger;
  if (trigger !== 'invocation-count' && trigger !== 'named-marker') {
    throw new ManifestError(
      `deterministicCrashPoint.trigger must be 'invocation-count' or 'named-marker', got '${String(trigger)}'`,
    );
  }
  const effect = raw.effect;
  if (effect !== 'exit-without-done' && effect !== 'exit-nonzero') {
    throw new ManifestError(
      `deterministicCrashPoint.effect must be 'exit-without-done' or 'exit-nonzero', got '${String(effect)}'`,
    );
  }
  let atInvocation: number | null = null;
  if (trigger === 'invocation-count') {
    if (!Number.isInteger(raw.atInvocation) || (raw.atInvocation as number) < 1) {
      throw new ManifestError(
        `deterministicCrashPoint.atInvocation must be a positive integer when trigger='invocation-count'`,
      );
    }
    atInvocation = raw.atInvocation as number;
  } else if (raw.atInvocation !== undefined && raw.atInvocation !== null) {
    throw new ManifestError(
      `deterministicCrashPoint.atInvocation must be omitted when trigger='named-marker'`,
    );
  }
  return {
    name: requireString(raw.name, 'deterministicCrashPoint.name'),
    trigger,
    atInvocation,
    effect,
    description: requireString(raw.description, 'deterministicCrashPoint.description'),
  };
}

const INVARIANT_IDS = new Set<AuthorityInvariant['id']>([
  'authority-conservation',
  'contribution-partition-invariance',
  'cardinality-conservation',
  'representation-normalization',
  'no-authority-hacks',
  'no-stranded-executions',
]);

function parseInvariant(raw: unknown): AuthorityInvariant {
  if (!isObject(raw)) throw new ManifestError('authorityInvariant must be an object');
  const id = requireString(raw.id, 'authorityInvariant.id') as AuthorityInvariant['id'];
  if (!INVARIANT_IDS.has(id)) {
    throw new ManifestError(`authorityInvariant.id '${id}' is not a known invariant family`);
  }
  return {
    id,
    description: requireString(raw.description, 'authorityInvariant.description'),
  };
}

function parseScenario(raw: unknown): RunScenario {
  if (!isObject(raw)) throw new ManifestError('scenario must be an object');
  const freshState = requireBoolean(raw.freshState, 'scenario.freshState');
  if (!freshState) {
    throw new ManifestError(
      `scenario '${String(raw.scenarioId)}' must start from fresh state (freshState=true) — the W9 finish line forbids carry-over`,
    );
  }
  const crashPointsRaw = Array.isArray(raw.deterministicCrashPoints) ? raw.deterministicCrashPoints : [];
  const invariantsRaw = Array.isArray(raw.expectedAuthorityInvariants)
    ? raw.expectedAuthorityInvariants
    : [];
  if (invariantsRaw.length === 0) {
    throw new ManifestError(
      `scenario '${String(raw.scenarioId)}' must declare at least one expectedAuthorityInvariant`,
    );
  }
  const seenCrashNames = new Set<string>();
  for (const cp of crashPointsRaw) {
    const parsed = parseDeterministicCrashPoint(cp);
    if (seenCrashNames.has(parsed.name)) {
      throw new ManifestError(`deterministicCrashPoint.name '${parsed.name}' is duplicated in scenario '${String(raw.scenarioId)}'`);
    }
    seenCrashNames.add(parsed.name);
  }
  return Object.freeze({
    scenarioId: requireString(raw.scenarioId, 'scenario.scenarioId'),
    lane: raw.lane === 'W9-02' || raw.lane === 'W9-03' ? raw.lane : (() => { throw new ManifestError(`scenario.lane must be 'W9-02' or 'W9-03', got '${String(raw.lane)}'`); })(),
    description: requireString(raw.description, 'scenario.description'),
    freshState,
    concurrencyCap: requireConcurrencyCap(raw.concurrencyCap, 'scenario.concurrencyCap'),
    scriptedInference: parseScriptedInference(raw.scriptedInference),
    deterministicCrashPoints: Object.freeze(crashPointsRaw.map(parseDeterministicCrashPoint)),
    expectedAuthorityInvariants: Object.freeze(invariantsRaw.map(parseInvariant)),
  });
}

function parseBaseline(raw: unknown): RunManifestBaseline {
  if (!isObject(raw)) throw new ManifestError('baseline must be an object');
  if (raw.inferenceMode !== 'scripted') {
    throw new ManifestError(`baseline.inferenceMode must be 'scripted', got '${String(raw.inferenceMode)}'`);
  }
  if (raw.authorityModel !== 'workplace-production-revision') {
    throw new ManifestError(
      `baseline.authorityModel must be 'workplace-production-revision', got '${String(raw.authorityModel)}' — the harness may not exercise execution/task/latest authority`,
    );
  }
  return Object.freeze({
    startingSha: requireString(raw.startingSha, 'baseline.startingSha'),
    concurrencyCap: requireConcurrencyCap(raw.concurrencyCap, 'baseline.concurrencyCap'),
    inferenceMode: 'scripted',
    authorityModel: 'workplace-production-revision',
  });
}

/**
 * Validate and freeze a run manifest. Throws on any violation of the W9
 * finish-line rules (fresh state, scripted inference, concurrency ≤ 2,
 * deterministic crash points, declared invariants, workplace-authority model).
 */
export function parseRunManifest(raw: unknown): RunManifest {
  if (!isObject(raw)) throw new ManifestError('manifest must be an object');
  if (raw.manifestVersion !== RUN_MANIFEST_VERSION) {
    throw new ManifestError(
      `manifestVersion must be '${RUN_MANIFEST_VERSION}', got '${String(raw.manifestVersion)}'`,
    );
  }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new ManifestError('scenarios must be a non-empty array');
  }
  const seenIds = new Set<string>();
  for (const scenarioRaw of raw.scenarios) {
    const id = isObject(scenarioRaw) ? String(scenarioRaw.scenarioId) : '';
    if (id && seenIds.has(id)) {
      throw new ManifestError(`scenarioId '${id}' is duplicated`);
    }
    seenIds.add(id);
  }
  const scenarios = Object.freeze((raw.scenarios as unknown[]).map(parseScenario));
  const lanes = new Set(scenarios.map(s => s.lane));
  if (!lanes.has('W9-02')) {
    throw new ManifestError('manifest must declare at least one W9-02 (happy path) scenario');
  }
  if (!lanes.has('W9-03')) {
    throw new ManifestError('manifest must declare at least one W9-03 (adversarial) scenario');
  }
  return Object.freeze({
    manifestVersion: RUN_MANIFEST_VERSION,
    createdAt: requireString(raw.createdAt, 'createdAt'),
    baseline: parseBaseline(raw.baseline),
    scenarios,
  });
}

// ---------------------------------------------------------------------------
// Default W9 manifest — the scenarios W9-02 (happy) and W9-03 (adversarial)
// will drive through the fresh harness. This is the canonical declaration;
// cards W9-02/W9-03 consume it via parseRunManifest(defaultW9RunManifest(...)).
// ---------------------------------------------------------------------------

/**
 * The authority invariants every W9 scenario must preserve. Drawn from ADR-053
 * §"Какие тесты нужны вместо текущей цепочки регрессий" plus the two structural
 * finish-line guarantees (no authority hacks, no stranded executions).
 */
export const W9_AUTHORITY_INVARIANTS: readonly AuthorityInvariant[] = Object.freeze([
  {
    id: 'no-authority-hacks',
    description:
      'The harness makes zero manual writes to authority tables (factory_workplaces, '
      + 'factory_candidate_sets, factory_gate_decisions, factory_accepted_authority_heads). '
      + 'No recency/latest fallback, no submission.task_id binding. All authority emerges '
      + 'from production APIs.',
  },
  {
    id: 'authority-conservation',
    description:
      'Gate.subject == CandidateSet == Effect.input == FinalAcceptance.candidate == '
      + 'Downstream product, even when a newer execution/task/submission appears.',
  },
  {
    id: 'contribution-partition-invariance',
    description:
      'The same final Workplace material produces the same semantic revision whether '
      + 'produced by one execution, two after network loss, or three repair attempts.',
  },
  {
    id: 'cardinality-conservation',
    description:
      'Frozen atomic members == SRS D2 members == Solution Contract criteria == '
      + 'DevelopmentCase criteria, across one-to-many document representations.',
  },
  {
    id: 'no-stranded-executions',
    description:
      'At run termination, zero worker_executions remain in reserved/running/cancel_requested.',
  },
]);

/**
 * Build the canonical W9 run manifest for a given integration baseline.
 *
 * Scenarios:
 *   - w9-02-happy-full-lifecycle (W9-02): one fresh workplace cohort traverses
 *     Discovery → Formalization → Development → Delivery-release under scripted
 *     happy inference, concurrency 2, zero crash points.
 *   - w9-03-cross-execution-durability (W9-03): an author worker is lost
 *     mid-production after sealing its first contribution; a second execution
 *     continues on the SAME workplace. The accepted revision must carry both
 *     contributions (partition invariance).
 *   - w9-03-reviewer-reject-repair (W9-03): the final gate rejects the first
 *     reviewer assessment and accepts a repaired author CandidateSet — proving
 *     exact subject_candidate_set_ref authority across a repair cycle.
 *   - w9-03-carry-forward-authority (W9-03): accepted material is carried
 *     forward into integration; the integration task is selected from the
 *     accepted-authority head (readAuthorTaskId), never from submission.task_id
 *     or recency.
 */
export function defaultW9RunManifest(baseline: {
  startingSha: string;
  createdAt?: string;
  concurrencyCap?: number;
}): RunManifest {
  const concurrencyCap = baseline.concurrencyCap ?? HARNESS_CONCURRENCY_CEILING;
  const createdAt = baseline.createdAt ?? new Date('2026-08-12T00:00:00.000Z').toISOString();
  const happyInvariants = W9_AUTHORITY_INVARIANTS;
  const adversarialInvariants = W9_AUTHORITY_INVARIANTS;

  return parseRunManifest({
    manifestVersion: RUN_MANIFEST_VERSION,
    createdAt,
    baseline: {
      startingSha: baseline.startingSha,
      concurrencyCap,
      inferenceMode: 'scripted',
      authorityModel: 'workplace-production-revision',
    },
    scenarios: [
      {
        scenarioId: 'w9-02-happy-full-lifecycle',
        lane: 'W9-02',
        description:
          'Fresh DB + fresh repository. Scripted happy-path inference drives one cohort '
          + 'through Discovery, Formalization, Development and Delivery-release. Concurrency '
          + 'capped at 2. Asserts the production runtime preserves accepted-material identity '
          + 'end-to-end with zero crash points.',
        freshState: true,
        concurrencyCap,
        scriptedInference: {
          mode: 'scripted',
          scenarioKey: 'w9-happy-full-lifecycle',
          description:
            'Deterministic happy-path scripted handlers for every (module, cell, role) on the '
            + 'main spine. Produces canonical products; reviewer always accepts on valid lineage.',
        },
        deterministicCrashPoints: [],
        expectedAuthorityInvariants: happyInvariants,
      },
      {
        scenarioId: 'w9-03-cross-execution-durability',
        lane: 'W9-03',
        description:
          'Fresh state. The first author execution is lost (exit-without-done) immediately '
          + 'after its first managed contribution is sealed. Crash repair reassigns the SAME '
          + 'workplace to a second execution, which completes the material. The accepted '
          + 'revision must contain BOTH contributions — proving partition invariance across '
          + 'physical worker loss (the Run 011 class of defect).',
        freshState: true,
        concurrencyCap,
        scriptedInference: {
          mode: 'scripted',
          scenarioKey: 'w9-adversarial-cross-execution',
          description:
            'Scripted author handler that seals a partial contribution then exits without '
            + 'worker_done at a deterministic invocation; a follow-up handler completes the desk.',
        },
        deterministicCrashPoints: [
          {
            name: 'author-lost-after-first-contribution',
            trigger: 'invocation-count',
            atInvocation: 1,
            effect: 'exit-without-done',
            description:
              'The first author invocation on the target workplace exits cleanly without '
              + 'worker_done after sealing one contribution. The production finalizer must '
              + 'classify it as a lost execution and enter crash repair.',
          },
        ],
        expectedAuthorityInvariants: adversarialInvariants,
      },
      {
        scenarioId: 'w9-03-reviewer-reject-repair',
        lane: 'W9-03',
        description:
          'Fresh state. A reviewer CandidateSet is produced against the first author '
          + 'CandidateSet; the final gate returns repair_required (reject). The author '
          + 'produces a SECOND immutable CandidateSet; a second reviewer CandidateSet '
          + 'references it; the gate accepts. Asserts exact subject_candidate_set_ref and '
          + 'assessment_candidate_set_refs authority across the repair cycle.',
        freshState: true,
        concurrencyCap,
        scriptedInference: {
          mode: 'scripted',
          scenarioKey: 'w9-adversarial-reviewer-reject',
          description:
            'Scripted reviewer handler that emits a structured repair verdict on the first '
            + 'assessment, then accepts on the repaired author CandidateSet.',
        },
        deterministicCrashPoints: [],
        expectedAuthorityInvariants: adversarialInvariants,
      },
      {
        scenarioId: 'w9-03-carry-forward-authority',
        lane: 'W9-03',
        description:
          'Fresh state. Accepted author material is carried forward into a downstream '
          + 'integration node. The integration task is selected from the accepted-authority '
          + 'head (readAuthorTaskId) — NOT from submission.task_id and NOT from recency '
          + '(ORDER BY id DESC). Asserts the C5 carry-forward-safe task binding survives.',
        freshState: true,
        concurrencyCap,
        scriptedInference: {
          mode: 'scripted',
          scenarioKey: 'w9-adversarial-carry-forward',
          description:
            'Scripted handlers that produce carry-forward candidates whose submission still '
            + 'names the origin task, then assert integration binds to the workplace task.',
        },
        deterministicCrashPoints: [],
        expectedAuthorityInvariants: adversarialInvariants,
      },
    ],
  });
}
